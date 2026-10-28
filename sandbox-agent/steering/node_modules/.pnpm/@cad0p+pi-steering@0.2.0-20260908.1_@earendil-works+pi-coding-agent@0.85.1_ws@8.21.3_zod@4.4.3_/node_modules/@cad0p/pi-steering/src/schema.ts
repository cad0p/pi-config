// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * v2 config schema - TS-first rules, plugins, observers, predicates.
 *
 * Additive to the v1 schema (see `../schema.ts`). The existing evaluator
 * continues to drive the pi extension runtime on the v1 types; v2 types
 * live in parallel and power the new `defineConfig` / TS loader path.
 * Phase 3 rewrites the evaluator on top of this module and retires v1.
 *
 * Design references (see the accepted ADR, linked from PR #2's
 * description):
 *   - "Design → Rule schema"         → {@link Rule}, {@link TopLevelWhenClause},
 *                                       {@link Pattern}, {@link PredicateFn},
 *                                       {@link PredicateHandler}.
 *   - "Design → Observer schema"     → {@link Observer},
 *                                       {@link ObserverContext}.
 *   - "Design → Plugin schema"       → {@link Plugin}.
 *   - "Design → Predicate context"   → {@link PredicateContext}.
 *   - "Design → Override default"    → {@link SteeringConfig.defaultNoOverride}
 *                                       (default `true`, fail-closed).
 *
 * Nothing in this module executes rules, observers, or predicates. It
 * only defines shapes. Evaluation is Phase 3's concern.
 */

import type {
  EnvState,
  PositionPolicy,
  Tracker,
  Word,
} from "@cad0p/unbash-walker";
import type { SteeringCommand } from "./helpers/command.ts";

// ---------------------------------------------------------------------------
// Primitive predicate types
// ---------------------------------------------------------------------------

/**
 * Static or regex pattern accepted by all built-in string-valued
 * predicates (`when.cwd`, `when.branch`, `when.upstream`, ...).
 *
 * A plain string is treated as a regex source (compiled once at load
 * time by the evaluator - users escape literals themselves). A RegExp
 * is used as-is.
 *
 * See ADR "Design → Rule schema" → Pattern.
 *
 * @see {@link Patterns} for the OR-of-matches shorthand used by
 * pattern-leaf predicate registry augmentations.
 */
export type Pattern = string | RegExp;

/**
 * The OR-of-patterns shorthand for pattern-leaf predicate
 * registrations: a single {@link Pattern} or an array of
 * {@link Pattern}s (interpreted as OR-of-matches: any pattern
 * matching counts as a hit).
 *
 * Use as the bare-type parameter of {@link PredicateShape} when
 * registering a pattern-leaf predicate that accepts both bare
 * shorthand (`when: { myPredicate: /^foo$/ }`) and explicit object
 * form (`when: { myPredicate: { pattern: /^foo$/ } }`):
 *
 * @example
 * ```ts
 * import type { Patterns, PredicateShape } from "@cad0p/pi-steering";
 *
 * declare global {
 *   interface PiSteeringPredicates {
 *     myPredicate: PredicateShape<Patterns>;
 *   }
 * }
 * ```
 */
export type Patterns = Pattern | Pattern[];

/**
 * Escape-hatch predicate: arbitrary user-supplied logic evaluated with a
 * {@link PredicateContext}. Returned value gates whether the surrounding
 * rule fires. Async OK - evaluator awaits it.
 *
 * Used as the value of `when.condition`, and as the fallback shape for
 * plugin-registered custom keys on a {@link TopLevelWhenClause}.
 *
 * See ADR "Design → Rule schema" → PredicateFn.
 */
export type PredicateFn = (ctx: PredicateContext) => boolean | Promise<boolean>;

/**
 * Dynamic block-reason function. When {@link Rule.reason} is a
 * function, the evaluator invokes it with the same
 * {@link PredicateContext} the predicates saw and prefixes the
 * returned string with `[steering:<rule>@<source>] `. Async OK
 * (evaluator awaits); thrown errors are logged to `console.warn` and
 * replaced with a fail-safe fallback (`(reason failed to format;
 * see log)`) so a broken reason doesn't leak its raw error message
 * to the LLM.
 *
 * The engine additionally prepends a fixed preamble
 * (`BLOCK_REASON_PREAMBLE` — "This tool call was not executed; blocked by a steering rule:")
 * before the source tag on every rule-fired block reason (issue
 * #85); see {@link formatReason} in `../evaluator.ts`. The engine-
 * error path uses a distinct preamble
 * (`ENGINE_ERROR_PREAMBLE`).
 *
 * Use the function form when the block's human-readable context
 * depends on runtime state — e.g. "Could not verify upstream at
 * effective cwd \${ctx.walkerState.cwd}". Plain string reasons are
 * preferred when the reason is static; they avoid the evaluator's
 * extra  await + try/catch.
 *
 * @example
 *   // Inject the current branch name into the reason when the walker
 *   // resolved it statically; fall back to a generic message when the
 *   // walker bails or the tracker's initial-sentinel flows through.
 *   reason: (ctx) => {
 *     const raw = ctx.walkerState?.branch;
 *     const branch =
 *       typeof raw === "string" && raw !== "" && raw !== "unknown"
 *         ? raw
 *         : undefined;
 *     const onClause = branch ? ` You are on '${branch}'.` : "";
 *     return `Don't commit directly to a protected branch.${onClause}`;
 *   };
 */
export type ReasonFn = (ctx: PredicateContext) => string | Promise<string>;

/**
 * Plugin-registered predicate *handler*. Differs from {@link PredicateFn}
 * only in that the first argument is the structured argument the user
 * supplied under their custom `when.<key>` slot. Example:
 *
 * ```ts
 * // user config
 * when: { commitsAhead: { wrt: "origin/main", eq: 1 } }
 *
 * // plugin registration
 * predicates: {
 *   commitsAhead: (args: { wrt: string; eq: number }, ctx) => { ... }
 * }
 * ```
 *
 * `args` is whatever the rule author put under that key - the handler is
 * responsible for validating its shape. `ctx` is the same
 * {@link PredicateContext} the escape-hatch form receives.
 *
 * Returns a {@link PredicateVerdict} (`true | false | "unknown"`).
 * Pre-trinary handlers returning plain `boolean` remain source-compatible:
 * `boolean` is a subtype of `PredicateVerdict`, so existing handlers assign
 * unchanged. Handlers that need to surface walker-unknown state to the
 * engine return the literal string `"unknown"`; the engine then applies
 * the leaf's `onUnknown:` modifier (or, inside `not:`, the block-level
 * `onUnknown:`) to produce the leaf's verdict for downstream composition.
 *
 * Throwing inside a handler is equivalent to returning `"unknown"`: the
 * engine catches and treats the leaf as unknown, then applies the
 * `onUnknown:` policy. Prefer explicit returns; the catch exists so a
 * buggy handler can't silently fail-OPEN by skipping its rule.
 *
 * See ADR "Design → Rule schema" → PredicateHandler.
 */
export type PredicateHandler<A = unknown> = (
  args: A,
  ctx: PredicateContext,
) => PredicateVerdict | Promise<PredicateVerdict>;

// ---------------------------------------------------------------------------
// Per-predicate typing — registry, modifiers, mapped types
// ---------------------------------------------------------------------------

/**
 * Trinary verdict surfaced by predicate handlers. `true` / `false` are
 * the definite answers; the literal string `"unknown"` signals the
 * predicate could not resolve its value (typically because some piece
 * of walker-tracked state — cwd, branch, etc. — wasn't statically
 * resolvable). The engine then applies the leaf's `onUnknown:` policy
 * (or, inside `not:`, the block-level policy) to project the trinary
 * verdict back to a definite boolean for rule-level composition.
 */
export type PredicateVerdict = boolean | "unknown";

/**
 * Predicate modifiers — optional fields that can be added to a
 * predicate's spread form (outer leaf level) OR to the not-block top
 * level. Single source of truth for what predicate authors and users
 * can configure beyond the bare value. Adding a new modifier here
 * propagates everywhere in the schema (every predicate's spread form,
 * every not-block top level) and automatically reserves its key name
 * via {@link ReservedPredicateKey}.
 */
export interface PredicateModifiers {
  /**
   * Walker-unknown policy. When the predicate's value can't be
   * resolved at walker time (dynamic cwd / branch via `cd "$VAR"`,
   * `git checkout $VAR`, etc.), this policy decides the predicate's
   * verdict:
   *   - `"block"` (default): treat as fail-CLOSED — predicate fires.
   *   - `"allow"`: treat as fail-OPEN — predicate skips.
   *
   * At the leaf level (outer when-clause), this is per-predicate.
   * At the not-block top level, this applies to ALL leaves in the
   * not-block — leaf-level `onUnknown:` is forbidden inside `not:`
   * (type-level error) so the user can't write the silent
   * fail-OPEN `not: { cwd: P }` shape.
   */
  onUnknown?: "allow" | "block";
}

/**
 * Default spread BASE (without modifiers) inferred from `Bare`'s shape:
 *   - `Bare extends object`   → `Bare` directly (intersection at use site).
 *   - `Bare extends Patterns` → `{ pattern: Bare }` wrapper.
 *   - else (primitive)        → `{ value: Bare }` wrapper.
 *
 * Note the order: object check FIRST so a pure-object predicate
 * auto-detects to intersection (clean sibling-modifier UX). Pattern
 * check second to capture the built-in `string | RegExp | array`
 * family. Primitive fallback for `boolean`, `number`, etc.
 *
 * The tuple-wrap (`[Bare] extends [...]`) prevents distributive
 * conditional behavior across union members of `Bare`.
 */
export type DefaultSpreadBase<Bare> = [Bare] extends [object]
  ? Bare
  : [Bare] extends [Patterns]
    ? { pattern: Bare }
    : { value: Bare };

/**
 * Shape of a single entry in the {@link PiSteeringPredicates} registry.
 * Each predicate declares its `bare` form and (optionally) an explicit
 * `spreadBase` — the spread's object form WITHOUT modifiers.
 *
 * - `bare`: the value users write at the leaf (Pattern, boolean,
 *           number, etc.).
 * - `SpreadBase` (param): the spread's object form WITHOUT modifiers;
 *           defaults to {@link DefaultSpreadBase} from `Bare`.
 * - `spread` (derived at use site): `spreadBase & PredicateModifiers`
 *           — the form users write at the leaf to specify modifiers.
 *           Inner `not:` form omits modifiers (leaf-level `onUnknown:`
 *           inside `not:` is forbidden); outer leaf form intersects
 *           with `PredicateModifiers`.
 *
 * @see PredicateModifiers for the modifier surface available on every
 *      predicate's spread form.
 * @see DefaultSpreadBase for how the SpreadBase auto-detects from Bare.
 */
export interface PredicateShape<Bare, SpreadBase = DefaultSpreadBase<Bare>> {
  /**
   * The bare value users write at the leaf (no wrapper, no modifiers).
   *
   * For primitive {@link Bare} types (Pattern, boolean, number) this
   * is the shorthand authors reach for first — `cwd: /work/`,
   * `isClean: true`, `commitsAhead: 2`. The {@link spreadBase} form
   * mirrors the bare value as `{ value: Bare }` (or an explicit
   * `SpreadBase` shape for mixed-bare predicates like `commitsAhead`'s
   * comparator bag) when authors need to attach leaf-level modifiers
   * via `& PredicateModifiers`.
   *
   * For object {@link Bare} types the bare form IS the object shape
   * directly (no `value:` wrapper); the {@link spreadBase} adds
   * modifier slots without changing the structural shape.
   */
  bare: Bare;
  /**
   * The object form WITHOUT modifiers. Modifiers are added at use site
   * via `& PredicateModifiers` (outer leaf level) or at the not-block
   * top level (inside `not:`).
   */
  spreadBase: SpreadBase;
}

declare global {
  /**
   * Plugin-registered predicate registry. Empty by default; plugins
   * extend via TypeScript module augmentation (`declare global { interface
   * PiSteeringPredicates { ... } }`) to register typed predicates with
   * autocomplete + JSDoc.
   *
   * Keys must NOT collide with {@link ReservedPredicateKey} (the
   * operator-field union plus modifier keys); the type-level filter
   * via {@link Exclude} drops collisions silently, and the engine
   * throws at plugin-registration time with a concrete error message
   * pointing the plugin author at the collision.
   *
   * Do NOT add an index signature (e.g. `[k: string]: PredicateShape<unknown>`)
   * to this interface — it would widen `keyof PiSteeringPredicates` to
   * `string`, defeating the reserved-key filter (`Exclude<string,
   * "not" | "onUnknown">` is just `string` again).
   *
   * @example Plugin author registering a typed predicate
   * ```ts
   * import type { Plugin, PredicateShape } from "@cad0p/pi-steering";
   * import { workItemFormat } from "./predicates/work-item-format.ts";
   * import type { WorkItemFormatArgs } from "./predicates/work-item-format.ts";
   *
   * declare global {
   *   interface PiSteeringPredicates {
   *     workItemFormat: PredicateShape<WorkItemFormatArgs>;
   *   }
   * }
   *
   * const myPlugin = {
   *   name: "work-item",
   *   predicates: { workItemFormat },
   * } as const satisfies Plugin;
   * ```
   *
   * @see {@link PredicateShape} for the bare / spreadBase shape contract.
   * @see {@link DefaultSpreadBase} for how spreadBase auto-detects from `bare`.
   * @see {@link PredicateModifiers} for available leaf-level modifier fields.
   * @see The `gitPlugin` declaration in `plugins/git/index.ts` for a
   *      multi-predicate registry block (branch, upstream, remote,
   *      isClean, hasStagedChanges, commitsAhead).
   * @see `examples/work-item-plugin/` for an end-to-end external-plugin
   *      reference: handler module, predicate-bare-shape registration,
   *      and a worked rule + tests.
   */
  interface PiSteeringPredicates {
    // Empty by default. Plugins augment via `declare global`.
  }
}

/**
 * Operator fields on `TopLevelWhenClause`. Currently just `"not"`;
 * future v0.2 may add `"or"` / `"and"` operators. Kept as a separate
 * union so reserved-key derivation stays lockstep with operator
 * additions.
 */
export type OperatorField = "not";

/**
 * Reserved predicate keys derived from `OperatorField | keyof
 * PredicateModifiers`. Plugin authors cannot register predicates with
 * these names — they collide with the schema's `not?:` operator field
 * and the `& PredicateModifiers` intersection on spread forms.
 *
 * Adding a new modifier to {@link PredicateModifiers} automatically
 * reserves its key (lockstep via `keyof`); adding a new operator
 * requires extending {@link OperatorField}.
 *
 * The type-level filter via {@link PluginPredicateKey} removes these
 * names from the mapped types; the runtime constant
 * `RESERVED_PREDICATE_KEYS` (in `evaluator-internals/predicates.ts`)
 * mirrors this set so the engine throws at plugin-registration time
 * with a concrete error message.
 */
