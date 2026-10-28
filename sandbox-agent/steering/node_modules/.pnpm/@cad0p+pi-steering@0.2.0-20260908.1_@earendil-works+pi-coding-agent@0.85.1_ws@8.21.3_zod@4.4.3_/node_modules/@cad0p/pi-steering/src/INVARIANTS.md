# Internal invariants — `S`, `E`, and `O` tags

Short reference for the load-bearing invariants flagged across the
engine source. These are NOT a public API contract — they are
maintainer shorthand to keep related call sites traceable across
files. Source comments cite the tag and rely on this file for the
definition.

This file ships with the package as a maintainer-facing glossary;
it is not part of the public API surface (no exports), but is
included in the npm tarball for source-readers consulting tagged
call sites on disk.

## Safety invariants (`S`)

The engine evaluates user-authored steering rules against
LLM-proposed tool calls. The `S` invariants are the layered defenses
that keep a buggy or malformed plugin / rule from silently
failing OPEN the gate.

### `S1` — fail-closed isolation

**Where:** `evaluator.ts` (`evaluateEvent` top-level wrap; per-rule
try/catch; `evaluateExemptionClause` per-exemption try/catch),
`evaluator-internals/predicates.ts` (per-predicate
try/catch in `runPredicateChain`; `onUnknownDefault` projection
parameter in `evaluateWhen` / `evaluateNotBlock` /
`readLeafOnUnknown`; the `ignoreExplicitModifiers` strict flag;
`validateExemptionWhenClauseShape`).

A `when`-path predicate that throws — built-in or plugin-supplied,
 sync or async — is treated as "rule does not fire", logged via
 `console.warn` with the rule name + `@<source>` tag + key, and
 evaluation continues with the next rule. `requires:`/`unless:`
 predicate fns project directionally instead (unknown → strict,
 warn logged in both cases, chain continues): a throwing `requires`
 fn counts as satisfied, a throwing `unless` fn counts as absent
 (issue #118). `MissingDescriptorError` is rethrown with rule context
 from every path — absent descriptors fail CLOSED (loud block), never
 warn+skip. The top-level wrap in `evaluator.ts` is the outermost
catch: if the engine's own scaffolding throws (parse errors, walker
bugs, corrupted session JSONL), the tool is BLOCKED with an
engine-tagged reason so the agent sees the throw came from the
engine, not from a rule. (Both block paths — rule-fired and engine-
error — carry a fixed not-executed preamble before the tag; see
`BLOCK_REASON_PREAMBLE` / `ENGINE_ERROR_PREAMBLE` in
`src/helpers/block-reason-preamble.ts`.)

The same pattern applies to observers in `observer-dispatcher.ts` —
a throwing observer is isolated to its own dispatch and never
escalates.

**Exemption evaluation (registry carve-outs) is fail-closed in the
OPPOSITE projection** — a throwing exemption predicate or an unknown
leaf counts as "does not match" → the target guard still fires:

- `evaluateExemptionClause` runs `evaluateWhen` with
  `onUnknownDefault: "allow"` (unknown → false → no exemption)
  across all four projection sites: the `cwd` leaf, plugin-predicate
  leaves, `condition:`, and the `not:` block-level policy.
- STRICT fail-closed — NO escape hatch: exemption evaluation also
  passes `ignoreExplicitModifiers: true`, so ANY explicit
  `onUnknown:` modifier present in an exemption clause is IGNORED
  (the projection is hard "allow" at all four sites). Even an
  `as any`-smuggled `onUnknown: "block"` never exempts on unknown.
  Unknown-handling is a policy of the PRIMARY gate (the rule); a
  carve-out shipped by a third-party plugin can never weaken it.
  Enforced at three levels: type-level (`ExemptionWhenClause` in
  schema.ts — writing `onUnknown` in an exemption is a compile
  error), load-time (`validateExemptionWhenClauseShape` rejects a
  smuggled `onUnknown` — clause top level, not-block top level, and
  leaf object forms), and evaluation (this flag — defense-in-depth).
- Escapes `evaluateWhen` doesn't swallow
  (`UnknownPredicateError`, `evaluateMissing` shape throws) are
  caught per-exemption in `evaluateExemptionClause` — a throwing
  exemption predicate = "does not match" = guard fires. Warn logs
  label the EXEMPTION, not the target rule: the outer catch emits
  `exemption for rule "…" threw`, and throws swallowed INSIDE
  `evaluateWhen` (handler / `condition:` catches) carry the source
  tag `@exemption` instead of a rule source like `@git` / `@user`.

**`unless` disambiguation:** `Rule.unless` is a per-rule, same-rule-scope optional exemption field. The registry is the cross-plugin ACCUMULATION mechanism — exemption-by-name stacks across layers and plugins; `unless` only lives on the rule it exempts.