export type ReservedPredicateKey = OperatorField | keyof PredicateModifiers;

/**
 * Plugin-registered predicate keys with reserved names filtered out.
 * Used as the value-position constraint on {@link OuterValue} /
 * {@link InnerValue}, and as the `K & PluginPredicateKey`
 * intersection narrowing inside {@link TopLevelWhenClause} /
 * {@link TopLevelWhenClauseNoRecurse}. NOT used as the mapped-type
 * iteration source — those mapped types iterate `keyof
 * PiSteeringPredicates` directly with an `as`-filter, see their
 * mapping-shape note for why.
 */
export type PluginPredicateKey = Exclude<
  keyof PiSteeringPredicates,
  ReservedPredicateKey
>;

/**
 * Outer leaf value: the bare form OR the spreadBase intersected with
 * {@link PredicateModifiers}. Used at the top-level `when:` clause
 * where each plugin-registered predicate accepts modifiers per-leaf.
 *
 * @see TopLevelWhenClause for the surface that consumes this mapped
 *      type.
 */
export type OuterValue<K extends PluginPredicateKey> =
  | PiSteeringPredicates[K]["bare"]
  | (PiSteeringPredicates[K]["spreadBase"] & PredicateModifiers);

/**
 * Inner leaf value (inside `not:`): bare form OR spreadBase WITHOUT
 * modifiers. Modifiers live at the not-block top level — leaf-level
 * modifiers inside `not:` are forbidden so the silent fail-OPEN
 * `not: { cwd: P }` shape can't be reproduced via leaf-level
 * `onUnknown:` placement.
 *
 * @see TopLevelWhenClauseNoRecurse for the surface that consumes this
 *      mapped type.
 */
export type InnerValue<K extends PluginPredicateKey> =
  | PiSteeringPredicates[K]["bare"]
  | PiSteeringPredicates[K]["spreadBase"];

/**
 * A single subcommand pattern for {@link SubcommandLeaf} /
 * {@link SubcommandLeafInner}.
 *
 * NOTE the deliberate deviation from {@link Pattern}: a bare `string`
 * here is EXACT equality (`"push"` ≠ `"pushback"`), NOT a regex
 * source. `RegExp` members test against the extracted word. Typed
 * separately so authors don't carry `cwd:`'s regex-source intuition
 * across.
 */
export type SubcommandPattern = string | RegExp;

/**
 * Spread form shared by {@link SubcommandLeaf} (outer) and
 * {@link SubcommandLeafInner} (inner): `{ anyOf }` — the explicit OR,
 * mirroring the {@link FlagSpreadBase} leaf. Each member is a single
 * {@link SubcommandPattern} (one-word match) or a positional sequence
 * of them (`["pr", "create"]` matches `gh pr create ...` — the
 * member's length IS the extraction width, inferred per member).
 *
 * There is deliberately NO `depth` key: arrays always mean positional
 * sequence, so the width is never declared twice. `{ anyOf: ["pr",
 * "push"] }` fires on either one-word subcommand; `{ anyOf:
 * [["pr", "create"], ["repo", "create"]] }` fires on either
 * two-word sequence. Members may mix widths.
 */
export interface SubcommandSpreadBase {
  /**
   * OR over members: each a single pattern or a positional sequence.
   * Non-empty; every member a `string | RegExp` or a non-empty
   * all-`string | RegExp` array.
   */
  anyOf: readonly (SubcommandPattern | readonly SubcommandPattern[])[];
  /**
   * Arity resolves ONLY via the CLI-descriptor registry by basename
   * (issue #107): flags that consume the following token (`-C`, `-c`,
   * `-R`, `--repo`, `--profile`, …) so values never read as
   * subcommands. No descriptor → the engine throws `MissingDescriptorError`
   * before evaluation (loud block naming the missing facts); `{<bin>: {}}`
   * present-empty is explicit strict. The walker stays arity-ignorant.
   */
}

/**
 * Rule-level (`when:`) `subcommand:` leaf: bare pattern(s) or the
 * spread form with leaf-level `onUnknown?:` (default `"block"` =
 * fail-CLOSED).
 *
 * @see SubcommandPattern for the bare-string exactness contract.
 */
export type SubcommandLeaf =
  | SubcommandPattern
  | SubcommandPattern[]
  | (SubcommandSpreadBase & { onUnknown?: "allow" | "block" });

/**
 * `not:`-block `subcommand:` leaf: same as {@link SubcommandLeaf}
 * but the spread form drops `onUnknown?:` — modifiers live at the
 * not-block level via `& PredicateModifiers`.
 */
export type SubcommandLeafInner =
  | SubcommandPattern
  | SubcommandPattern[]
  | SubcommandSpreadBase;

/**
 * Spread form shared by {@link FlagLeaf} (outer) and
 * {@link FlagLeafInner} (inner): `{ anyOf }`.
 * `flag:` has no bare form.
 */
export interface FlagSpreadBase {
  /**
   * Flag entries to scan for. OR over entries; each entry ORs aliases.
   * Longs (`--force`) match the exact token or the attached `--force=x`
   * form; single-char shorts (`-f`) match the exact token, inside
   * bundles (`-uf` always matches `-u` / `-f` — longs never
   * bundle-match), or glued (`-Rfoo` matches `-R` iff the table derives
   * glue for `R`). Bundle matching derives from the descriptor table via
   * the lead-letter rule (first table-declared value-taking letter glues
   * the remainder; undeclared letters never glue — fail-closed, add a
   * table row). Each entry must be a well-formed `CLIFlag` (`aliases`
   * non-empty `--long` / `-x` spellings, `takesValue` boolean); malformed
   * entries fail-skip → leaf `false` (rule skips, NOT unknown). Empty
   * `anyOf` is likewise invalid → `false`.
   */
  anyOf: readonly CLIFlag[];
  /**
   * Arity resolves via the entries + descriptor table (issue #110):
   * consumption derives from the entries + registry-by-basename table.
   * No descriptor → the engine throws `MissingDescriptorError` before
   * evaluation (loud block); `{<bin>: {}}` present-empty is explicit strict.
   */
}

/**
 * Rule-level (`when:`) `flag:` leaf: the spread form with leaf-level
 * `onUnknown?:` (default `"block"` = fail-CLOSED; only reachable
 * on non-bash tools with no `args` — otherwise presence is
 * definite).
 */
export type FlagLeaf = FlagSpreadBase & {
  onUnknown?: "allow" | "block";
};

/**
 * `not:`-block `flag:` leaf: same as {@link FlagLeaf} but drops
 * `onUnknown?:` — modifiers live at the not-block level via
 * `& PredicateModifiers`.
 */
export type FlagLeafInner = FlagSpreadBase;

/**
 * Canonical per-flag fact (issue #110). Key in the table is the canonical
 * name (e.g. `repo`); matching is ALWAYS over `aliases`, never the key.
 */
export interface CLIFlag {
  /** Spellings, e.g. ["-R", "--repo"]. Non-empty; each "--long" or "-x". */
  readonly aliases: readonly string[];
  /**
   * Separate (-R x, --repo x) + attached (--repo=x) + glued (-Rx, shorts
   * only) consumption. Longs never glue; attached needs no declaration.
   */
  readonly takesValue: boolean;
}

/**
 * Per-binary argv knowledge for one command basename (issues #106/#110).
 *
 * A `CLIDescriptor` supplies `positionPolicy` + flag arity to both ARGV
 * leaves (`when.subcommand` / `when.flag`) and to the bound
 * `SteeringCommand` facade — the ONLY arity channel (issue #107,
 * registry-only: no inline declaration). Resolution: registry entry
 * (present-empty `{<bin>: {}}` = explicit strict: nothing consumes, policy
 * table fallback) else throw `MissingDescriptorError` (loud block on the
 * rule path, non-match on the exemption path). Registry `positionPolicy`
 * always overrides the table fallback.
 *
 * Flag arity lives in the `flags` table (issue #110):
 * `flags?: Record<canonical-name, CLIFlag>`. Glue DERIVES (`takesValue` +
 * single-char-short alias ⇒ glues; longs never glue).
 *
 * Keyed by command basename (`"git"`, `"gh"`) in
 * {@link Plugin.cliDescriptors} and the merged
 * `ResolvedPluginState.cliDescriptors`.
 */
export interface CLIDescriptor {
  /** Walker half (cf. `DEFAULT_POSITION_POLICIES`). */
  positionPolicy?: PositionPolicy;
  /** Per-binary flag facts, keyed by canonical name (e.g. `repo`). */
  flags?: Readonly<Record<string, CLIFlag>>;
}

/**
 * Built-in non-registry leaves attached to a {@link Rule.when}
 * clause — outer flavor. All leaves present in this block are
 * ANDed — the clause fires only when every leaf fires.
 *
 * These predicates ship with the engine itself (not via a plugin),
 * so they aren't in {@link PiSteeringPredicates} but DO need to
 * surface on {@link TopLevelWhenClause} as typed fields.
 *
 * The `Writes` generic threads through {@link defineConfig} so that
 * `when.missing.event` / `when.missing.since` references are
 * compile-time-checked against the union of declared `writes`
 * arrays across plugins + observers.
 *
 * Currently five non-registry leaves: `missing?:`, `condition?:`,
 * `cwd?:`, `subcommand?:`, `flag?:`. The shape is pinned in tests (a
 * future widening — e.g., adding a new built-in `tool?:` leaf — fails
 * the type-pin and forces a deliberate decision).
 *
 * ## Outer / Inner split
 *
 * `cwd:`'s spread form differs depending on placement:
 *
 * - Outer (rule-level `when:`) — leaf-level `onUnknown?:` allowed,
 *   honored by the engine's `evaluateCwd` + `projectVerdict` flow.
 * - Inner (inside `not:`) — leaf-level `onUnknown?:` forbidden
 *   (parity with registry-driven inner predicates per
 *   {@link InnerValue}). Walker-unknown cwd inside `not:` projects
 *   via the block-level `onUnknown:` modifier (default `"block"`).
 *
 * Two parallel interfaces formalize this split: this type
 * (`BuiltInWhenLeavesOuter`) and {@link BuiltInWhenLeavesInner}. The
 * legacy `BuiltInWhenLeaves` symbol is preserved as a deprecated
 * alias to `Outer` for backward compatibility — new code should
 * import the explicit Outer / Inner flavor.
 *
 * This is the outer-flavor interface. `cwd?:` accepts
 * `Pattern | Pattern[] | { pattern, onUnknown? }` (leaf-level
 * `onUnknown:` honored at the outer when-level via `evaluateCwd` /
 * `projectVerdict`).
 *
 *
 * ## ARGV leaves (`subcommand:` / `flag:`)
 *
 * The spread forms differ the same way (`subcommand:`'s
 * `{ anyOf, onUnknown? }` and `flag:`'s
 * `{ anyOf, onUnknown? }` drop
 * `onUnknown?:` inside `not:`). Named leaf types below keep the
 * Outer/Inner declarations in lockstep: {@link SubcommandLeaf} /
 * {@link SubcommandLeafInner} and {@link FlagLeaf} /
 * {@link FlagLeafInner}.
 *
 * @see BuiltInWhenLeavesInner for the parallel inner-flavor type
 *      used inside `not:`.
 */
export interface BuiltInWhenLeavesOuter<Writes extends string = string> {
  /**
   * Rule fires while the given `event` is MISSING in the given
   * scope. Typical usage: "block `cr` while sync is missing" -
   * `missing: { event: "rds-ws-sync-done", in: "agent_loop" }`.
   *
   * Scopes:
   *   - `"agent_loop"` - filter session entries by
   *     `entry.data._agentLoopIndex === ctx.agentLoopIndex`. The engine
   *     auto-injects that tag on every `appendEntry` write, so plugin
   *     authors don't have to remember to tag manually.
   *   - `"session"`    - no scope filter. Any entry of `event` present
   *     in the session JSONL satisfies.
   *   - `"tool_call"`  - only consider speculative entries synthesized
   *     for THIS tool_call's `&&`-chain. Real (persisted) entries are
   *     ignored entirely. Use when the rule requires the event to be
   *     CHAINED directly before the guarded command (e.g. `sync && cr`)
   *     rather than merely "somewhere this agent loop". Pairs naturally
   *     with observer `writes:` declarations on observers whose
   *     watch-matched refs produce speculative entries; no-op when no
   *     observer writes the event.
   *
   * Inversion: place inside `not` to flip the clause-level boolean -
   * `not: { missing: { event, in } }` fires when the event IS
   * PRESENT. See ADR §5.
   *
   * Optional `since` sentinel (temporal ordering): when present,
   * `event` counts as present only if its most-recent entry
   * in scope is newer than the most-recent `since` entry in scope.
   * If `since` has never been written, the clause behaves as if
   * `since` were absent (simple presence check on `event`).
   *
   * Use for invalidation semantics: "rule fires while sync is
   * missing from this agent_loop, OR the last sync is older than the
   * last upstream-fail." Pattern:
   *   `missing: { event: SYNC_DONE_EVENT, in: "agent_loop",
   *                since: UPSTREAM_FAILED_EVENT }`.
   *
   * Optional `notIn` (set subtraction over scopes): when present,
   * entries in `notIn` scope are excluded from the `in`-scoped entry
   * stream BEFORE the `ts_max` comparison runs. Typical use:
   * `missing: { event, in: "agent_loop", notIn: "tool_call" }` -
   * "recorded in a prior tool_call in this agent loop". Excludes
   * same-tool_call speculative entries so `someCmd && guardedCmd`
   * can't bypass the rule via tool_call-scope speculative synthesis.
   *
   * Distinct from the clause-level {@link TopLevelWhenClause.not},
   * which is boolean negation of a sub-clause. `notIn` is set
   * subtraction; separate keyword so the two operators can't be
   * confused.
   *
   * Invalid scope combinations throw at evaluation time with the
   * rule name prefixed:
   *   - Supersets (e.g. `in: "agent_loop", notIn: "session"`) - the
   *     subtraction is always empty.
   *   - Identicals (`notIn === in`) - the subtraction is always empty.
   *
   * Compile-time constraint: inside {@link defineConfig}, both the
   * `event` and `since` fields are narrowed to the union of all
   * `writes` declared across plugin rules, plugin observers, user
   * rules, and user observers. Typos become compile errors. Outside
   * `defineConfig` the `Writes` parameter defaults to `string` so the
   * check is skipped.
   */
  missing?: {
    event: Writes;
    in: "agent_loop" | "session" | "tool_call";
    since?: Writes;
    notIn?: "agent_loop" | "session" | "tool_call";
  };

  /**
   * Escape-hatch predicate for one-off logic. FORBIDDEN in examples
   * (CI-pinned: no `condition:` key under `examples/`, any depth) —
   * example rules compose built-in leaves and registered predicates
   * instead (see the `force-push-strict` pack for the blessed
   * inline-plugin registered-predicate shape). Leaf-inexpressible or reused logic gets a named
   * `definePredicate` per ADR §13 (precedents: the rm plugin's
   * `hasRecursiveForce`, the git plugin's `isForcePush`) — a name
   * carries its own unit tests and a registry entry, an inline
   * closure carries neither.
   *
   * Throws (sync or rejected promise) are caught and treated as
   * `"unknown"`. Outer-level `condition:` is bare-`PredicateFn`-typed
   * (no spread shape), so the projection always uses the default
   * `"block"` policy: a throwing condition fires the rule fail-CLOSED.
   * Authors needing fail-OPEN wrap inside
   * `not: { condition: fn, onUnknown: "allow" }` (block-level
   * modifier) OR catch the throw inside the callback body. Mirrors
   * the plugin-handler exception contract.
   */
  condition?: PredicateFn;

  /**
   * Constrain the rule to commands whose *effective* cwd matches
   * the given pattern. For bash, the walker's `cwdTracker` resolves
   * the effective cwd per extracted command (so
   * `cd ~/personal && git commit --amend` evaluates against
   * `~/personal`). For write / edit, the session cwd is used directly.
   *
   * Bare form: a single {@link Pattern} or an OR-of-patterns array.
   * Spread form: `{ pattern, onUnknown? }` — the object lets authors
   * opt into `onUnknown: "allow"` when a command's cwd can't be
   * statically resolved (e.g. `cd $VAR && ...`). Default is `"block"`
   * — fail-closed.
   *
   * Array form (`Pattern[]` or `{ pattern: Pattern[]; onUnknown? }`)
   * matches OR-of-patterns: the predicate fires when the resolved cwd
   * matches ANY of the listed patterns. Empty arrays are invalid (rule
   * skips); arrays containing non-Pattern values are invalid (rule
   * skips). Array form sugars vault-path or workspace-tree exemptions:
   *
   *   ```ts
   *   when: { cwd: [/\/Goldmine\//, /\/\.cache\/napkin-distill\//] }
   *   when: { cwd: { pattern: [/\.test$/, /\.spec$/], onUnknown: "allow" } }
   *   ```
   *
   * `cwd:` is the sole walker-tied built-in leaf; all other dimensions
   * (`branch`, `upstream`, ...) come from plugins. It lives on
   * {@link BuiltInWhenLeaves} (not the registry) so authors can write
   * `when: { cwd: /work/ }` against pi-steering core without needing
   * gitPlugin's module augmentation in scope.
   *
   * See ADR "Design → Override default and `onUnknown`".
   */
  cwd?:
    | Pattern
    | Pattern[]
    | { pattern: Pattern | Pattern[]; onUnknown?: "allow" | "block" };

  /**
   * Constrain the rule to commands invoking a given subcommand.
   * The engine extracts the subcommand run structurally via the walker's
   * `locateSubcommandRun` (projected from `PredicateWord[]` —
   * so no regex, no index math in rules) and matches it against the declared pattern(s).
   *
   * Bare `string` = EXACT equality (`"push"` does NOT match
   * `"pushback"`) — deliberately NOT the regex-source semantics of
   * {@link Pattern}-typed leaves like `cwd:`. `RegExp` = test
   * against the extracted word. Bare array = positional sequence
   * (`["pr", "create"]` matches `gh pr create ...` — length IS
   * the extraction width, inferred). Spread form `{ anyOf,
   * onUnknown? }` is the explicit OR, mirroring the `flag:` leaf:
   * `{ anyOf: ["pr", "push"] }` fires on either one-word
   * subcommand; `{ anyOf: [["pr", "create"], ["repo",
   * "create"]] }` fires on either two-word sequence (members may
   * mix widths; extraction width is per-member). Malformed leaves
   * (empty array, empty `anyOf`, non-`string | RegExp` members,
   * non-sequence `anyOf` members, missing `anyOf`, the deleted
   * `{ pattern, depth }` shape) evaluate to `false` (rule skips,
   * `cwd`-style fail-skip). There is no zero-width unknown shape:
   * `command:` alone with no `subcommand:` leaf is the unfiltered form.
   *
   * Consuming-flag arity resolves ONLY via the CLI-descriptor registry
   * by basename (issue #107): `git -C DIR` / `-c <key>=<value>` skip
   * via the git plugin's declared descriptor, so `git -c KEY=VAL push`
   * extracts `push` (without a registered descriptor it would read
   * `KEY=VAL` and the rule would silently SKIP — fail-open for guard
   * rules; prefer import-plugin + `disabledRules` over going without).
   * The walker stays arity-ignorant; per-binary lists are
   * plugin-declared. Attached `--flag=value` forms consume without
   * declaration (single token by construction). No descriptor → the engine
   * throws `MissingDescriptorError` before evaluation (loud block;
   * `{<bin>: {}}` present-empty is explicit strict).
   *
   * Position policy resolves from the walker's
   * `DEFAULT_POSITION_POLICIES` table keyed on the ref basename
   * (`git` → globals-before-only), falling back to
   * `"globals-anywhere"`. A `null` extraction (all-flags
   * invocation, trailing consuming flag, after-only invalid shape
   * like `go -v build`, assignment-only/nameless, non-bash tools
   * with no `args`) surfaces `"unknown"` → `onUnknown:` policy
   * (default `"block"` = fail-CLOSED, rule fires).
   *
   * Word forms are ENV-RESOLVED runtime forms (issue #51): `"$X"`
   * with `X=--force` classifies flag-shaped (it IS what executes).
   *
   * @see BuiltInWhenLeavesInner.subcommand for the `not:`-block
   *      flavor (spread drops `onUnknown?:`).
   */
  subcommand?: SubcommandLeaf;

  /**
   * Constrain the rule to commands carrying any of the listed flag
   * spellings. Presence scan over the ref's resolved words:
   * longs match the exact token or the attached `--flag=value`
   * form; single-char shorts (`-f`) match the exact token, inside
   * bundles (always on — `git push -uf` matches `-u` / `-f`; longs
   * NEVER bundle-match), or glued (`-Rfoo` matches `-R` iff the table
   * derives glue for `R`). Bundle matching derives from the descriptor
   * table via the lead-letter rule: the first table-declared
   * value-taking letter glues the remainder (nothing after it is
   * present); undeclared letters never glue (strict-always,
   * fail-closed — the remedy is a table row). Multi-char short spellings (e.g. `-ff`),
   * empty `anyOf`, or non-string members are invalid and the leaf
   * evaluates to `false` (rule skips, NOT unknown).
   *
   * Values of registry-declared consuming flags are skipped BY POSITION
   * (`i += 2`), never by content: `gh -R --force pr` with `-R`
   * declared (via a plugin `cliDescriptors` entry for `gh`) does NOT
   * report `--force` present. No descriptor → the engine throws
   * `MissingDescriptorError` before evaluation (loud block). `--`
   * itself is a
   * flag-shaped token; post-`--` positionals are unmodelled (walker
   * limitation) — a `--force` after `--` still scans as present.
   *
   * Non-bash tools (no `args`) surface `"unknown"` → `onUnknown:`
   * policy (default `"block"` = fail-CLOSED). Otherwise presence is
   * definite (absent → `false`, never unknown).
   *
   * @see BuiltInWhenLeavesInner.flag for the `not:`-block flavor
   *      (spread drops `onUnknown?:`).
   */
  flag?: FlagLeaf;
}

/**
 * Inner-flavor non-registry built-in leaves. Lives on
 * {@link TopLevelWhenClauseNoRecurse} (the body of `not:`). Leaves
 * inside a `not:` block are ANDed too — every inner leaf must match
 * for the combined verdict to be `true`, and `not:` inverts that
 * combined verdict. `cwd?:` accepts `Pattern | Pattern[] |
 * { pattern }`, `subcommand?:` its {@link SubcommandLeafInner} shape,
 * and `flag?:` its {@link FlagLeafInner} shape — NO leaf-level
 * `onUnknown?:` on any of them. Modifiers live at the not-block level via
 * `& PredicateModifiers`, matching the constraint registry-driven
 * inner predicates already enforce via `InnerValue<K>`.
 *
 * `missing?:` and `condition?:` are identical to
 * {@link BuiltInWhenLeavesOuter}; only the `cwd:` / `subcommand:` /
 * `flag:` spreads differ (each drops `onUnknown?:`). The engine
 * reads block-level `onUnknown:` inside `not:` regardless of leaf
 * shape, so this type formalizes that constraint at the authoring
 * surface (preventing the silent fail-OPEN class where leaf-level
 * `onUnknown:` looks meaningful but is ignored at runtime).
 *
 * @see BuiltInWhenLeavesOuter for the design rationale, the
 *      Outer/Inner split, and the parallel outer-flavor type.
 */
export interface BuiltInWhenLeavesInner<Writes extends string = string> {
  /** Identical to {@link BuiltInWhenLeavesOuter.missing}. */
  missing?: BuiltInWhenLeavesOuter<Writes>["missing"];

  /** Identical to {@link BuiltInWhenLeavesOuter.condition}. */
  condition?: BuiltInWhenLeavesOuter<Writes>["condition"];

  /**
   * Same `cwd:` semantics as {@link BuiltInWhenLeavesOuter.cwd} but
   * the spread form's `onUnknown?:` is dropped — modifiers live at
   * the not-block level via `& PredicateModifiers`. Walker-unknown
   * cwd inside `not:` projects via the block-level `onUnknown:`
   * (default `"block"` = fail-CLOSED, rule fires).
   */
  cwd?: Pattern | Pattern[] | { pattern: Pattern | Pattern[] };

  /**
   * Same `subcommand:` semantics as
   * {@link BuiltInWhenLeavesOuter.subcommand} but the spread form's
   * `onUnknown?:` is dropped — modifiers live at the not-block level
   * via `& PredicateModifiers`.
   */
  subcommand?: SubcommandLeafInner;

  /**
   * Same `flag:` semantics as {@link BuiltInWhenLeavesOuter.flag}
   * but the spread form's `onUnknown?:` is dropped — modifiers live
   * at the not-block level via `& PredicateModifiers`.
   */
  flag?: FlagLeafInner;
}

/**
 * Backward-compatible alias for {@link BuiltInWhenLeavesOuter}.
 *
 * Retained so external code importing `BuiltInWhenLeaves` (and the
 * public-surface shape pin in `not-block-onunknown.test.ts`) keeps
 * working after the Outer/Inner split.
 *
 * @deprecated Use {@link BuiltInWhenLeavesOuter} for outer-level
 * authoring or {@link BuiltInWhenLeavesInner} for `not:` block
 * bodies. This alias is retained for backward compatibility and may
 * be removed in a future release.
 */
export type BuiltInWhenLeaves<Writes extends string = string> =
  BuiltInWhenLeavesOuter<Writes>;

/**
 * Top-level when-clause attached to a {@link Rule}. All leaves
 * present in this block are ANDed — the clause fires only when every
 * leaf fires. An empty/undefined clause trivially matches (the rule
 * fires regardless of `when:`). Each
 * plugin-registered predicate (filtered for reserved keys) gets a
 * leaf-level field accepting the bare or spread form. The `not?:`
 * operator allows one level of negation (no recursion).
 *
 * Generic over `Writes` so the built-in `missing?:` leaf's `event` /
 * `since` references narrow to the union of declared `writes` strings
 * threaded through by {@link defineConfig}.
 *
 * Mapping shape note: the constraint is `keyof PiSteeringPredicates`
 * with an `as`-filter excluding {@link ReservedPredicateKey}, rather
 * than the pre-computed alias `[K in PluginPredicateKey]`. Both shapes
 * produce the same keyset, but only the homomorphic-with-filter form
 * propagates JSDoc on hover from `PiSteeringPredicates.<key>` source
 * declarations onto the synthesized field. The `& PluginPredicateKey`
 * intersection in the value position narrows `K` back to the
 * constraint expected by {@link OuterValue}. Keep both the constraint
 * and the `as`-filter inlined — extracting either to a type alias
 * silently regresses the propagation.
 *
 * Hover-on-`defineConfig`-inline-rules caveat: passing rule literals
 * directly into `defineConfig({ rules: [{ ... }] })` bypasses the
 * mapped-type linkage — the `const R extends readonly Rule[]`
 * signature narrows the literal to its `const`-inferred shape.
 * Factor rules out (`const myRule = { ... } as const satisfies Rule`)
 * when hover-rich authoring matters; see the {@link defineConfig} JSDoc.
 *
 * @see TopLevelWhenClauseNoRecurse for the body of `not:`.
 * @see PredicateModifiers for available leaf-level modifier fields.
 * @see BuiltInWhenLeaves for the engine's non-registry leaf set.
 */
export type TopLevelWhenClause<Writes extends string = string> = {
  [K in keyof PiSteeringPredicates as K extends ReservedPredicateKey
    ? never
    : K]?: OuterValue<K & PluginPredicateKey>;
} & BuiltInWhenLeavesOuter<Writes> & {
    /**
     * Logical NOT: rule fires when the inner predicates' AND is false.
     *
     * Multi-leaf semantics: leaves AND together with Kleene 3-valued
     * logic. Walker-unknown leaves resolve via the block-level
     * `onUnknown:` modifier (default `"block"` = fail-CLOSED, rule
     * fires).
     *
     * No leaf-level `onUnknown:` here (forbidden at type level —
     * modifiers live at the not-block level). No `not:` recursion
     * (forbidden at type level — semantically equivalent to the
     * unwrapped form). Nested `not:` is also rejected at runtime by
     * `validateWhenClauseShape` for JSON / `as any` escape hatches.
     *
     * @see TopLevelWhenClauseNoRecurse
     * @see PredicateModifiers
     */
    not?: TopLevelWhenClauseNoRecurse<Writes>;
  };

/**
 * Body of a `not:` block: predicates with their bare / spreadBase
 * forms (NO leaf-level modifiers — modifiers live at this block's top
 * level via `& PredicateModifiers`). No nested `not:` (no recursion).
 * All leaves inside this block are ANDed — the block fires only when
 * every leaf fires, and `not:` inverts that combined verdict.
 *
 * Generic over `Writes` so the built-in `missing?:` leaf inherits
 * the same compile-time event-narrowing as the outer level.
 *
 * Same homomorphic-with-filter mapping shape as
 * {@link TopLevelWhenClause} (and the same `defineConfig`-inline
 * caveat). See the mapping-shape note there for the rationale.
 *
 * @see TopLevelWhenClause for the rule-attached when-clause.
 * @see PredicateModifiers for block-level modifier fields.
 */
export type TopLevelWhenClauseNoRecurse<Writes extends string = string> = {
  [K in keyof PiSteeringPredicates as K extends ReservedPredicateKey
    ? never
    : K]?: InnerValue<K & PluginPredicateKey>;
} & BuiltInWhenLeavesInner<Writes> &
  PredicateModifiers;