**Exemption target names** (`exemption.rule`) flow into the same
user-visible surfaces (orphan diagnostics, `pi-steering list`
output, evaluator warn logs), so they get the same treatment:
`validateName("rule", exemption.rule, "exemption")` inside
`validateUserConfigNames` (config exemptions) and `resolvePlugins`
(plugin exemptions; a malformed exemption drops the whole plugin,
mirroring the rule/observer skip), plus the `buildEvaluator`
defense-in-depth throw for direct-caller paths. Exemption `when:`
clauses also pass `validateExemptionWhenClauseShape` at
`buildEvaluator` time — an empty clause (`when: {}`) would be
vacuous-true and silently exempt its target rule, opening the
guard, and a smuggled `onUnknown` would weaken the rule's
fail-closed posture.

### `S2` — write-through-read consistency

**Where:** `evaluator-internals/context.ts` (`createAppendEntry` /
`createFindEntries` paired-cache invariant).

When `createAppendEntry` and `createFindEntries` share the same
cache map (the evaluator wires them this way per tool_call; the
observer-dispatcher wires them per tool_result),
`createAppendEntry` invalidates the cache entry for the written
`customType` so the next paired `createFindEntries` call re-reads.
Callers omitting the shared cache get per-closure snapshot behavior.

### `S3` — name validation

**Where:** `plugin-merger.ts` (`validateName`; production pipeline
via `validateUserConfigNames` + `resolvePlugins`), `evaluator.ts`
(defensive throw in `buildEvaluator`), `observer-dispatcher.ts`
(defensive throw in `buildObserverDispatcher`).

Rule / plugin / observer names flow into user-visible strings — the
`[steering:<name>@<source>]` block-reason tag shown to the LLM, the
`@<source>` tag in warning logs, override-comment target matching,
`disabledRules` / `disabledPlugins` config references. Names
containing whitespace, control characters, `]`, or newlines let a
malicious or careless config author forge block reasons that
deceive the agent. (The tag is the SECOND line of a block reason —
the engine prepends its fixed not-executed preamble first.)

Validated at production call sites (`validateUserConfigNames`,
`resolvePlugins`) and as defense-in-depth at `buildEvaluator` /
`buildObserverDispatcher` — see per-site JSDocs.

## Evaluation invariants (`E`)

### `E1` — cross-rule write visibility within a phase

**Where:** paired-cache wiring in `evaluator.ts` and
`observer-dispatcher.ts`; cache mechanism in
`evaluator-internals/context.ts`.

Within a single tool_call (or tool_result) phase, rule B's
`when.missing` predicate MUST see entries rule A's `onFire` wrote
earlier in the same phase. Implementation: shared cache invalidation
per `S2`.

## Orchestration invariants (`O`)

### `O1` — observer-drop parity between runtime and CLI

**Where:** `internal/session-runtime.ts` (`buildSessionRuntime` →
`finalizePluginState`); `bin/pi-steering.ts`
(`runCliMergeWithInfoCapture`); `internal/drop-unused-observers.ts`
(`collectConsumedEvents`); `internal/finalize-plugin-state.ts`
(exemption-when threading); `testing/index.ts` (`loadHarness`).

**What:** Both surfaces apply `disabledRules` filtering BEFORE
running `dropUnusedObservers`, so an observer whose only consumers
are disabled rules surfaces the same `console.info` breadcrumb in
both paths. A future surface that bypasses this ordering would see
different observer-drop behavior than the runtime.

**Exemption parity extension:** `collectConsumedEvents` scans
EXEMPTION clauses' top-level `when.missing` identically to rules
(threaded through `finalizePluginState` from both config + plugin
buckets by all three callers). An observer whose writes are consumed
ONLY by an exemption's `missing` survives the drop — without this,
the exemption would be silently dead (its observer dropped, its
event never written).

**Pinned by:** `internal/session-runtime.test.ts` (runtime branch);
`bin/pi-steering.test.ts` (CLI branch); exemption-consumed-observer
survival test in `internal/session-runtime.test.ts` / observer-drop
unit tests.

### `O2` — single-emission lock for cross-detector tracker-name collisions

**Where:** `internal/session-runtime.ts` (`runMergerPipeline`);
`loader.ts` (`detectTrackerNameCollisions`); `plugin-merger.ts`
(`resolvePlugins`).

**What:** Both `buildConfig` (loader-side) and `resolvePlugins`
(merger-side) independently detect tracker-name collisions.
`runMergerPipeline` short-circuits before invoking `resolvePlugins`
when any merge-side diagnostic is error-class, so the aggregated
error message lists each tracker-name collision exactly once.

**Pinned by:** `internal/session-runtime.test.ts` "throws on an
error-class diagnostic regardless of failOnWarnings" (single-emission
lock); `session-start-load.test.ts` "throws on tracker-name-collision"
(integration mirror).