/**
 * Exemption clause — a `when`-shaped clause WITHOUT any `onUnknown`
 * modifier. Exemptions are STRICTLY fail-closed: unknown walker
 * values never exempt (the guard still fires). The modifier-stripped
 * shape forbids the fail-open direction at compile time.
 *
 * Built from the existing building blocks: {@link InnerValue} (bare |
 * spreadBase, no modifiers — leaf spread forms lose `onUnknown`),
 * {@link BuiltInWhenLeavesInner} (the inner flavor whose `cwd` has no
 * `{ pattern, onUnknown }` object form), and the not-block without
 * `PredicateModifiers` (`Omit<TopLevelWhenClauseNoRecurse,
 * "onUnknown">` strips the block-level modifier).
 *
 * `onUnknown` is forbidden ANYWHERE inside an exemption clause — at
 * the clause top level, at the not-block top level, and in leaf
 * object forms. Unknown-handling is a policy of the PRIMARY gate (the
 * rule); a carve-out (possibly shipped by a third-party plugin) must
 * never be able to weaken the guard's fail-closed posture. Enforced
 * at three levels:
 *   1. type-level (this type — writing `onUnknown` is a compile
 *      error),
 *   2. runtime validation
 *      (`validateExemptionWhenClauseShape` rejects a smuggled
 *      `onUnknown` at load time for `as any` / plain-JS authors),
 *   3. evaluation (explicit modifiers are ignored regardless — the
 *      projection is hard "allow"; defense-in-depth).
 *
 * The target rule's own `onUnknown:` policy decides how unknown
 * values project for the GUARD; an exemption can only ever contribute
 * "does not match" on unknown.
 *
 * @see Exemption
 * @see InnerValue
 * @see BuiltInWhenLeavesInner
 * @see TopLevelWhenClauseNoRecurse
 */
export type ExemptionWhenClause<Writes extends string = string> = {
  [K in keyof PiSteeringPredicates as K extends ReservedPredicateKey
    ? never
    : K]?: InnerValue<K & PluginPredicateKey>;
} & BuiltInWhenLeavesInner<Writes> & {
    // `missing` / `condition` are re-declared to strip the
    // `| undefined` that `BuiltInWhenLeavesInner`'s indexed-access
    // declarations (`BuiltInWhenLeavesOuter<Writes>["missing"]` /
    // `["condition"]`) leak under `exactOptionalPropertyTypes` —
    // the intersection of `X | undefined` (inner flavor) with `X`
    // (this declaration) resolves to `X`, keeping the type
    // assignable to {@link TopLevelWhenClause} at internal surfaces
    // (evaluator exemption map, finalizePluginState, validator).
    missing?: Exclude<BuiltInWhenLeavesInner<Writes>["missing"], undefined>;
    condition?: Exclude<BuiltInWhenLeavesInner<Writes>["condition"], undefined>;
    not?: Omit<TopLevelWhenClauseNoRecurse<Writes>, "onUnknown">;
  };

/**
 * Type-erased alias for {@link PredicateHandler} used at registry
 * boundaries (notably {@link Plugin.predicates}).
 *
 * TypeScript treats function-argument types as contravariant: a
 * `PredicateHandler<CommitsAheadArgs>` is **not** assignable to a
 * `PredicateHandler<unknown>` because the handler needs to *accept*
 * `unknown`, while the specialized handler only accepts a narrower
 * shape. Using `any` at the registry slot leverages TS's bivariance
 * fallback — specifically-typed handlers assign without a cast, and
 * the engine's generic call site stays safe because it passes the
 * matching `when.<name>` value straight through to the handler
 * (the handler already validates its own arg shape).
 *
 * Prefer this alias at any `Record<string, PredicateHandler<…>>`
 * boundary where the value shape is per-key heterogeneous.
 *
 * ## Write-through registry slot, not a safe read type
 *
 * This alias exists so heterogeneous handler maps accept typed
 * handlers cast-free on the WRITE side (plugin author stuffs a
 * `PredicateHandler<FooArgs>` into `Plugin.predicates`). On the READ
 * side (a consumer iterating `plugin.predicates`, or a decorator /
 * middleware layering over a plugin's handlers) the retrieved value
 * carries `args: any` — no compile-time narrowing. Consumers that
 * want typed reads should narrow back to `PredicateHandler<TArgs>`
 * at their call site.
 *
 * ## Handler authors: declare `PredicateHandler<YourArgs>`, not this
 *
 * Do NOT use `AnyPredicateHandler` as the type annotation for a
 * handler declaration:
 *
 *   // wrong — `args` is `any`, no narrowing inside the body.
 *   const myHandler: AnyPredicateHandler = (args, ctx) => { ... };
 *
 *   // right — narrow `args` at the declaration; the result still
 *   // assigns cast-free into `Plugin.predicates`.
 *   const myHandler: PredicateHandler<MyArgs> = (args, ctx) => { ... };
 *
 * Also note: because `any` at the boundary disables compile-time
 * narrowing on the engine's CALL site too, typed handlers MUST
 * still validate their own `args` shape at the top of the function
 * body. The engine passes the verbatim `when.<name>` value, so TS
 * can't protect you from a user writing
 * `when: { myPredicate: "not-the-shape-you-expected" }`.
 * (See `isClean`'s `if (typeof args !== "boolean") return false`
 * pattern for the canonical guard.)
 */
export type AnyPredicateHandler = PredicateHandler<any>;

// ---------------------------------------------------------------------------
// When clause
// ---------------------------------------------------------------------------

/**
 * Legacy v0.0.x predicate block; see {@link TopLevelWhenClause} for
 * the authoring surface attached to {@link Rule.when}.
 *
 * The legacy interface is retained as an internal type for the JSON
 * v1→v2 path in `compat.ts`, where the loose `[customKey: string]:
 * unknown` index signature is needed to accept arbitrary plugin keys
 * during deserialization. Plugin authors should NOT type their
 * helpers against `WhenClause` — use {@link TopLevelWhenClause} for
 * outer when-clauses or {@link TopLevelWhenClauseNoRecurse} for
 * not-block bodies (both are registry-driven and enforce the
 * five compile-time constraints documented on {@link BaseRule.when}).
 *
 * Note: even though this legacy interface permits `not: { not: ... }`
 * recursion at the type level, the engine's runtime
 * `validateWhenClauseShape` rejects nested-`not` shapes at
 * `buildEvaluator` time. Authors smuggling depth-2 recursion through
 * JSON v1 / `as any` casts hit the runtime guard, not silent
 * acceptance.
 *
 * @deprecated Internal v1-compat type. Use {@link TopLevelWhenClause}
 *             at authoring sites; this interface is preserved only
 *             for the JSON v1→v2 conversion path in `compat.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated
export interface WhenClause<Writes extends string = string> {
  /**
   * @deprecated Use {@link TopLevelWhenClause}'s `cwd?:` leaf (lifted
   *             onto {@link BuiltInWhenLeaves}). Retained for v1
   *             JSON→v2 conversion compatibility only.
   * @see BuiltInWhenLeaves.cwd
   */
  cwd?:
    | Pattern
    | Pattern[]
    | { pattern: Pattern | Pattern[]; onUnknown?: "allow" | "block" };

  /**
   * @deprecated Use {@link TopLevelWhenClause}'s `missing?:` leaf
   *             (lifted onto {@link BuiltInWhenLeaves}). Retained for
   *             v1 JSON→v2 conversion compatibility only.
   * @see BuiltInWhenLeaves.missing for the canonical semantics
   *      (scopes, `since`, `notIn`, runtime errors).
   */
  missing?: {
    event: Writes;
    in: "agent_loop" | "session" | "tool_call";
    since?: Writes;
    notIn?: "agent_loop" | "session" | "tool_call";
  };

  /**
   * @deprecated Use {@link TopLevelWhenClause}'s `not?:` operator field.
   */
  not?: WhenClause<Writes>;

  /**
   * @deprecated Use {@link TopLevelWhenClause}'s `condition?:` leaf
   *             (lifted onto {@link BuiltInWhenLeaves}). Retained for
   *             v1 JSON→v2 conversion compatibility only.
   * @see BuiltInWhenLeaves.condition
   */
  condition?: PredicateFn;

  /**
   * @deprecated v1-compat loose index signature — plugin-registered
   *             predicates now live on {@link PiSteeringPredicates}
   *             with per-key compile-time typing via
   *             {@link OuterValue} / {@link InnerValue}. Retained for
   *             v1 JSON→v2 conversion compatibility only.
   */
  [customKey: string]:
    | Pattern
    | Pattern[]
    | PredicateFn
    | WhenClause
    | { pattern: Pattern; onUnknown?: "allow" | "block" }
    | { pattern: Pattern | Pattern[]; onUnknown?: "allow" | "block" }
    | unknown;
}

// ---------------------------------------------------------------------------
// Rule (discriminated union by `tool`)
// ---------------------------------------------------------------------------

/**
 * Fields common to every tool-specific rule variant.
 *
 * `BaseRule` is the shared slice - everything except the `tool`
 * discriminant, the bash {@link BashRule.command} first filter, and
 * the tool-specific {@link WriteRule.field} / {@link EditRule.field}
 * sub-unions. The exported user-facing type is {@link Rule}, the discriminated union
 * over the three tool variants; authors should reach for `Rule`
 * unless they're writing generic rule-handling code that already
 * knows the tool at its call site.
 *
 * Generic parameter `ObsName` constrains the string form of the
 * {@link observer} field. {@link defineConfig} threads through the union
 * of observer names gathered from plugins + inline observers, producing
 * compile-time errors on typos. When authoring rules outside
 * `defineConfig` (with plain `satisfies SteeringConfig`), the default
 * `string` flows through and cross-reference checking is skipped.
 *
 * See ADR "Design → Rule schema".
 */
export interface BaseRule<
  ObsName extends string = string,
  Writes extends string = string,
> {
  /** Unique rule identifier. Used in override comments and audit logs. */
  name: string;

  /**
   * Main match predicate (write / edit rules only — bash rules route
   * on {@link BashRule.command} and carry no `pattern`). See
   * {@link Pattern}. The rule fires only if this matches the chosen
   * `field` value.
   */
  pattern: Pattern;

  /**
   * Optional extra AND predicate - when provided, the rule fires
   * only if this also matches. Accepts a pattern or a function so
   * plugins can layer structured checks on top of the main match.
   */
  requires?: Pattern | PredicateFn;

  /**
   * Exemption predicate - when provided and matches, the rule does
   * NOT fire. Same shape choice as {@link requires}.
   */
  unless?: Pattern | PredicateFn;

  /**
   * Composable predicate block. All leaves present in this block are
   * ANDed — the clause fires only when every leaf fires. An
   * empty/undefined clause trivially matches (the rule fires
   * regardless of `when:`). `not:` wraps ONE inner clause and inverts
   * its verdict (single level; no recursion). See
   * {@link TopLevelWhenClause}.
   *
   * `Writes` is the union of session-entry event literals the rule's
   * `when.missing.event` is allowed to reference. Threaded through by
   * {@link defineConfig} from all declared `writes` arrays in scope.
   *
   * The five compile-time constraints from the not-block onUnknown
   * design land here:
   *   1. Each plugin-registered predicate is shape-checked against
   *      its `PiSteeringPredicates[K]` registry entry (bare /
   *      spreadBase). Typos / unknown predicates surface as
   *      compile errors at the rule definition.
   *   2. Reserved keys (`not`, `onUnknown`, plus future modifiers)
   *      are dropped from the registry-driven mapped type via
   *      {@link PluginPredicateKey} so a plugin author can't shadow
   *      the operator/modifier surface.
   *   3. Leaf-level `onUnknown:` inside `not:` is forbidden (the
   *      inner mapped type uses {@link InnerValue} which excludes
   *      modifiers — those live at the not-block top level).
   *   4. `not: not:` recursion is forbidden
   *      ({@link TopLevelWhenClauseNoRecurse} has no `not?:` field).
   *      Belt-and-suspenders runtime guard in
   *      {@link validateWhenClauseShape} catches JSON / `as any`
   *      escape hatches.
   *   5. Rule-level `onUnknown:` is forbidden
   *      ({@link TopLevelWhenClause} doesn't intersect with
   *      {@link PredicateModifiers}; only the inner `not:` body does).
   */
  when?: TopLevelWhenClause<Writes>;

  /**
   * Message shown to the agent when blocked.
   *
   * A plain string is the most common shape and should be actionable
   * (e.g. "Use `git commit --no-verify` to bypass"). The evaluator
   * prefixes every block reason with `[steering:<rule>@<source>] `
   * so the agent sees which rule fired and where it came from
   * (ADR §11). The engine prepends a fixed preamble —
   * "This tool call was not executed; blocked by a steering rule:"
   * (`BLOCK_REASON_PREAMBLE`) — before the tag, so the message
   * always states the tool call never executed (issue #85); the
   * engine-error path uses a distinct preamble
   * (`ENGINE_ERROR_PREAMBLE`).
   *
   * A {@link ReasonFn} is invoked with the same
   * {@link PredicateContext} the predicates saw. Use the function
   * form when the reason text depends on runtime state - e.g. the
   * walker's effective cwd, a resolved branch name, or a count
   * pulled from `ctx.findEntries`. The evaluator awaits the return
   * and applies the source-tag prefix identically to the string form.
   *
   * Note: the emitted block reason is the preamble
   * ("This tool call was not executed; blocked by a steering
   * rule:", `BLOCK_REASON_PREAMBLE`) + `\n\n` + this source-tagged
   * text (issue #85).
   *
   * Fail-safe on throw: if the reason function throws synchronously
   * or its returned promise rejects, the evaluator logs the error
   * with `console.warn` and emits a fallback message
   * (preamble + `[steering:<rule>@<source>] (reason failed to
   * format; see log)` — same `BLOCK_REASON_PREAMBLE` prefix as any
   * other rule-fired reason).
   * The block verdict still lands - a broken reason doesn't release
   * the rule's guard or leak raw error text to the LLM.
   *
   * Tag→body separator is paragraph-aware: a body containing `\n\n`
   * (or its CRLF equivalent `\r\n\r\n`, defensive against bodies
   * imported from Windows line-ending sources — CRLF templating
   * layers, hand-typed Windows-IDE strings) renders with the
   * `[steering:...]` tag on its own line followed by a paragraph
   * break (`\n\n`); otherwise the tag and body share a single
   * space-separated line. The trigger is double-newline
   * specifically — single `\n` characters inside an otherwise
   * single-paragraph body keep the single-space layout. The emitted
   * separator is always normalized to `\n\n` regardless of which
   * form (`\n\n` or `\r\n\r\n`) triggered it. Multi-paragraph
   * reasons get the prefix-on-its-own-line layout automatically
   * without the rule author managing leading whitespace.
   *
   * Body→override-hint separator mirrors the same paragraph-aware
   * rule. Single-paragraph bodies keep a single-space prefix on the
   * override hint (byte-identical to the pre-paragraph-aware
   * rendering); multi-paragraph bodies promote the override hint
   * to its own paragraph (`${body}\n\n${hint}`) so a safety
   * paragraph stays visually standalone rather than running on
   * into an inline "To override" sentence.
   */
  reason: string | ReasonFn;

  /**
   * If `true`, no override escape hatch. If `false`, override always
   * allowed. Omitted: falls back to
   * {@link SteeringConfig.defaultNoOverride} (defaults to `true` -
   * fail-closed).
   */
  noOverride?: boolean;

  /**
   * Observer to attach to this rule. The observer fires on matching
   * `tool_result` events and can record per-turn state the rule
   * consults via {@link PredicateContext.findEntries}.
   *
   * Either an inline {@link Observer} or a string referencing an
   * observer registered on a plugin or at the config's top level.
   * String references are constrained to the union of observer names
   * known at {@link defineConfig} call sites (typo → compile error).
   */
  observer?: Observer | ObsName;

  /**
   * Session-entry custom types this rule's {@link onFire} may write.
   *
   * **Compile-time effect (via {@link defineConfig}):** the union of
   * all `writes` literals declared across plugin rules, plugin
   * observers, user rules, and user observers constrains the `event`
   * field of every {@link BuiltInWhenLeavesOuter.missing} inside the same config.
   * Declaring a write here makes it referenceable from
   * `when.missing.event` anywhere in that config; omitting it leaves
   * the string out of the union and downstream references to it are
   * rejected as typos.
   *
   * **Authoring pattern.** Enforcement depends on TypeScript preserving
   * the literal types of your `writes` arrays. Use one of:
   *   - `as const satisfies Rule` on a rule object literal, OR
   *   - `const satisfies Rule` on an object literal, OR
   *   - declaring the rule INSIDE the `defineConfig({ rules: [...] })`
   *     call so inference flows directly through the `const P`, `const R`
   *     generics.
   *
   * **Footgun: bare `: Rule` / `: Observer` / `: Plugin` annotations
   * widen the literal `writes` array to `readonly string[]`. The engine
   * can no longer project string-literal members, so `AllWrites`
   * collapses to `never` - meaning EVERY `when.missing.event`
   * reference in the config is rejected as a typo, not silently
   * accepted.
   *
   * **Runtime effect:** none. `writes` is purely documentation +
   * type-level plumbing - the engine does NOT verify that `onFire`
   * only calls `ctx.appendEntry` with declared types.
   *
   * **Opt-out:** authors who build their config via
   * `satisfies SteeringConfig` instead of `defineConfig` lose the
   * compile-time check - the `SteeringConfig` shape defaults the
   * {@link Rule} generics to `string`, so `when.missing.event` is
   * unconstrained. `defineConfig` is the entry point that enforces.
   *
   * The wider warning - "name" / "plugin" literals widening to
   * `string` - causes the opposite failure: typos in `disabledRules`
   * / `disabledPlugins` start compiling silently. Always use
   * `as const satisfies` for reusable constants.
   */
  writes?: readonly string[];

  /**
   * Side-effect hook invoked when the rule decides to fire (all
   * predicates passed) and BEFORE the block verdict is returned.
   *
   * Use for self-marking patterns where the rule's fire IS the event
   * (e.g. `cr-description-check` - first attempt per agent loop blocks
   * as reminder, self-marks via `onFire` so subsequent attempts pass).
   * Anything written via `ctx.appendEntry` gets auto-tagged with the
   * current `_agentLoopIndex` so a follow-up `when.missing:
   * { in: "agent_loop" }` check can detect it.
   *
   * Timing guarantees:
   *   - Runs after the tool filter (`command:` on bash, `pattern:`
   *     on write/edit) / `requires` / `unless` / `when` have all
   *     evaluated favourably. If `when.cwd` or any other predicate
   *     fails, the rule doesn't fire and `onFire` doesn't run.
   *   - Runs for rules that will actually BLOCK. Rules suppressed by an
   *     inline override comment do NOT trigger `onFire` - the agent
   *     overrode the rule, so its side effects are bypassed too.
   *   - Fail-closed rules (noOverride omitted or true) ignore override
   *     comments entirely, so `onFire` runs on every fire even when
   *     the agent wrote an override comment the engine rejected.
   *
   * Error handling: `onFire` is a best-effort side effect. If it
   * throws (sync) or its returned promise rejects, the engine logs
   * the error with `console.warn` and proceeds to return the block
   * verdict. The block is not affected by an `onFire` failure - the
   * block decision already passed every predicate, and a broken
   * self-mark must not invalidate it. Mirrors the observer
   * dispatcher's per-observer isolation.
   *
   * Async OK: the evaluator awaits.
   */
  onFire?: (ctx: PredicateContext) => void | Promise<void>;
}

/**
 * Union of CLI basenames declared by a `plugins` tuple (issue #117).
 *
 * Projects `keyof` each plugin's `cliDescriptors` map across the tuple —
 * the same tuple-walking shape as {@link AllRuleNames} (see
 * `define-config.ts`), but over descriptor keys instead of rule names.
 * `defineConfig` threads this through as the `Cmd` parameter of
 * {@link BashRule}, so `command: "gti"` (undeclared) is a compile
 * error while declared basenames (plugin-shipped + inline-literal
 * `cliDescriptors` keys in the same `plugins:` tuple) are accepted.
 *
 * Widening escape (same caveat family as the exemption universe): a
 * bare `: Plugin` annotation widens `cliDescriptors` to
 * `Record<string, CLIDescriptor>`, whose key union is `string` — the
 * constraint goes permissive ("can't verify" means "skip", never a
 * false-positive). The runtime backstop (the fail-closed
 * rule-tagged `MissingDescriptorError` block on the first MATCHED
 * evaluation, naming the missing-descriptor remedy) covers the
 * widened path.
 *
 * Defaults to the unconstrained (`string`) form when no facts exist:
 * no type argument, an empty tuple, or a tuple where no plugin
 * declares `cliDescriptors` all mean "can't verify" → skip (never a
 * false-positive). The runtime backstop (the fail-closed
 * rule-tagged `MissingDescriptorError` block on the first MATCHED
 * evaluation, naming the missing-descriptor remedy) covers those
 * paths — so a descriptor-less config still fails LOUD, never
 * silent. Strict (typo-killing) exactly when the tuple contributes
 * ≥1 descriptor key.
 */
type PluginBasenames<PL> = PL extends Plugin
  ? PL["cliDescriptors"] extends infer D
    ? [D] extends [undefined]
      ? never
      : Extract<keyof NonNullable<D>, string>
    : never
  : never;

type BasenameWalk<P extends readonly Plugin[]> = P extends readonly [
  infer First,
  ...infer Rest,
]
  ?
      | PluginBasenames<First>
      | (Rest extends readonly Plugin[] ? BasenameWalk<Rest> : never)
  : never;

export type Basename<P extends readonly Plugin[] = never> = [P] extends [never]
  ? string
  : [BasenameWalk<P>] extends [never]
    ? string
    : BasenameWalk<P>;

/**
 * Bash rule: gates pi's `bash` tool.
 *
 * Routing is the required `command:` first filter (issue #117) —
 * exact basename equality vs the walker-ref basename, never regex,
 * never substring. `field:` is gone from this variant (every bash
 * rule tested the same `"command"` slot; the redundancy is dropped
 * and its absence is tsc-enforced), and so is `pattern:` (its whole
 * mechanism — write / edit rules keep `tool` / `field` / `pattern`
 * untouched; `pattern` remains their matching surface).
 *
 * Wrapper-transparent structurally: `sh -c 'git push'`,
 * `/usr/bin/git`, `git -C /x` match (the ref sees inner commands);
 * `echo 'git push'` doesn't (opaque string arg). Nameless refs
 * (bare `VAR=x` chains — no binary) never match.
 *
 * Inside a rule's predicates / `onFire`, the context exposes the
 * extracted command plus `args` (quote-aware `Word[]`) and
 * `basename` - those are populated per-ref by the evaluator, not by
 * the rule author.
 */
export type BashRule<
  ObsName extends string = string,
  Writes extends string = string,
  Cmd extends string = string,
> = Omit<BaseRule<ObsName, Writes>, "pattern"> & {
  tool: "bash";
  /**
   * Exact basename first filter (issue #117) — routing, not matching.
   *
   * Required. Absorbs the old `field: "command"` (dropped as
   * redundant — tsc rejects `field` on bash rules).
   *
   * Singular key, union type (schema's dominant `X | X[]` idiom): a
   * single {@link Basename} or a `readonly` array of them (plain OR —
   * one name = one `disabledRules` / exemption / override entry, NOT
   * shared leaves; leaves stay per-ref AND under arrays, and a leaf
   * meaningless for a binary never fires its refs). An empty array
   * never matches (mirrors the empty-`anyOf` invalid rule). One
   * basename per entry — `"git commit"` (whitespace) is rejected at
   * evaluator build.
   *
   * At `defineConfig` sites `Cmd` narrows to the descriptor-key
   * union across the `plugins` tuple (plugin-shipped +
   * inline-literal `cliDescriptors` keys), so `command: "gti"` is a
   * compile error — the silent never-fire typo class is dead. Three
   * inherited caveats (same as the exemption universe): widened
   * `: Plugin` skips (runtime loud-throw backstop covers),
   * per-file universes can false-positive across layers, plain
   * `satisfies` escapes. Routing to a binary requires its facts:
   * declare the plugin that ships its `cliDescriptors`.
   */
  command: Cmd | readonly Cmd[];
};

/**
 * Write rule: gates pi's `write` tool (whole-file writes).
 *
 * `field` picks the input slot the {@link pattern} tests against:
 *   - `"path"`    - the target path (regex-gate paths a file may be
 *                  written to).
 *   - `"content"` - the full file contents the agent is writing.
 */
export interface WriteRule<
  ObsName extends string = string,
  Writes extends string = string,
> extends BaseRule<ObsName, Writes> {
  tool: "write";
  field: "path" | "content";
}

/**
 * Edit rule: gates pi's `edit` tool (targeted oldText/newText patches).
 *
 * `field` picks the input slot the {@link pattern} tests against:
 *   - `"path"`    - the target path.
 *   - `"content"` - the concatenated `newText` of every edit in the
 *                  tool call (evaluator joins with `\n`). This mirrors
 *                  `write.content` so authors can use one rule class
 *                  for both file surfaces.
 */
export interface EditRule<
  ObsName extends string = string,
  Writes extends string = string,
> extends BaseRule<ObsName, Writes> {
  tool: "edit";
  field: "path" | "content";
}

/**
 * A single steering rule - discriminated union over the three
 * gatable tools. The `tool` discriminant determines the rule shape:
 * bash rules route on the required `command:` first filter (exact
 * basename equality) with `when:` leaves for the rest; write / edit
 * rules test `field` (`"path"` or `"content"`) against `pattern:`.
 * Invalid combinations (`{ tool: "write", field: "command" }`,
 * `pattern:` on a bash rule, `field:` on a bash rule, ...) are TS
 * errors.
 *
 * Shape refinements vs. v1:
 *   - Bash: `command: Basename | readonly Basename[]` (required,
 *     exact equality); no `field`, no `pattern`.
 *   - Write/edit: `pattern` accepts `RegExp` in addition to `string`.
 *   - `requires` / `unless` accept `Pattern | PredicateFn` (Patterns
 *     kept transiently — see the retirement note in the README).
 *   - `when` is a {@link TopLevelWhenClause} — registry-driven
 *     mapped type with one level of `not:` allowed (no nested
 *     `not: not: ...`).
 *   - `observer` references an {@link Observer} by name (string) or
 *     inline definition.
 *   - `Rule` is a discriminated union by `tool`.
 *
 * See ADR "Design → Rule schema".
 */
export type Rule<
  ObsName extends string = string,
  Writes extends string = string,
  Cmd extends string = string,
> =
  | BashRule<ObsName, Writes, Cmd>
  | WriteRule<ObsName, Writes>
  | EditRule<ObsName, Writes>;

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Filter applied to `tool_result` events before {@link Observer.onResult}
 * runs. Omitted: the observer fires on every result the engine sees.
 *
 * See ADR "Design → Observer schema".
 */
export interface ObserverWatch {
  /**
   * Only fire on results from this tool. Use to narrow observers that
   * only care about a specific tool surface (e.g. `read` results).
   */
  toolName?: "bash" | "read" | "write" | "edit" | (string & {});

  /**
   * Per-field regex constraints on the tool INPUT. Observer fires only
   * when every listed field matches. Keys are tool-input field names
   * (e.g. `path` for `read`, `command` for `bash`).
   */
  inputMatches?: Record<string, Pattern>;

  /**
   * Constrain by tool exit-code / success-failure classification.
   *   - `"success"` / `"failure"` - string classification
   *   - `number`                  - exact exit code match (bash)
   *   - `"any"`                   - explicit no-filter
   */
  exitCode?: number | "success" | "failure" | "any";
}

/**
 * Context passed to an observer's {@link Observer.onResult} callback.
 *
 * See ADR "Design → Observer schema".
 */
export interface ObserverContext {
  /** Session cwd at the time the tool_result arrived. */
  cwd: string;

  /**
   * Monotonically-increasing agent-loop counter maintained by the
   * engine. Bumped on each `agent_start` pi event (one agent loop =
   * one user prompt + its tool calls). Observers writing session
   * entries get this tag auto-injected into the payload so rules
   * using `when.missing` with `in: "agent_loop"` can filter by it.
   */
  agentLoopIndex: number;

  /**
   * Append a typed entry into pi's session JSONL. Observers
   * typically use this to record "the agent did X in turn N" so
   * later predicates can gate on it via
   * {@link PredicateContext.findEntries}.
   */
  appendEntry: <T>(customType: string, data?: T) => void;

  /**
   * Read all prior typed entries of the given custom type from pi's
   * session JSONL. Handy for observers that need to coalesce state
   * across turns (e.g. "has the agent read the CR description yet?").
   */
  findEntries: <T>(customType: string) => Array<{ data: T; timestamp: number }>;
}

/**
 * A reactive hook: runs on `tool_result` events, typically to record
 * per-turn state for later predicates to consult.
 *
 * Observers are named + deduped (first-registered wins; later
 * declarations log a WARN). A rule may reference an observer by name
 * via {@link Rule.observer}, letting plugins ship reusable observers
 * and multiple rules share a single entry-producing observer.
 *
 * See ADR "Design → Observer schema" and "Precedence: first-wins
 * everywhere".
 */
export interface Observer {
  /**
   * Unique name. Used for dedup across plugins + inline observers.
   * Referenced from {@link Rule.observer} as a string.
   */
  name: string;

  /**
   * Session-entry custom types this observer's {@link onResult} may
   * write.
   *
   * **Compile-time effect (via {@link defineConfig}):** the union of
   * all `writes` literals declared across plugin rules, plugin
   * observers, user rules, and user observers constrains the `event`
   * field of every {@link BuiltInWhenLeavesOuter.missing} inside the same config.
   * Declaring a write here makes it referenceable from
   * `when.missing.event` anywhere in that config; omitting it leaves
   * the string out of the union and downstream references to it are
   * rejected as typos.
   *
   * **Authoring pattern.** See {@link Rule.writes} for the full
   * footgun note - TL;DR: use `as const satisfies Observer` on
   * reusable observer constants, or declare them inline inside
   * `defineConfig({ observers: [...] })`. Bare `: Observer` annotations
   * widen `writes` to `readonly string[]` and collapse `AllWrites` to
   * `never`, rejecting every `when.missing.event` reference.
   *
   * **Runtime effect:** none. `writes` is purely documentation +
   * type-level plumbing - the engine does NOT verify that `onResult`
   * only calls `ctx.appendEntry` with declared types.
   *
   * **Opt-out:** authors who build their config via
   * `satisfies SteeringConfig` instead of `defineConfig` lose the
   * compile-time check. `defineConfig` is the entry point that
   * enforces.
   */
  writes?: readonly string[];

  /**
   * Filter narrowing which tool_result events trigger this observer.
   * Omitted: every tool_result fires onResult.
   */
  watch?: ObserverWatch;

  /**
   * Called on every matching tool_result event. Typically writes an
   * entry via `ctx.appendEntry(customType, data)`; occasionally
   * performs side effects (logging). Must be idempotent - the same
   * event MAY fire the observer more than once across pi's
   * lifecycle (e.g. session restart mid-turn).
   */
  onResult: (
    event: ToolResultEvent,
    ctx: ObserverContext,
  ) => void | Promise<void>;
}

/**
 * Shape of a tool_result event as observed by an {@link Observer}.
 *
 * Intentionally minimal: the fields the schema commits to are the
 * ones every tool_result carries. Tool-specific `input` / `output`
 * fields are `unknown` here - observer authors cast to the known
 * shape for the tool they're watching.
 */
export interface ToolResultEvent {
  /** Tool name the result pertains to (e.g. `"bash"`, `"read"`). */
  toolName: string;
  /** Tool input as originally passed to the tool. Shape varies by tool. */
  input: unknown;
  /** Tool output / result payload. Shape varies by tool. */
  output: unknown;
  /** Exit code (bash) or undefined for non-command tools. */
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// Predicate context
// ---------------------------------------------------------------------------

/**
 * A bash suffix word as predicates see it: the {@link Word} shape
 * with the env-resolved runtime forms on `text` / `value` and the
 * original source on `rawText` (issue #51 — "resolved-by-default
 * Word.text — predicates validate what executes").
 *
 * Resolution is against the ref's env snapshot (`ctx.walkerState.env`
 * — the walker's per-ref env; same-ref prefix assignments are one-shot
 * for the direct child's env and do NOT bind for the same command's
 * word expansions, bash manual §3.7.1). Fail-closed: any word the
 * walker cannot resolve (absent `$VAR`, command substitution,
 * parameter-expansion modifiers, …) keeps its raw forms, so
 * predicates never pattern-match a fiction.
 */
export interface PredicateWord extends Word {
  /**
   * Original source token, exactly as written in the command
   * (`"$BODY"`, `<(perl … "$BODY")`). Escape hatch for the rare
   * consumer that genuinely matches variable names.
   */
  rawText: string;
}

/**
 * Tool input signature reduced to the fields a predicate may read.
 *
 * Predicates are tool-agnostic (the same predicate can gate bash, write,
 * or edit rules). `tool` tells the predicate which discriminator applies;
 * the evaluator populates whichever fields belong to that tool.
 *
 * Bash note (per ADR §9): `command`, `basename`, and `args` are
 * populated PER extracted command ref - a bash invocation of
 * `git push --force && ls` runs the predicate once per ref, with
 * `command: "git push --force"` (flattened `basename + args` string),
 * `basename: "git"`, and `args: [<PredicateWord>, <PredicateWord>]`
 * (suffix `PredicateWord[]` — see {@link PredicateWord}). `rawCommand`
 * and full AST node access are deliberately NOT exposed - the wrapper
 * context would be wrong for inner refs, and AST walking belongs in
 * plugin code that imports unbash-walker directly.
 */
export interface PredicateToolInput {
  tool: "bash" | "write" | "edit";
  /** bash: flattened `basename + args` string, per extracted ref. */
  command?: string;
  /**
   * bash: extracted ref basename (e.g. `"git"` for `/usr/bin/git`).
   * Sugar over `command.split(/\s+/)[0]` that handles path stripping
   * correctly. Undefined for non-bash tools.
   */
  basename?: string;
  /**
   * bash: suffix `PredicateWord[]` for the extracted ref - quote-aware
   * structured access where `text` / `value` carry the ENV-RESOLVED
   * runtime forms and {@link PredicateWord.rawText} exposes the
   * original source (issue #51). Prefer this over splitting `command`
   * when the predicate needs to preserve quoting (e.g. reading a
   * `-m "conventional: subject"` message without munging spaces).
   *
   * Resolution semantics (words match what the shell actually
   * executes):
   *   - `text` - TEXT-mode resolution (`resolveWordText`):
   *     quote-preserving — `"$BODY"` → `"/vault/…"` — recursing
   *     INTO process substitutions: `<(perl … "$BODY")` →
   *     `<(perl … "/vault/…")` (inner variables expand, quotes
   *     stay).
   *   - `value` - VALUE-mode resolution (`resolveWord`): the unquoted
   *     runtime value — `"$BODY"` → `/vault/…`. For process
   *     substitutions value-mode is unresolvable (the fd path is
   *     unknowable), so `value` stays the raw lexical token while
   *     `text` carries the expanded inner command.
   *   - `rawText` - the original source token, exactly as written.
   *   - `parts` - the RAW AST word-part structure, never resolved
   *     (plugins doing their own shell-grammar work parse this).
   *
   * Prefer reading flag values through the context-provided view
   * {@link PredicateContext.command} (`ctx.command.getFlagValue` /
   * `getAllFlagValues` / `hasFlag`) over scanning this array by hand —
   * the engine binds the facade to these words per ref, quote-aware.
   *
   * Fail-closed: any word the walker cannot resolve (absent `$VAR`,
   * command substitution, parameter-expansion modifiers, multi-command
   * process substitutions, …) stays raw — `text` falls back to the
   * source token and `value` to the lexical value — so predicates
   * never pattern-match a fiction.
   *
   * Sourced from `CommandRef.node.suffix` via unbash-walker and
   * projected per-ref against the ref's env snapshot
   * (`ctx.walkerState.env` — the walker's per-ref env; bash manual
   * §3.7.1 expands words against the PRE-command environment, so
   * same-ref prefix assignments do NOT bind here — they are one-shot
   * for the direct child's env only). Fail-closed: absent variables
   * stay raw — `BODY=/x gh … --body-file="$BODY"` keeps `"$BODY"`
   * verbatim (real bash would also expand it to the OLD value, or
   * empty when unset; this engine prefers the raw form so predicates
   * never match a fiction). Static words are byte-identical to the
   * pre-resolution surface. Undefined for non-bash tools.
   *
   * Rare consumer needing the genuine bash child-env (prefix applied
   * to the DIRECT child only): fold the assignments sequentially —
   * `new Map([...ctx.walkerState.env, ...resolveEach(envAssignments)])`
   * where `resolveEach` resolves each `KEY=VALUE`'s RHS against the
   * running map (bash RHS is sequential: `A=1 B=$A` → `B=1`) —
   * documented here, not exported.
   */
  args?: readonly PredicateWord[];
  /**
   * bash: shell env-assignment prefix for the extracted ref -
   * `AWS_PROFILE=dev aws s3 ls` exposes `[W("AWS_PROFILE=dev")]`
   * here (with `args` still `[W("s3"), W("ls")]`). Multiple
   * assignments come through in source order. Enables plugins to
   * inspect shell env vars via structured access instead of
   * regex-on-raw-command.
   *
   * Sourced from `CommandRef.node.prefix` via unbash-walker. Each
   * prefix element is projected into a `Word` whose `.text` preserves
   * the full `KEY=VALUE` source token (with quoting, if any);
   * consumers split on `=` to separate key from value. Dynamic
   * values like `A=$VAR` come through as-is - the token syntax is
   * visible in `.text`, so callers can detect the expansion
   * themselves.
   *
   * Always an empty array for `write` / `edit` tools (shell env
   * assignments don't apply to file-surface tools); shaped as
   * `[]` rather than `undefined` so plugin authors can treat the
   * field uniformly.
   */
  envAssignments?: readonly Word[];
  /** write / edit: the target path. */
  path?: string;
  /** write: the file content being written. */
  content?: string;
  /** edit: the replacement edits. Shape preserved from pi's edit tool. */
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

/**
 * Options forwarded to {@link PredicateContext.exec} - narrow surface
 * over child_process, scoped to the handful of knobs predicates need.
 */
export interface ExecOpts {
  /** Working directory. Defaults to the session cwd. */
  cwd?: string;
  /** Max runtime in ms. Predicates should cap this. */
  timeoutMs?: number;
}

/**
 * Return value of {@link PredicateContext.exec}.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Shape of the walker-state snapshot the evaluator populates on
 * {@link PredicateContext.walkerState} for bash rules. Consumed by
 * the built-in `when.cwd` / `when.missing` predicates and by
 * plugin-authored predicates that read per-ref tracker state.
 *
 * All fields are read-only. The evaluator assembles a fresh object
 * per extracted command ref - mutation has no effect on subsequent
 * refs or on any persisted state.
 *
 * The type is open-ended (`readonly [key: string]: unknown`) because
 * plugins register new trackers at config-build time; the schema
 * can't commit to the complete key set. Plugin authors documenting
 * their own predicates should narrow via their tracker's known
 * value type (e.g. the git plugin's branch predicate reads
 * `ctx.walkerState.branch` as a string | "unknown" sentinel).
 *
 * For `write` / `edit` rules there's no walker invocation and
 * {@link PredicateContext.walkerState} is `undefined`. Bash rules
 * always see at minimum `{ cwd, env, events }`.
 */
export interface WhenWalkerState {
  /**
   * Effective cwd at this ref, per the walker's `cwdTracker`. For
   * dynamic cd targets the walker couldn't resolve statically
   * (unknown `$VAR`, command substitution, arithmetic), this is the
   * literal string `"unknown"` - the cwdTracker's sentinel. The
   * built-in `when.cwd` predicate applies its `onUnknown: 'allow' |
   * 'block'` policy on that sentinel (default `'block'`, fail-
   * closed). Plugin predicates reading this field directly should
   * check for the sentinel before pattern-matching, or use the
   * sugar form `when.cwd: { pattern, onUnknown }` via the engine.
   */
  readonly cwd: string;

  /**
   * Env map at this ref, per the walker's `envTracker`. Carries
   * statically-resolved bare assignments (`FOO=bar`), `export`
   * writes, and `unset` deletions from the current scope, seeded
   * from `process.env.{HOME, USER, PWD}` at tracker initialization.
   * Prefix assignments (`NAME=value cmd …`) are one-shot for the
   * direct child's env and do NOT appear here; words in
   * `ctx.input.args` / `ctx.input.command` resolve against this
   * snapshot (bash manual §3.7.1).
   *
   * Plugin predicates consume this to expand `$VAR` / `~` in
   * user-supplied patterns, or to implement a `when.envVar`-style
   * predicate. Read via `ctx.walkerState.env.get("NAME")`. Returns
   * `undefined` for any name the walker hasn't seen - callers apply
   * their own fallback (or route through the `resolveWord` helper
   * re-exported from the package root for word-level resolution).
   */
  readonly env: EnvState;

  /**
   * Additional tracker-registered fields (e.g. the git plugin's
   * `branch`) and reserved keys (`events`). Indexed loosely so
   * plugins adding new trackers don't need a schema amendment.
   */
  readonly [key: string]: unknown;
}

/**
 * Context passed to a predicate (either {@link PredicateFn} or a
 * plugin's {@link PredicateHandler}).
 *
 * Rationale per ADR "Design → Predicate context":
 *   - `cwd`, `tool`, `input` - what the agent is about to do.
 *   - `agentLoopIndex` - engine-maintained counter bumped on each
 *     pi `agent_start` event (one agent loop = one user prompt + its
 *     tool calls). Rules gate "since the user's last message" state
 *     by comparing entries' auto-tagged `_agentLoopIndex` against
 *     `ctx.agentLoopIndex`, which is what `when.missing` with
 *     `in: "agent_loop"` does internally.
 *   - `exec` - shell escape hatch. The evaluator memoizes results per
 *     `(cmd, args, cwd)` within a single tool_call; no cross-call cache.
 *     This schema commits to the TYPE only - memoization is the
 *     evaluator's concern (Phase 3).
 *   - `appendEntry` / `findEntries` - pi's session JSONL mirror of
 *     what observers write. Predicates consult prior entries to
 *     implement turn-state checks.
 */
export interface PredicateContext {
  /** Session cwd (or, for bash rules, the effective cwd of the command). */
  cwd: string;

  /** Which pi tool is being gated. */
  tool: "bash" | "write" | "edit";

  /** Tool input - evaluator populates whichever fields apply to `tool`. */
  input: PredicateToolInput;

  /**
   * Context-provided command view (issue #101), bound per ref to the
   * already-parsed `input.args` + `input.envAssignments` by the engine
   * (and by `mockContext` in tests) — rule code reads flags through
   * this instead of threading bare `Word[]` arrays by hand:
   * `hasFlag` / `getFlagValue` (last-wins) / `getAllFlagValues` (argv
   * order) / `hasEnvAssignment` / `isInfoOnly`. Never lex strings to
   * feed it — the walker already parsed the command.
   */
  command: SteeringCommand;

  /**
   * Engine-maintained agent-loop counter (bumped on each pi
   * `agent_start` event). See {@link ObserverContext.agentLoopIndex}.
   */
  agentLoopIndex: number;

  /**
   * Run a command and return its result. Memoized by the evaluator
   * per `(cmd, args, cwd)` within a single tool_call evaluation.
   *
   * Stability guarantee: across rules evaluated for the SAME
   * tool_call, identical `(cmd, args, cwd)` tuples return the same
   * ExecResult without re-executing. Across tool_calls, no cache -
   * the world can change between turns.
   */
  exec: (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

  /**
   * Append a typed entry into pi's session JSONL. Parallels
   * {@link ObserverContext.appendEntry} so predicates can record
   * decisions (though typically writing is an observer's job).
   */
  appendEntry: <T>(customType: string, data?: T) => void;

  /**
   * Read all prior typed entries of the given custom type. Used for
   * turn-state predicates.
   */
  findEntries: <T>(customType: string) => Array<{ data: T; timestamp: number }>;

  /**
   * Walker state snapshot for the command being evaluated. Populated
   * only for bash rules - the walker runs once per tool_call over the
   * full command and produces a per-ref snapshot of every registered
   * tracker (`cwd`, `env`, plus plugin-registered dimensions like
   * `branch`). For `write` / `edit` rules there is no walker, so this
   * is `undefined`.
   *
   * Plugin predicates consult `walkerState[<tracker-name>]` to read
   * statically-resolved values (branch after `git checkout X`, cwd
   * after `cd /path`, env after `FOO=bar` / `export FOO=bar`) without
   * re-running the tracker's work. When the tracker can't resolve
   * statically the value is the tracker's `unknown` sentinel -
   * handlers apply their `onUnknown` policy.
   *
   * Typed as {@link WhenWalkerState} (open-ended string-indexed) so
   * the schema commits to the two built-in keys (`cwd`, `env`) plus
   * the reserved `events` slot while leaving room for plugin
   * extensions.
   *
   * Reserved key `events`: `Record<customType, SyntheticEntry[]>`.
   * Populated by the walker-level speculative-entry synthesis pass
   * (see `evaluator-internals/speculative-synthesis.ts`). Carries
   * per-ref speculative entries representing "events about to happen"
   * via continuous `&&` chains from observers' `writes:` declarations.
   * Each entry carries a `{ data, timestamp, speculative: true }`
   * shape; timestamps are in a reserved range (above any real entry)
   * monotonic in AST order. The built-in `when.missing` predicate
   * merges these with real entries via timestamp comparison;
   * plugin-authored predicates can opt out by filtering
   * `e.speculative === true`. Trackers cannot claim the `events`
   * key - plugin registration rejects it as reserved.
   */
  walkerState?: Readonly<WhenWalkerState>;
}

// ---------------------------------------------------------------------------
// Exemption
// ---------------------------------------------------------------------------

/**
 * A carve-out for a guard rule: when the given `when` clause MATCHES,
 * the target rule does NOT fire — evaluation continues to the next
 * rule exactly as if the target had missed.
 *
 * Exemptions are the name-keyed registry mechanism for narrowing
 * guard rules (e.g. the git plugin's `no-main-commit`) WITHOUT
 * copying or replacing them:
 *
 *   - **Accumulation, not replacement.** Exemptions attach by target
 *     name to whichever rule wins that name after `disabledRules`
 *     filtering — the winning rule's body doesn't matter, only its
 *     name. Config-layer exemptions union across layers (no
 *     inner-wins), and plugin-shipped exemptions stack with config
 *     exemptions. Multiple exemptions for the same rule are OR-ed:
 *     ANY matching clause prevents the rule from firing.
 *   - **Duplicates are idempotent.** There is no collision concept;
 *     the same carve-out declared twice is harmless.
 *   - **Fail-closed is STRICT — no escape hatch.** Exemption clauses
 *     evaluate with an "allow"-default projection — a predicate that
 *     can't resolve (walker-unknown cwd, throwing handler,
 *     unregistered predicate key) counts as "does not match", so the
 *     guard still fires. This is the OPPOSITE default from rule
 *     `when:` clauses, which project unknown to "match" (fail-closed
 *     for rules = fire); see the evaluator's exemption path and `S1`
 *     in INVARIANTS.md. `onUnknown` is forbidden ANYWHERE in an
 *     exemption clause: {@link ExemptionWhenClause} strips the
 *     modifier at the type level (compile error),
 *     `validateExemptionWhenClauseShape` rejects a smuggled
 *     `onUnknown` at load time, and evaluation ignores explicit
 *     modifiers regardless (hard "allow" projection). Unknown
 *     handling is a policy of the target rule — an exemption can
 *     never opt back into unknown-exempts.
 *
 * Distinct from {@link Rule.unless} (a per-rule, same-rule-scope
 * optional exemption field) and from {@link Rule.when.not} (boolean
 * negation of a sub-clause): the registry is the cross-plugin
 * ACCUMULATION mechanism. See the README "Exemptions" section.
 *
 * `Writes` is the union of session-entry event literals the clause's
 * `when.missing.event` is allowed to reference — threaded through by
 * {@link defineConfig} identically to {@link Rule.when}.
 * `RuleName` is the compile-time rule-name union the target is
 * typo-checked against inside {@link defineConfig}; both default to
 * `string` outside it (no check skipped at the schema level).
 */
export interface Exemption<
  Writes extends string = string,
  RuleName extends string = string,
> {
  /**
   * Target rule name — the rule this exemption carves out. Typo-
   * checked against the `AllRuleNames` union inside
   * {@link defineConfig}; plain `string` at schema level. An
   * exemption targeting a rule name that doesn't exist in the final
   * merged rule universe surfaces an `exemption-orphan` diagnostic —
   * warning-class when written in config (strict mode throws),
   * error-class when shipped by a plugin (the runtime always throws
   * regardless of `failOnWarnings`, the CLI exits 1); a target that
   * exists but is disabled is inert, silent, and NOT orphaned.
   * (Plugin-shipped exemptions get the same universe, cross-checked
   * from the `plugins` tuple — see {@link Plugin.exemptions}.)
   */
  rule: RuleName;

  /**
   * Clause that, when it MATCHES, prevents the target rule from
   * firing. Evaluated with the fail-closed "allow"-default
   * projection (unknown → does not match → guard still fires);
   * typed as {@link ExemptionWhenClause} so `onUnknown` cannot be
   * written anywhere in the clause (compile error).
   */
  when: ExemptionWhenClause<Writes>;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * A plugin - distribution unit for rule packs and extension points.
 *
 * Plugins register zero or more of:
 *   - {@link predicates}        - new `when.<key>` slots
 *   - {@link rules}             - bundled rules users can enable/disable
 *   - {@link observers}         - reusable observer definitions
 *   - {@link trackers}          - new walker state dimensions
 *   - {@link trackerExtensions} - modifiers for existing trackers
 *
 * See ADR "Design → Plugin schema". Plugin loading precedence is
 * "first-wins" (project-local → user's `plugins` array → built-in
 * defaults); name collisions on predicates / rules / observers /
 * tracker-extensions log a WARN and keep the first-registered entry.
 * Tracker-*name* collisions are a hard error - two plugins claiming the
 * same state dimension is always a bug.
 */
export interface Plugin {
  /** Unique plugin identifier. Used for `disabledPlugins` + warning messages. */
  name: string;

  /**
   * Predicate handlers keyed by the `when.<key>` slot they register.
   * See {@link PredicateHandler}.
   */
  predicates?: Record<string, AnyPredicateHandler>;

  /** Rules the plugin suggests. Users can opt out via `disabledRules: [...]`. */
  rules?: readonly Rule[];

  /** Observers the plugin ships. Referenced by name from rules. */
  observers?: readonly Observer[];

  /**
   * Guard-rule carve-outs this plugin ships — see {@link Exemption}.
   *
   * Plugin exemptions accumulate with the rest of the plugin:
   * `disabledPlugins` drops them with everything else (a disabled
   * plugin contributes NOTHING), and they stack with config-layer
   * exemptions targeting the same rule (OR-ed at evaluation).
   *
   * Exemption `when` clauses are STRICTLY fail-closed: `onUnknown`
   * cannot be written anywhere inside them (type-level ban via
   * {@link ExemptionWhenClause}; rejected at load if smuggled), so a
   * plugin-shipped carve-out can never weaken the target rule's
   * fail-closed posture — the target rule's own `onUnknown:` policy
   * decides on unknown walker values.
   *
   * Use-case: a plugin that wants to narrow ANOTHER plugin's (or a
   * default rule's) guard for its own domain — e.g. a vault plugin
   * exempting `no-main-commit` when `cwd` is inside a vault tree —
   * without copying or replacing the rule body.
   *
   * Inside `defineConfig`, shipped exemption targets are cross-checked
   * at compile time against the config's rule-name universe (default
   * rules + listed plugins' rules + inline rules): a plugin whose
   * exemptions target a rule shipped by a plugin NOT in the `plugins`
   * array fails to compile, with a per-plugin `__steeringExemption`
   * error on the offending plugin element. Two escape hatches, both
   * by design: a bare `: Plugin` annotation widens
   * `exemptions[].rule` to `string` and silently skips the check
   * ("can't verify", never a false-positive), and configs split
   * across layers (global vs project) can false-positive because the
   * check is per-file while the runtime merges universes — keep the
   * plugin and its target's shipping plugin in the same layer.
   */
  exemptions?: readonly Exemption[];

  /**
   * NEW trackers the plugin introduces. Keys are tracker names (e.g.
   * `branch`). A name collision between plugins is a hard error.
   */
  trackers?: Record<string, Tracker<unknown>>;

  /**
   * Modifiers added to an EXISTING tracker. Outer key is the tracker
   * name (e.g. `cwd`), inner key is the command basename the modifier
   * triggers on (e.g. `git` - to register a `--git-dir=...` parser on
   * top of the built-in cwd tracker).
   *
   * The inner value accepts either a single {@link Modifier} or a
   * readonly array of them, mirroring {@link Tracker.modifiers} on the
   * walker side. Plugins can register multiple modifiers under one
   * `(tracker, basename)` pair - e.g. distinct parsers for different
   * subcommands of the same CLI that all share a basename.
   *
   * Collisions on a `(tracker, basename)` pair log a WARN and keep
   * the first-registered entry.
   *
   * Typed as `unknown` at this schema level - concrete plugins
   * declare their own modifier types tied to the tracker value they
   * extend.
   */
  trackerExtensions?: Record<
    string,
    Record<
      string,
      | import("@cad0p/unbash-walker").Modifier<unknown>
      | readonly import("@cad0p/unbash-walker").Modifier<unknown>[]
    >
  >;

  /**
   * Per-binary argv knowledge keyed by command basename (`"git"`,
   * `"gh"`). Mirrors trackers/predicates: same first-wins collision
   * / merge machinery, no new concepts. First-wins on collision;
   * the core fallback map is currently empty (core seeds nothing —
   * each plugin owns its binary's facts via this slot), so absent
   * basenames stay absent. An absent descriptor throws
   * `MissingDescriptorError` at resolution (loud block on the rule path,
   * non-match on the exemption path — a fail-CLOSED config hole),
   * NOT an unknown-escape — no `onUnknown:` projection applies.
   * Present-empty (`{<bin>: {}}`) is explicit strict.
   */
  cliDescriptors?: Record<string, CLIDescriptor>;
}

// ---------------------------------------------------------------------------
// SteeringConfig
// ---------------------------------------------------------------------------

/**
 * Top-level v2 config shape. What a user's `.pi/steering.ts` /
 * `.pi/steering/index.ts` file default-exports (possibly via
 * {@link defineConfig} or `satisfies SteeringConfig`).
 *
 * The loader walks up from the session cwd to `$HOME`, collects every
 * layer, and merges them into a single effective config with inner
 * (closer to cwd) layers taking precedence on name collisions.
 *
 * The five array-typed fields (`disabledRules`, `disabledPlugins`,
 * `plugins`, `rules`, `observers`) are all `readonly`. This is load-
 * bearing: {@link DefineConfigInput} extends `SteeringConfig` and
 * narrows each array field with a const-generic-aware subtype (e.g.
 * `disabledRules` becomes `readonly AllRuleNames<P, R>[]`). TypeScript's
 * interface-extension check runs on assignability, and `readonly T[]`
 * is not assignable to `T[]` — demoting any of these fields to a
 * mutable array would break every typed-name override on
 * `DefineConfigInput`. The compiler will catch the regression at
 * the `extends` site, but the choice originates here.
 *
 * See ADR "Design → File layout and loader behavior" and
 * "Design → Override default and `onUnknown`".
 */
export interface SteeringConfig {
  /**
   * Default value for {@link Rule.noOverride} when a rule doesn't
   * specify its own. Defaults to `true` (fail-closed - overrides
   * must be explicit opt-in per rule).
   *
   * Layer merge: inner (project) layer wins when specified; missing
   * layer leaves the running value alone.
   *
   * `buildConfig` preserves `undefined` in the merged output so
   * downstream evaluators can distinguish "user didn't specify" from
   * "user explicitly chose false". The fail-closed `?? true` coercion
   * happens at evaluator time.
   *
   * See ADR "Design → Override default".
   */
  defaultNoOverride?: boolean;

  /**
   * Rules to disable by name. Additive union across layers.
   *
   * Past-participle form (`disabledRules`) reads as a predicate on
   * state - "these are the rules that are disabled." There is no
   * engine-wide kill switch: rules only exist when their shipping
   * plugin is declared (or they're authored inline), so scoping a
   * disable to the rule name is always sufficient.
   *
   * Disabling a rule is by-design behavior, not a configuration
   * issue — it does NOT contribute to the diagnostic stream. See
   * {@link SteeringDiagnosticKind} for the by-design-vs-issue carveout.
   *
   * **Navigation note:** these are string literals projected from
   * `plugin.rules[*].name` and inline `rules[*].name`. Ctrl+Click on a
   * literal jumps to the `AllRuleNames` union, NOT the rule's source —
   * TypeScript-language limitation on string-literal union members. To
   * inspect a shipped rule's `reason` / `when`, open its plugin
   * module directly (e.g. `@cad0p/pi-steering/plugins/git` for
   * `no-force-push` / `no-hard-reset`, `.../plugins/rm` for
   * `no-rm-rf-slash`) and hover the exported rule binding:
   *
   * ```ts
   * import { noForcePush } from "@cad0p/pi-steering/plugins/git";
   * // hover noForcePush to see the rule body
   * ```
   */
  disabledRules?: readonly string[];

  /**
   * Plugins to disable by name. Additive union across layers.
   * A disabled plugin contributes NOTHING - no rules, no observers,
   * no predicates, no trackers.
   *
   * Disabling a plugin is by-design behavior, not a configuration
   * issue — it does NOT contribute to the diagnostic stream. See
   * {@link SteeringDiagnosticKind} for the by-design-vs-issue carveout.
   *
   * **Navigation note:** same TypeScript-language limitation as
   * {@link disabledRules} — Ctrl+Click on a string literal jumps to
   * the `AllPluginNames` union, not the plugin's source. To inspect a
   * shipped plugin, open its subpath module directly (e.g.
   * `@cad0p/pi-steering/plugins/git`):
   *
   * ```ts
   * import gitPlugin from "@cad0p/pi-steering/plugins/git";
   * // hover gitPlugin to see the plugin body
   * ```
   */
  disabledPlugins?: readonly string[];

  /**
   * Strict-mode opt-out. When `true` (default), any warning-class
   * {@link SteeringDiagnostic} produced while loading the config
   * escalates to a thrown error that disables the bridge for the
   * session. When explicitly set to `false`, warnings fall through
   * to `console.warn` and the bridge keeps running with whatever
   * subset of plugins / rules / observers loaded successfully.
   *
   * Error-class diagnostics ALWAYS throw regardless of this flag
   * (e.g. tracker name collision, reserved name violation) — the
   * engine cannot operate safely with those issues present.
   *
   * Layer merge: inner (project) layer wins when specified, identical
   * to the other inner-wins boolean fields (`defaultNoOverride`).
   *
   * Prior art: Rollup's `failAfterWarnings`, Maven's `failOnWarning`.
   */
  failOnWarnings?: boolean;

  /** Plugins to load. Order matters for first-wins name collisions. */
  plugins?: readonly Plugin[];

  /** User-authored rules. */
  rules?: readonly Rule[];

  /** Inline observers (rules reference by name). */
  observers?: readonly Observer[];

  /**
   * Guard-rule carve-outs — see {@link Exemption}. Name-keyed
   * clauses that, when they match, prevent the target rule from
   * firing.
   *
   * ACCUMULATION, not replacement: config-layer exemptions UNION
   * across layers (project + global both apply — no inner-wins), and
   * plugin-shipped exemptions stack on top. Multiple exemptions for
   * the same rule are OR-ed — ANY matching clause exempts. An
   * exemption targeting a rule name that doesn't exist in the final
   * merged rule universe surfaces an `exemption-orphan` diagnostic —
   * warning-class when written here in config (strict mode throws at
   * session start), error-class when shipped by a plugin (always
   * throws, regardless of `failOnWarnings`); a target that exists
   * but is disabled (via {@link disabledRules} or a disabled plugin)
   * is inert and silent.
   *
   * Inside {@link defineConfig}, `rule` is typo-checked against the
   * `AllRuleNames` union (same machinery as {@link disabledRules})
   * and `when.missing.event` narrows against the config's `writes`
   * union. See the README "Exemptions" section for the fail-closed
   * semantics (unknown predicate state counts as "does not match",
   * so a carve-out can never silently open a guard). `onUnknown` is
   * forbidden in exemption `when` clauses — typed via
   * {@link ExemptionWhenClause}, rejected at load if smuggled; the
   * target rule's own `onUnknown:` policy decides on unknown values.
   */
  exemptions?: readonly Exemption[];
}

// ---------------------------------------------------------------------------
// SteeringDiagnostic
// ---------------------------------------------------------------------------

/**
 * Discriminator categorizing what kind of issue a diagnostic
 * describes. Stable across versions so tooling and tests can dispatch
 * on `kind` without parsing the human-readable {@link
 * SteeringDiagnostic.message}.
 *
 * The set is split between two surfaces:
 *   - LOADER (`layer-project-untrusted`, `layer-form-coexistence`,
 *     `layer-import-failed`, `layer-stray-file`,
 *     `plugin-name-collision`, `rule-name-collision`,
 *     `observer-name-collision`, `tracker-name-collision`) — produced
 *     while walking up the
 *     filesystem, importing per-layer config files, and merging
 *     layers into a single effective config. The collision kinds in
 *     this group flag duplicates surfaced during layer merge — most
 *     are user-authored (`plugin-name-collision`, `rule-name-collision`,
 *     `observer-name-collision`), but `tracker-name-collision` flags
 *     duplicate plugin-shipped trackers when those plugins surface
 *     together via the merge.
 *   - PLUGIN-MERGER (`predicate-collision`, `observer-collision`,
 *     `rule-collision`, `descriptor-collision`, `invalid-descriptor`,
 *     `extension-orphan`, `reserved-tracker-name`,
 *     `reserved-predicate-key`, `invalid-name`) — produced while
 *     resolving plugin shapes into the runtime registry. The
 *     collision kinds in this group flag duplicates among
 *     plugin-author-shipped declarations across the active plugin
 *     set; `invalid-name` flags a plugin / rule / observer name
 *     containing characters that are disallowed in source-tagged
 *     block reasons.
 *
 * Disabling a plugin via `config.disabledPlugins` or a plugin-shipped
 * rule via `config.disabledRules` is by-design behavior, not a
 * configuration issue, so neither contributes to the diagnostic
 * stream. Both surface as `console.info` breadcrumbs from
 * `resolvePlugins` for plugin authors debugging "why isn't my plugin
 * firing?" — mirrors the unused-observer drop pattern in
 * `internal/session-runtime.ts`.
 *
 * `layer-project-untrusted` is the single info-class member. Unlike
 * the direct `console.info` breadcrumbs above, it IS in the union
 * because it is produced by the loader's discovery pass and flows
 * through the shared diagnostic stream; the runtime routes info-class
 * diagnostics to `console.info` breadcrumbs (see the render-format
 * matrix below).
 */
export type SteeringDiagnosticKind =
  /**
   * The project layer was skipped because the project is untrusted
   * (pi's RESOLVED project-trust decision, adopted by the trust
   * gate). Info-class: normal behavior under the gate, never an
   * issue — the global layer still loads, so steering keeps working.
   * `path` points at the skipped `<cwd>/.pi/steering` directory.
   */
  | "layer-project-untrusted"
  /**
   * Both `.pi/steering/index.ts` AND `.pi/steering.ts` exist at the
   * same directory. The directory form wins; the flat form is
   * ignored. Almost always a forgotten cleanup; delete the unused
   * file to silence the diagnostic.
   */
  | "layer-form-coexistence"
  /**
   * A layer's `.pi/steering/index.ts` (or `.pi/steering.ts`) was
   * found on disk but its dynamic import threw — typically a syntax
   * error or a missing default export. The layer is skipped; outer
   * layers continue to load.
   */
  | "layer-import-failed"
  /**
   * A non-`.ts` file lives under `<dir>/.pi/steering/` (e.g.
   * `rules.json`, `rules.mjs`). Helpers ending in `.ts` are allowed;
   * other extensions are flagged so the user can rename or delete
   * the stray file.
   */
  | "layer-stray-file"
  /**
   * Two layers register a plugin with the same `name`. The inner
   * (closer to cwd) layer wins; the outer layer's plugin is dropped.
   */
  | "plugin-name-collision"
  /**
   * A single layer declares two rules under the same `name`. The
   * first-declared rule survives; subsequent duplicates are dropped.
   * Cross-layer rule shadowing is intentional and not flagged.
   */
  | "rule-name-collision"
  /**
   * A single layer declares two observers under the same `name`.
   * The first-declared observer survives; subsequent duplicates are
   * dropped. Cross-layer observer shadowing is intentional and not
   * flagged.
   */
  | "observer-name-collision"
  /**
   * Two plugins both register a tracker under the same name. Always
   * an error — two plugins claiming the same state dimension is a
   * bug, not a soft override. Rename one tracker or disable one
   * plugin.
   */
  | "tracker-name-collision"
  /**
   * Two plugins both register a predicate handler under the same
   * `when.<key>`. The first-registered handler wins; the later
   * plugin's handler is dropped.
   */
  | "predicate-collision"
  /**
   * Two plugins both register an observer with the same `name`.
   * The first-registered observer wins; the later plugin's observer
   * is dropped. Distinct from `observer-name-collision` which
   * applies to within-layer duplicates in user-authored config.
   */
  | "observer-collision"
  /**
   * Two plugins both ship a rule with the same `name`. The
   * first-registered rule wins; the later plugin's rule is dropped.
   * Distinct from `rule-name-collision` which applies to
   * within-layer duplicates in user-authored config.
   */
  | "rule-collision"
  /**
   * A plugin's `trackerExtensions` references a tracker name that
   * no plugin (and no built-in walker tracker) registers. The
   * extension is ignored.
   */
  | "extension-orphan"
  /**
   * An exemption targets a rule name that doesn't exist in the final
   * merged rule universe (merged rules + plugin-shipped rules). The
   * carve-out can never
   * match anything and is dropped. Two-tier severity: plugin-shipped
   * orphans are error-class (broken plugin/config contract — the
   * runtime always throws regardless of `failOnWarnings`, the CLI
   * exits 1, `loadHarness` short-circuits); config-written orphans
   * are warning-class (strict mode throws at session start, else
   * `console.warn`, like `extension-orphan`). A target that exists
   * but is disabled (via `disabledRules` or a disabled plugin) is
   * inert, silent, and NOT flagged — by-design disable, consistent
   * with the disabled-rule `console.info` breadcrumb.
   */
  | "exemption-orphan"
  /**
   * A plugin attempts to register a tracker under a reserved name
   * (e.g. `events`). Always an error — reserved names are owned by
   * the engine. Rename the tracker.
   */
  | "reserved-tracker-name"
  /**
   * A plugin attempts to register a predicate handler under a
   * reserved key (an operator field like `not` or a modifier key
   * like `onUnknown`). Always an error — reserved keys collide
   * with the schema's operator/modifier surface. Rename the
   * predicate.
   */
  | "reserved-predicate-key"
  /**
   * A plugin / rule / observer name contains characters that are
   * disallowed in the `[steering:<name>@<source>]` block-reason
   * tag shown to the LLM, in `disabledRules` / `disabledPlugins`
   * config references, or in override-comment targets. Always an
   * error — names flow into user-visible strings and a malformed
   * (or maliciously-crafted) name lets a config author forge
   * block reasons that deceive the agent. (The tag is the SECOND
   * line of a block reason — the engine prepends its fixed
   * not-executed preamble first, issue #85.) Allowed: letters,
   * digits, underscores, dashes; must start with a letter or
   * digit. Rename the offending object in source.
   */
  | "invalid-name"
  /**
   * Two plugins both register a CLI descriptor under the same
   * basename. The first-registered entry wins; the later plugin's
   * entry is dropped. Also emitted when a plugin entry shadows a
   * core default basename (plugin still wins — loudness without
   * blocking; descriptors are additive knowledge, not
   * state-dimension claims).
   */
  | "descriptor-collision"
  /**
   * A plugin's `cliDescriptors` entry is malformed (non-object
   * descriptor, malformed `flags` table, invalid
   * `positionPolicy`). The entry is skipped at merge time (never throws
   * there); later lookups for that basename then throw
   * `MissingDescriptorError` (absent).
   */
  | "invalid-descriptor";

/**
 * Structured issue surfaced while loading a steering config.
 *
 * Diagnostics flow up from the loader and the plugin merger into the
 * bridge runtime, which decides whether to throw or log per the user's
 * strict-mode preference. The shape is stable so tests and future
 * tooling can dispatch on {@link kind} without scanning {@link message}
 * substrings.
 *
 * Channel-ownership split (loader / merger vs. runtime). Diagnostics
 * captured in this stream are by-design surfaced to the strict-mode
 * runtime so it can decide whether to throw or pass through to
 * `console.warn`. The loader (`loader.ts`) does not call
 * `console.*` directly — the runtime owns the policy decision.
 * However, by-design info breadcrumbs that are NOT configuration
 * issues (`disabledPlugins` and `disabledRules` opt-outs from
 * `resolvePlugins`, dropped-observer notices from
 * `dropUnusedObservers`) go directly to `console.info` from where
 * they're produced. They're not in this kind union because they
 * describe normal behavior the user opted into, not problems that
 * need actioning.
 *
 * Render-format matrix — the same diagnostic surfaces in two
 * shapes depending on which renderer the runtime picks:
 *
 *   - Multi-line aggregate (thrown `Error` from `buildSessionRuntime`):
 *     a header line ("N config issues:") followed by a per-line bullet
 *     `  - [type] <path: >?<message>`. One `Error.message`, multi-line.
 *     Used when at least one diagnostic must abort the session.
 *     Produced by `formatAggregatedDiagnostics`. The aggregate NEVER
 *     carries info-class diagnostics by construction — the formatter
 *     filters error/warning only, so a skipped project layer can
 *     never abort a session or appear in the thrown body.
 *   - Single-line per-diagnostic (`formatSingleLineDiagnostic`):
 *     `[pi-steering] [<severity>] <path: >?<message>` per diagnostic.
 *     Severity tag (`[info]` / `[error]` / `[warning]`) follows the
 *     same bracketed convention as the multi-line aggregate's
 *     per-line bullets. Info-class diagnostics route to `console.info`
 *     breadcrumbs (runtime, emitted before the throw/warn policy) or
 *     stderr (CLI). Warning-class diagnostics route to
 *     `console.warn` for legacy fail-soft mode (`failOnWarnings:
 *     false`) — the fail-soft loop filters to warning-class only, so
 *     info never re-emits through `console.warn`. Error-class
 *     diagnostics escalate to a thrown error via the aggregated form
 *     before warnings are flushed. Also routed to stderr for the CLI
 *     `pi-steering list` pre-flight surface (all three severities
 *     render here; the bracketed severity tag distinguishes them).
 *     The function itself accepts every severity; the narrowing is a
 *     property of each route's caller, not the formatter.
 *
 * The CLI prints diagnostics inline as the loader yields them, rather
 * than aggregating into a thrown error — the single-line shape
 * gives `pi-steering list` users immediate per-issue feedback.
 */
export interface SteeringDiagnostic {
  /**
   * Severity of the diagnostic.
   *
   *   - `"info"` — normal-behavior breadcrumb (e.g. the project
   *     layer skipped because the project is untrusted). Never
   *     escalates strict mode; excluded from the aggregate throw
   *     body by construction (the aggregator filters error/warning
   *     only). Surfaces via `console.info` (runtime) or stderr (CLI).
   *   - `"warning"` — informational; safe to ignore in legacy
   *     fail-soft mode.
   *   - `"error"` — pi-steering cannot operate safely with this
   *     issue present (e.g. tracker name collision); always escalates
   *     to a thrown error regardless of the user's strict-mode
   *     preference.
   */
  type: "info" | "warning" | "error";

  /** Discriminator for programmatic dispatch and test assertions. */
  kind: SteeringDiagnosticKind;

  /** Agent-facing message; includes context like layer path or names. */
  message: string;

  /**
   * Source path, when applicable. Per kind:
   *   - `layer-project-untrusted`: the skipped project layer
   *     directory `<cwd>/.pi/steering` (the renderer's `${path}:
   *     ${message}` prefix surfaces it once).
   *   - `layer-import-failed`: the source file the loader couldn't import.
   *   - `layer-stray-file`: the stray file under `.pi/steering/`.
   *   - `layer-form-coexistence`: the directory holding both forms
   *     (`.pi/steering.ts` AND `.pi/steering/index.ts`); the dir is
   *     intentional rather than picking one of the two coexisting files
   *     arbitrarily.
   *   - Within-layer collisions (`rule-name-collision`,
   *     `observer-name-collision`): unset (the diagnostic names the
   *     offending object inside `message`).
   *   - Cross-layer collisions and plugin-shipped diagnostics
   *     (`plugin-name-collision`, `tracker-name-collision`,
   *     `predicate-collision`, `observer-collision`, `rule-collision`,
   *     `descriptor-collision`, `invalid-descriptor`,
   *     `extension-orphan`, `reserved-tracker-name`,
   *     `reserved-predicate-key`, `invalid-name`): unset by design.
   *     These diagnostics name the participants (layer paths or
   *     plugin names) inside `message` because there is no single
   *     source path — the collision spans multiple layers or
   *     plugins.
   */
  path?: string;
}
