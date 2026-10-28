// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * v2 steering evaluator.
 *
 * Assembles the per-tool_call pipeline on top of:
 *
 *   - `unbash-walker`           — AST parse + command extraction +
 *                                 wrapper expansion + per-ref walker
 *                                 state (cwd today; branch/others once
 *                                 plugins register them).
 *   - {@link matchesPatternOrFn} / {@link evaluateWhen} — shared
 *                                 predicate resolution (see
 *                                 `./evaluator-internals/predicates.ts`).
 *   - {@link extractOverride}   — inline override-comment detection
 *                                 ported from v1 (see
 *                                 `./evaluator-internals/override.ts`).
 *   - {@link createExecCache} / {@link createFindEntries} — per-call
 *                                 exec memoization + session-entry
 *                                 filtering (see
 *                                 `./evaluator-internals/context.ts`).
 *
 * Public surface is deliberately small: {@link buildEvaluator} returns
 * an {@link EvaluatorRuntime} whose sole method, {@link
 * EvaluatorRuntime.evaluate}, drives one `tool_call` event through
 * every applicable rule. Phase 3c wires it into the pi extension's
 * `tool_call` listener.
 *
 * Rule ordering (per ADR "Precedence: first-wins everywhere"):
 *
 *   1. `config.rules`       — user's top-level rules, first-match-wins.
 *   2. `resolved.rules`     — plugin-shipped rules (already deduped /
 *                              disabled-filtered by the plugin merger).
 *
 * First rule that fires AND isn't overridden wins and returns a block.
 *
 * Internal shape: each applicable rule is fed to {@link
 * evaluateCandidate}, the single predicate-chain used for every tool.
 * Bash rules loop over extracted command refs (one candidate per ref);
 * write / edit produce exactly one candidate. The per-tool axes of
 * variation live in the {@link Candidate} input — the body of
 * `evaluateCandidate` stays tool-agnostic.
 */

import {
  type CommandRef,
  type EnvState,
  expandWrapperCommands,
  extractAllCommandsFromAST,
  getBasename,
  parse as parseBash,
  type Tracker,
  type Word,
  walk,
} from "@cad0p/unbash-walker";
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  arityOf,
  MissingDescriptorError,
  missingDescriptorRemedy,
} from "./arity.ts";
import {
  createAppendEntry,
  createExecCache,
  createFindEntries,
  createSessionEntryCache,
  type EvaluatorHost,
} from "./evaluator-internals/context.ts";
import { extractOverride } from "./evaluator-internals/override.ts";
import {
  evaluateWhen,
  matchesPattern,
  matchesPatternOrFn,
  validateExemptionWhenClauseShape,
  validateWhenClauseKeys,
  validateWhenClauseShape,
} from "./evaluator-internals/predicates.ts";
import {
  type SpeculativeEventsByRef,
  synthesizeSpeculativeEntries,
} from "./evaluator-internals/speculative-synthesis.ts";
import {
  BLOCK_REASON_PREAMBLE,
  ENGINE_ERROR_PREAMBLE,
} from "./helpers/block-reason-preamble.ts";
import { commandFromInput } from "./helpers/command.ts";
import { mergeObserversUserFirst } from "./internal/merge-observers.ts";
import {
  refToTextResolved,
  resolvePredicateWords,
} from "./internal/ref-text.ts";
import { buildWalkRegistry } from "./internal/walk-registry.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import { validateName } from "./plugin-merger.ts";
import type {
  Exemption,
  Observer,
  PredicateContext,
  PredicateToolInput,
  PredicateWord,
  Rule,
  SteeringConfig,
  TopLevelWhenClause,
  WhenWalkerState,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Built-in trackers
// ---------------------------------------------------------------------------

/**
 * Names of trackers the evaluator wires in directly (not via a plugin).
 * `resolvePlugins` accepts this list as `knownBuiltinTrackers`: plugin
 * `trackerExtensions` targeting these names are kept (so plugins can
 * compose modifiers onto them) without emitting an `extension-orphan`
 * diagnostic.
 *
 * All call sites (`buildSessionRuntime`, `loadHarness`,
 * `loadSteeringConfig`, the `pi-steering list` CLI) import this
 * constant so a future addition (e.g. an `argv` tracker) lights up
 * uniformly across production and the test harness.
 */
export const EVALUATOR_BUILTIN_TRACKERS = ["cwd", "env"] as const;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Runtime-facing evaluator handle. Phase 3c holds an instance per
 * session and calls {@link evaluate} from the pi `tool_call`
 * listener.
 */
export interface EvaluatorRuntime {
  /**
   * Evaluate a single `tool_call` event against every rule in
   * `config.rules` + `resolved.rules`. Returns:
   *   - `{ block: true, reason }` — a rule matched + wasn't overridden.
   *   - `undefined`               — no rule fires; tool call proceeds.
   */
  evaluate(
    event: ToolCallEvent,
    ctx: ExtensionContext,
    agentLoopIndex: number,
  ): Promise<ToolCallEventResult | void>;
}

/**
 * Construct an {@link EvaluatorRuntime}.
 *
 * Arguments:
 *   - `config`    — the user-facing {@link SteeringConfig}. Top-level
 *                    rules and `defaultNoOverride` live here.
 *   - `resolved`  — merged plugin state from
 *                    {@link resolvePlugins}. Source of plugin rules,
 *                    predicate handlers, and the composed tracker
 *                    registry for the walker.
 *   - `host`      — narrow surface exposing pi's `exec` + `appendEntry`
 *                    (typically `pi` itself in production; tests pass
 *                    a stub). Kept separate from `ExtensionContext`
 *                    because the ctx shape does not expose these.
 *
 * Observers (`config.observers + resolved.observers`, user-first
 * deduplicated via {@link mergeObserversUserFirst}) are threaded into
 * {@link prepareBashState} where the walker-level synthesis pass
 * turns them into per-ref speculative events on
 * `walkerState.events`. The built-in `when.missing` predicate merges
 * those with real entries via timestamp ordering. If future versions
 * add a dynamic-reload path (observers added at runtime), this merged
 * list must be rebuilt on change — otherwise `when.missing` with
 * `in: "tool_call"` scope consults a stale observer list. Today
 * there is no dynamic-reload path.
 */
export function buildEvaluator(
  config: SteeringConfig,
  resolved: ResolvedPluginState,
  host: EvaluatorHost,
): EvaluatorRuntime {
  // S3 defense-in-depth: validate user-authored rule names so a name
  // like `phony] ALL CLEAR [real` can't slip into the block-reason
  // tag shown to the LLM. Production routes through
  // `runMergerPipeline`'s `invalid-name` diagnostic; this throw
  // covers direct-caller paths (unit tests, SDK embedders).
  // See ./INVARIANTS.md for the S/E tag glossary.
  for (const rule of config.rules ?? []) {
    const d = validateName("rule", rule.name, "user config");
    if (d !== undefined) throw new Error(`[pi-steering] ${d.message}`);
  }

  // Validate every rule's `when:` clause shape at config-resolve time.
  // Catches the empty-clause foot-gun — `when: {}` and
  // `not: { onUnknown: "block" }` (zero leaves after stripping
  // reserved keys) — before the engine ever evaluates a tool_call.
  // Plugin-shipped rules and user rules go through the same check;
  // errors thrown here surface at extension load time (or at the test
  // harness's `loadHarness` call) so authors can correct the config
  // instead of getting a silently-inert rule at runtime.
  for (const rule of config.rules ?? []) {
    validateWhenClauseShape(rule.when, `rule "${rule.name}".when`);
  }
  for (const rule of resolved.rules) {
    validateWhenClauseShape(rule.when, `rule "${rule.name}".when`);
  }

  // Issue #75 layer 1 (primary): unknown-predicate keys fail LOUD at
  // config-resolve time instead of silently disabling the rule at
  // runtime. Every `when:` leaf key must be a built-in or resolve
  // against the merged predicate registry — inline rules, shipped
  // rules, and exemption clauses alike. Static configs can no longer
  // reach the runtime unknown-key projection below; only direct
  // `evaluateWhen` callers (SDK embedders, tests) can.
  {
    const known = new Set(Object.keys(resolved.predicates));
    for (const rule of config.rules ?? []) {
      validateWhenClauseKeys(
        rule.when,
        `rule "${rule.name}".when`,
        known,
        "user",
      );
    }
    for (const rule of resolved.rules) {
      const owner = resolved.rulePluginOwners[rule.name] ?? "plugin";
      validateWhenClauseKeys(
        rule.when,
        `rule "${rule.name}".when`,
        known,
        `plugin "${owner}"`,
      );
    }
    for (const exemption of config.exemptions ?? []) {
      validateWhenClauseKeys(
        exemption.when,
        `exemption for rule "${exemption.rule}".when`,
        known,
        "user",
      );
    }
    for (const exemption of resolved.exemptions ?? []) {
      validateWhenClauseKeys(
        exemption.when,
        `exemption for rule "${exemption.rule}".when`,
        known,
        "plugin",
      );
    }
  }

  // S3 defense-in-depth for exemption target names (direct-caller
  // paths — unit tests, SDK embedders — bypass
  // `runMergerPipeline`'s diagnostic stream; this throw mirrors the
  // rule-name throw above). Exemption names flow into orphan
  // diagnostics, list output, and warn logs, so a malformed name
  // must not leak into those strings.
  //
  // Also validate every exemption's `when:` clause shape — the
  // empty-clause foot-gun (`when: {}`, or `not:` blocks with zero
  // leaves) would otherwise produce a vacuous-true clause that
  // EXEMPTS the rule unconditionally, silently opening its guard.
  // Config and plugin buckets go through the same checks.
  //
  // STRICT fail-closed (no escape hatch): `validateExemptionWhenClauseShape`
  // additionally rejects any `onUnknown` key anywhere in the clause
  // (top level, not-block level, leaf object forms) — the runtime
  // guard for `as any` / plain-JS authors who bypass the type-level
  // ban via {@link ExemptionWhenClause}. A carve-out can never opt
  // back into unknown-exempts; the target rule's own `onUnknown:`
  // policy decides.
  for (const exemption of config.exemptions ?? []) {
    const d = validateName("rule", exemption.rule, "exemption");
    if (d !== undefined) throw new Error(`[pi-steering] ${d.message}`);
    validateExemptionWhenClauseShape(
      exemption.when,
      `exemption for rule "${exemption.rule}"`,
    );
  }
  for (const exemption of resolved.exemptions ?? []) {
    const d = validateName("rule", exemption.rule, "exemption");
    if (d !== undefined) throw new Error(`[pi-steering] ${d.message}`);
    validateExemptionWhenClauseShape(
      exemption.when,
      `exemption for rule "${exemption.rule}"`,
    );
  }

  // Default the fail-closed override policy per ADR "Override default".
  const defaultNoOverride = config.defaultNoOverride ?? true;

  // Combine config.rules (user-authored, first) with resolved.rules
  // (plugin-shipped). Empty fallbacks mean a config without either slot
  // still produces a running evaluator — just never fires.
  const userRules = config.rules ?? [];
  const pluginRules = resolved.rules;
  const allRules: readonly Rule[] = [...userRules, ...pluginRules];

  // Source tags per ADR §11: user-authored rules get `@user`, plugin-
  // shipped rules get the originating plugin's name. The merger
  // already tracks `rule-name → plugin-name` during resolution — we
  // reuse that instead of threading the map through the evaluator.
  const ruleSources = new Map<Rule, string>();
  for (const rule of userRules) {
    ruleSources.set(rule, "user");
  }
  for (const rule of pluginRules) {
    ruleSources.set(rule, resolved.rulePluginOwners[rule.name] ?? "user");
  }

  // Issue #117 build-time shape guard: every bash rule's `command`
  // entries must be well-formed (one non-empty whitespace-free
  // basename per entry — `command: "git commit"` is illegal). This
  // runs once at build (not per ref). Unknown basenames are NOT
  // rejected here: they surface as the fail-closed rule-tagged
  // `MissingDescriptorError` block (with remedy) on the first MATCHED
  // evaluation — the `arityOf` throw contract is unchanged (§5), and
  // unrouted / nameless refs never reach it (routing first,
  // resolution second). An empty array is NOT a throw: it never
  // matches (mirrors the empty-`anyOf` invalid rule).
  {
    const checkBashCommand = (rule: Rule): void => {
      if (rule.tool !== "bash") return;
      const source = ruleSources.get(rule) ?? "user";
      const cmds = Array.isArray(rule.command) ? rule.command : [rule.command];
      for (const cmd of cmds) {
        if (typeof cmd !== "string" || cmd.length === 0 || /\s/.test(cmd)) {
          throw new Error(
            `[pi-steering] rule "${rule.name}"@${source} has an invalid command entry ${JSON.stringify(cmd)} — command: takes one basename per entry (e.g. "git", never "git commit").`,
          );
        }
      }
    };
    for (const rule of allRules) checkBashCommand(rule);
  }

  // Effective walker registry — single source of truth shared with
  // the observer-dispatcher's watch surface (see
  // `internal/walk-registry.ts` for the builtin-fallback contract).
  // Always includes `env` + `cwd` (built-in fallbacks when no plugin
  // ships them) and honors plugin `trackers`/`trackerExtensions`.
  // Env goes in first so cd's modifier sees the current ref's env via
  // the `allState` read; the ordering is a soft guarantee.
  const trackers = buildWalkRegistry(resolved);

  // Merge user + plugin observers (user-first dedup via the shared
  // helper, same convention as the observer-dispatcher). The merged
  // list feeds the walker-level synthesis pass in
  // {@link prepareBashState}, where eligible observers contribute
  // speculative `walkerState.events` entries the built-in
  // `when.missing` predicate consults alongside real entries. Without
  // the dedup, a shadowed plugin observer's `writes` could produce
  // synthetic entries that never match a real dispatch, re-creating
  // the infinite-loop risk the speculative pass was designed to avoid.
  const allObservers = mergeObserversUserFirst(
    config.observers ?? [],
    resolved.observers,
  );

  // Build the exemption registry: config-layer exemptions (already
  // union-merged across layers by the loader) + plugin exemptions
  // (collected by the plugin merger, disabled-plugin-filtered).
  // Keyed by target rule name — exemptions attach BY NAME to
  // whichever rule wins the name after `disabledRules` filtering;
  // multiple exemptions for one rule OR at evaluation time.
  //
  // Cross-bucket note: `config.rules` and `resolved.rules` are never
  // deduped against each other — a same-named rule can exist in both
  // buckets and exemption-by-name applies to BOTH (documented; no
  // winner assumption).
  const exemptionMap = new Map<string, TopLevelWhenClause<string>[]>();
  const collectExemptions = (list: readonly Exemption[] | undefined) => {
    if (list === undefined) return;
    for (const exemption of list) {
      const bucket = exemptionMap.get(exemption.rule);
      if (bucket === undefined) {
        exemptionMap.set(exemption.rule, [exemption.when]);
      } else {
        bucket.push(exemption.when);
      }
    }
  };
  collectExemptions(config.exemptions);
  collectExemptions(resolved.exemptions);

  return {
    evaluate: (event, ctx, agentLoopIndex) =>
      evaluateEvent(
        event,
        ctx,
        agentLoopIndex,
        allRules,
        trackers,
        resolved.predicates,
        host,
        defaultNoOverride,
        ruleSources,
        allObservers,
        exemptionMap,
        resolved.cliDescriptors,
      ),
  };
}

// ---------------------------------------------------------------------------
// Per-event evaluation
// ---------------------------------------------------------------------------

/**
 * Walker-state snapshot per extracted bash command ref plus the
 * stringified `basename + args` text for regex testing (ENV-RESOLVED
 * per issue #51 — patterns match what executes), the basename
 * sugar, and the suffix `PredicateWord[]` for quote-aware structured
 * access (text/value resolved, rawText the source, parts raw).
 *
 * Built once per tool_call (in {@link prepareBashState}) so N rules
 * against M refs cost N×M regex tests — no N parses or N walks, and
 * `basename` / `args` are computed once per ref rather than per rule.
 */
interface BashRefState {
  readonly ref: CommandRef;
  readonly text: string;
  /**
   * Ref binary name, or `undefined` for nameless refs (bare `VAR=x`
   * chain assignments — no binary, no descriptor resolution).
   */
  readonly basename: string | undefined;
  readonly args: readonly PredicateWord[];
  readonly envAssignments: readonly Word[];
  readonly walkerState: Readonly<WhenWalkerState>;
}

/**
 * Prepare bash state for every rule to share: parse once, extract +
 * expand wrappers once, walk trackers once, stringify each ref once.
 *
 * Also runs the walker-level speculative-entry synthesis pass and
 * merges its output into each ref's walkerState under the reserved
 * `events` key. The built-in `when.missing` predicate consults
 * `ctx.walkerState.events[customType]` to unify real + speculative
 * entries via timestamp ordering (see {@link evaluateMissing}).
 */
function prepareBashState(
  command: string,
  sessionCwd: string,
  trackers: Record<string, Tracker<unknown>>,
  observers: readonly Observer[],
): BashRefState[] {
  const script = parseBash(command);
  const extracted = extractAllCommandsFromAST(script, command);
  const { commands: refs } = expandWrapperCommands(extracted);
  const walkResult = walk(
    script,
    { cwd: sessionCwd } as Record<string, unknown>,
    trackers,
    refs,
  );
  // Per-ref env snapshot + resolved command text (issue #51). Word
  // expansion in bash happens BEFORE the command runs, against the
  // pre-command environment (bash manual §3.7.1) — so words resolve
  // against the walker's per-ref env snapshot alone. Prefix
  // assignments (`NAME=value cmd …`) are one-shot for the DIRECT
  // CHILD's environment only; they do NOT bind for the same command's
  // word expansions. A ref referencing its own prefix keeps the RAW
  // form (fail-closed) — the snapshot doesn't carry the prefix. Chain
  // assignments (`VAR=x && …`) DO persist via the walker env tracker
  // and resolve normally.
  const effective = refs.map((ref) => {
    const trackerState = walkResult.get(ref) ?? {
      cwd: sessionCwd,
      env: new Map<string, string>(),
    };
    // The composed trackers map is typed as a `Record<string,
    // Tracker<unknown>>`, so the walk result value is an index-signature
    // record — narrow `unknown` to the expected env map (the tracker is
    // always the envTracker's EnvState). NO prefix overlay here (issue
    // #53).
    const env = trackerState.env as EnvState;
    return { ref, trackerState, env, text: refToTextResolved(ref, env) };
  });
  // Thread per-ref resolved text into speculative synthesis so watch
  // patterns match the resolved command line (same contract as rule
  // patterns); refs missing from the map fall back to raw refToText.
  const resolvedTexts = new Map(effective.map(({ ref, text }) => [ref, text]));
  const speculativeEvents: SpeculativeEventsByRef =
    synthesizeSpeculativeEntries(refs, observers, resolvedTexts);
  return effective.map(({ ref, trackerState, env, text }) => {
    const events = speculativeEvents.get(ref) ?? {};
    // Nameless refs (bare `VAR=x` chain assignments — `node.name` is
    // absent; the assignment lives in `prefix`) carry NO binary: leave
    // `basename` undefined so descriptor resolution is skipped (issue
    // #107 carve-out — there is no descriptor to declare and no argv
    // to guard; leaves still fail closed via extraction-unknown).
    // Without this, every `VAR=x; cmd` chain would fail-closed-block
    // with a nonsense `Plugin.cliDescriptors.VAR` remedy.
    const hasCommandWord =
      (ref.node as { name?: unknown } | undefined)?.name != null;
    return {
      ref,
      text,
      basename: hasCommandWord ? getBasename(ref) : undefined,
      // Per-ref env-snapshot projection: text/value carry the
      // ENV-RESOLVED runtime forms (text quote-preserving incl.
      // process-substitution inner expansion; value the unquoted
      // resolved value), rawText the original source, parts the RAW
      // AST structure; unresolvable words stay raw (fail-closed).
      args: resolvePredicateWords(ref, env),
      // `node.prefix` is unbash's AssignmentPrefix[] (shape:
      // `{ text, name, value, ... }`). Project into Word[] so
      // PredicateToolInput.envAssignments lines up with `.args` for
      // plugin consumers — `.text` preserves the full "KEY=VALUE"
      // source token (with quoting), and dynamic values like `A=$VAR`
      // come through visibly in `.text` so callers can detect them.
      envAssignments: ref.node.prefix.map<Word>((p) => ({
        text: p.text,
        value: p.text,
        pos: p.pos,
        end: p.end,
      })),
      // Merge tracker state with synthesized events so the built-in
      // `missing` predicate can read `walkerState.events` without
      // threading a separate context field. Trackers cannot name a
      // dimension `"events"` — the plugin merger rejects that (see
      // plugin-merger.ts). The merge is a shallow copy so the walker's
      // state object stays untouched for future evaluations.
      //
      // The cast via `unknown` to `Readonly<WhenWalkerState>` is safe:
      // buildEvaluator always registers `cwd` + `env` trackers, so every
      // ref the walker yields carries both fields; the fallback literal
      // above also supplies them. The schema interface's `readonly
      // [key: string]: unknown` index signature tolerates the `events`
      // key and any plugin-registered tracker slot. TypeScript's
      // spread inference over `Record<string, unknown> | { cwd: string;
      // env: Map<...> }` doesn't preserve the cwd/env shape through
      // the spread, so the double cast is the minimum TS needs to
      // accept a structure its inference widens away.
      walkerState: {
        ...trackerState,
        events,
      } as unknown as Readonly<WhenWalkerState>,
    };
  });
}

/**
 * Compute the effective `noOverride` for a rule — rule-level explicit
 * value wins, falling back to the config-level default (itself defaulted
 * to fail-closed `true` per ADR).
 */
function effectiveNoOverride(rule: Rule, defaultNoOverride: boolean): boolean {
  return rule.noOverride ?? defaultNoOverride;
}

/**
 * Format the block reason shown to the agent. The returned string is
 * ALWAYS prefixed with {@link BLOCK_REASON_PREAMBLE} followed by
 * `\n\n` — the emitted shape is:
 *
 * ```
 * This tool call was not executed; blocked by a steering rule:
 *
 * [steering:<rule-name>@<source>] …[ To override, …]
 * ```
 *
 * The preamble states explicitly that the entire tool call never
 * executed (issue #85 — live incidents showed agents chasing ghost
 * state after a compound bash chain was blocked as ONE tool call).
 * The tag stays the second line, the machine-detectable anchor for
 * consumers (`stripPreamble` in `../testing/index.ts` strips the
 * preamble before matching).
 *
 * Appends an override hint ONLY when the rule is overridable — rules
 * with `noOverride: true` (or the fail-closed default) omit it to
 * avoid advertising a nonexistent escape hatch.
 *
 * Source-tagged (per ADR §11): `[steering:<rule-name>@<source>] …`
 * where `<source>` is the originating plugin name for plugin-shipped
 * rules, or `user` for rules declared directly in the user's
 * SteeringConfig.rules.
 *
 * Rule.reason accepts both a static string and a {@link ReasonFn}
 * (D3 in pr5-tier-b-shell-var-tracker-spec.md). Function reasons
 * receive the same {@link PredicateContext} the predicates saw;
 * async returns are awaited before prefixing. A reason function
 * that throws or rejects is logged via `console.warn` and replaced
 * with a fail-safe fallback string — the block verdict still fires.
 * The exact fallback text is a stable contract rule authors can
 * detect in tests.
 *
 * Tag→body separator is paragraph-aware: when the resolved body
 * contains a `\n\n` paragraph break, the tag is rendered on its own
 * line (`${tag}\n\n${body}`) so subsequent paragraphs don't orphan
 * visually from the source-tag prefix. Single-paragraph bodies keep
 * the legacy single-space layout (`${tag} ${body}`) — backward-
 * compatible for every reason that was single-paragraph before the
 * paragraph-aware rendering shipped. Trigger is `\n\n` or its CRLF
 * equivalent `\r\n\r\n` (defensive against bodies imported from
 * Windows line-ending sources — CRLF templating layers, hand-typed
 * Windows-IDE strings); a single `\n` inside an otherwise single-
 * paragraph body keeps the single-space layout. The emitted
 * separator is always normalized to `\n\n` regardless of which form
 * triggered it.
 *
 * Body→override-hint separator mirrors the same paragraph-aware
 * separator. Single-paragraph bodies keep the single-space prefix
 * on the override hint (byte-identical to the pre-paragraph-aware
 * rendering); multi-paragraph bodies promote the override hint to
 * its own paragraph (`${body}\n\n${hint}`) so the safety paragraph
 * stays visually standalone rather than running on into an inline
 * "To override" sentence. Mirror docs on {@link Rule.reason}.
 */
async function formatReason(
  rule: Rule,
  tool: "bash" | "write" | "edit",
  noOverride: boolean,
  source: string,
  ctx: PredicateContext,
): Promise<string> {
  const tag = `[steering:${rule.name}@${source}]`;
  const body = await resolveReasonBody(rule, source, ctx);
  // Paragraph-aware tag separator — see function-level JSDoc for the
  // contract; this line implements the trigger detection.
  const multiPara = body.includes("\n\n") || body.includes("\r\n\r\n");
  const separator = multiPara ? "\n\n" : " ";
  if (noOverride)
    return `${BLOCK_REASON_PREAMBLE}\n\n${tag}${separator}${body}`;
  const leader = tool === "bash" ? "#" : "//";
  const hint =
    `To override, include a comment: ` +
    `\`${leader} steering-override: ${rule.name} — <reason>\`.`;
  return `${BLOCK_REASON_PREAMBLE}\n\n${tag}${separator}${body}${separator}${hint}`;
}

/**
 * Resolve the string body of a rule's reason field. Handles both
 * variants of the discriminated union on {@link Rule.reason}:
 *
 *   - `string`        — returned as-is.
 *   - `ReasonFn`      — invoked with `ctx`, awaited, returned. A
 *                       synchronous throw or rejected promise is
 *                       caught, logged to `console.warn` with the
 *                       rule name + source prefix + error message
 *                       + stack, and replaced with the fail-safe
 *                       fallback body `(reason failed to format;
 *                       see log)`. The wrapping in
 *                       {@link formatReason} still adds the source
 *                       tag, so the agent sees
 *                       `[steering:<rule>@<source>] (reason failed
 *                       to format; see log)` — an unambiguous
 *                       signal of a broken reason fn that still
 *                       doesn't leak the error message.
 *
 * The fallback behavior is part of the public contract per spec
 * D3: a rule author CAN assert the exact text (e.g. in a test
 * asserting the engine keeps the block verdict alive when the
 * reason function intentionally throws as a smoke-test).
 */
async function resolveReasonBody(
  rule: Rule,
  source: string,
  ctx: PredicateContext,
): Promise<string> {
  if (typeof rule.reason === "string") return rule.reason;
  try {
    return await rule.reason(ctx);
  } catch (err) {
    const msg =
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    console.warn(
      `[pi-steering] Rule "${rule.name}"@${source}: reason function threw: ${msg}`,
    );
    return "(reason failed to format; see log)";
  }
}

// ---------------------------------------------------------------------------
// Unified per-candidate evaluation
// ---------------------------------------------------------------------------

/**
 * Per-tool_call state shared across every candidate and rule. One
 * struct in place of the 6-argument bundle the prior shape threaded
 * through both bash and write/edit call-sites.
 *
 * `exec` / `appendEntry` / `findEntries` are the closures the evaluator
 * builds once per tool_call (see `./evaluator-internals/context.ts`).
 * `appendEntry` auto-tags every write with the current
 * `_agentLoopIndex`, including the `steering-override` audit entries
 * written from the override-accepted path — so rules using
 * `when.missing: { event: "steering-override", in: "agent_loop" }`
 * can correctly filter override activity to the current agent loop.
 *
 * `host` is retained on the shared context for non-entry operations
 * (currently only `exec` indirectly) and for tests that stub pi’s
 * surface without having to re-shape every call-site.
 */
interface SharedEvalContext {
  readonly agentLoopIndex: number;
  readonly predicates: ResolvedPluginState["predicates"];
  readonly exec: PredicateContext["exec"];
  readonly appendEntry: PredicateContext["appendEntry"];
  readonly findEntries: PredicateContext["findEntries"];
  readonly host: EvaluatorHost;
  readonly defaultNoOverride: boolean;
  /**
   * Rule → source-name lookup for source-tagged block reasons
   * (`[steering:<rule>@<source>]`). Keyed by Rule object identity so
   * the same rule name appearing in multiple plugins still resolves
   * unambiguously.
   */
  readonly ruleSources: ReadonlyMap<Rule, string>;
  /**
   * Exemption registry: target rule name → its exemption `when`
   * clauses (config + plugin buckets merged at build time). A
   * matching clause prevents the rule from firing — see
   * {@link evaluateCandidate} and {@link evaluateExemptionClause}.
   */
  readonly exemptions: ReadonlyMap<
    string,
    readonly TopLevelWhenClause<string>[]
  >;
  /**
   * Merged CLI descriptors keyed by basename (issue #106). Bound
   * per ref for the facade (`commandFromInput`) and threaded into
   * `evaluateWhen` for both ARGV leaves.
   */
  readonly descriptors: Record<string, import("./schema.ts").CLIDescriptor>;
  /**
   * Per-tool_call arity cache (issue #110). Created ONCE per tool_call in
   * `evaluateEventInner`, dies with the call; O(distinct basenames).
   * `runPredicateChain` (per rule×candidate) and `evaluateBashRule`'s
   * per-ref loop only THREAD it, never create.
   */
  readonly arityCache: Map<string, import("./arity.ts").ResolvedArity>;
}

/**
 * Single-candidate input for {@link evaluateCandidate}. The fields here
 * are the sole per-tool axes of variation — the body of
 * `evaluateCandidate` stays tool-agnostic.
 *
 *   - `target`        — string the rule's `pattern` / `requires` /
 *                        `unless` test against (bash: basename + args
 *                        for the current ref; write: content or path;
 *                        edit: joined newText or path).
 *   - `cwd`           — effective cwd seen by predicates via
 *                        `ctx.cwd`. Per-ref for bash (walker-resolved);
 *                        session cwd for write / edit.
 *   - `input`         — the `PredicateToolInput` predicates see via
 *                        `ctx.input`.
 *   - `overrideCarrier` — text scanned for `# steering-override: …`
 *                          comments. Bash: the raw tool_call command;
 *                          write: content; edit: joined newText.
 *   - `tool`          — plain-string tool, drives the override-comment
 *                        leader (`#` vs `//`) and the block reason.
 *   - `overrideEntryExtras` — extra fields merged into the
 *                              `steering-override` audit entry
 *                              (`command` for bash, `path` for
 *                              write / edit).
 */
interface Candidate {
  readonly target: string;
  readonly cwd: string;
  readonly input: PredicateToolInput;
  readonly overrideCarrier: string;
  readonly tool: "bash" | "write" | "edit";
  readonly overrideEntryExtras: Record<string, string>;
  /**
   * Walker state snapshot for this candidate. Bash candidates carry
   * the per-ref walk result (including synthesized
   * `events: Record<customType, SyntheticEntry[]>` under the reserved
   * `events` key, populated by the walker-level speculative-entry
   * synthesis pass); write / edit candidates leave it undefined (no
   * walker ran).
   */
  readonly walkerState?: Readonly<WhenWalkerState>;
}

/**
 * Outcome of `evaluateCandidate`:
 *   - {@link ToolCallEventResult}  — rule fired + was NOT overridden.
 *                                     Caller returns this to stop
 *                                     evaluation for the whole event.
 *   - `"no-fire"`                   — rule didn't match this candidate.
 *                                     Caller continues to the next
 *                                     candidate (bash) or next rule
 *                                     (write / edit).
 *   - `"overridden"`                — rule fired but an override comment
 *                                     was accepted + audit-logged.
 *                                     Caller moves to the next rule;
 *                                     for bash that also means stopping
 *                                     the ref loop (override covers the
 *                                     whole tool_call per v1 semantics).
 */
type CandidateOutcome = ToolCallEventResult | "no-fire" | "overridden";

/**
 * Run a rule's predicate chain (pattern → requires → unless → when).
 * Returns the built {@link PredicateContext} when every predicate
 * passes (rule fires), or `null` when the chain short-circuits to
 * "no-fire" — **either** because a predicate legitimately rejected
 * the candidate, **or** because a `when`-path predicate threw.
 *
 * Throw posture is directional (issue #118, S1 refinement): a
 * `requires` fn that throws synchronously or rejects asynchronously
 * projects to satisfied (unknown → satisfied → evaluate rest), and an
 * `unless` fn that throws projects to absent (unknown → absent →
 * evaluate rest). Each throw is logged once with the rule name +
 * source. A `when`-path escape still treats the rule as NOT firing
 * (warn+skip). `MissingDescriptorError` is rethrown with rule context
 * from every catch (loud-block passthrough wins over projection).
 * Evaluation continues with the next rule.
 *
 * Unknown predicate keys (issue #75) never reach this catch on the
 * static-config path: `buildEvaluator` rejects them at load via
 * `validateWhenClauseKeys`, and the dispatcher projects them to
 * `"unknown"` (fail-closed) instead of throwing.
 *
 * Why "does not fire" (vs "block" / "abort the whole evaluate"):
 *   - Mirrors the observer-dispatcher's per-observer isolation —
 *     one broken predicate must not poison the rest of the rule list.
 *   - A buggy predicate blocking everything would be worse UX than
 *     a buggy predicate silently failing — the block reason would
 *     leak the raw error message to the LLM (the pre-hardening
 *     behaviour). Top-level engine-throws still fail CLOSED; see
 *     {@link evaluateEvent}.
 */
async function runPredicateChain(
  rule: Rule,
  cand: Candidate,
  shared: SharedEvalContext,
): Promise<PredicateContext | null> {
  const source = shared.ruleSources.get(rule) ?? "user";
  // Explicit passthrough (issue #107, absent-descriptor goes loud):
  // a missing descriptor is a fail-CLOSED config hole, NOT a buggy
  // predicate — swallowing it here would fail OPEN. Attach rule
  // context and rethrow to `evaluateEvent`'s top catch BEFORE any
  // warn+project. MDE always wins over projection (unknown predicate
  // keys never reach here on the static-config path — rejected at load
  // by `validateWhenClauseKeys`, projected fail-closed at runtime).
  // Single hierarchy site shared by the per-clause catches below and
  // the shared backstop catch (issue #118) — MDE always wins,
  // everything else projects. MDE never warns; it blocks loud at the
  // top catch (`evaluateEvent`'s rule-tagged descriptor branch).
  // No intermediate catch sits between here and the top catch on the
  // rule path (`evaluateCandidate` awaits bare; `onFire`'s catch wraps
  // `onFire` only; the `evaluateEventInner` rule loop awaits bare).
  const rethrowIfMissingDescriptor = (err: unknown): void => {
    if (err instanceof MissingDescriptorError) {
      err.ruleName = rule.name;
      err.source = source;
      throw err;
    }
  };
  try {
    if (rule.tool === "bash") {
      // Exact-equality first filter (issue #117): routing, never
      // regex, never substring, no text touch. Mismatch exits before
      // ctx alloc (the same cheap-first position `pattern` occupied).
      // Nameless refs (`basename === undefined` — bare `VAR=x`
      // chains) never match: no throw (carve-out preserved). An empty
      // array never matches (mirrors the empty-`anyOf` invalid rule).
      const cmds = Array.isArray(rule.command) ? rule.command : [rule.command];
      const basename = cand.input.basename;
      if (basename === undefined || !cmds.includes(basename)) return null;
    } else if (!matchesPattern(rule.pattern, cand.target)) {
      // Write / edit rules keep `pattern` as their whole mechanism.
      // Pattern-miss is the common case; exit before allocating ctx.
      return null;
    }

    // Per-ref facade binding via the hoisted `arityOf` (issue #110): resolve
    // the descriptor for this ref's basename once per tool_call (cached),
    // bind its arity into the facade view (same arity the ARGV leaves
    // resolve). Nameless refs → EMPTY_ARITY via arityOf, never throw.
    const arity = arityOf(
      cand.input.basename,
      shared.descriptors,
      shared.arityCache,
    );
    const ctx: PredicateContext = {
      cwd: cand.cwd,
      tool: cand.tool,
      input: cand.input,
      command: commandFromInput(cand.input, arity),
      agentLoopIndex: shared.agentLoopIndex,
      exec: shared.exec,
      appendEntry: shared.appendEntry,
      findEntries: shared.findEntries,
      ...(cand.walkerState !== undefined
        ? { walkerState: cand.walkerState }
        : {}),
    };

    if (rule.requires !== undefined) {
      let ok: boolean;
      try {
        ok = await matchesPatternOrFn(rule.requires, cand.target, ctx);
      } catch (err) {
        rethrowIfMissingDescriptor(err);
        console.warn(
          `[pi-steering] predicate threw for rule "${rule.name}"@${source}: ${formatError(err)}`,
        );
        ok = true; // unknown → satisfied → evaluate rest (strict)
      }
      if (!ok) return null;
    }
    if (rule.unless !== undefined) {
      let ok: boolean;
      try {
        ok = await matchesPatternOrFn(rule.unless, cand.target, ctx);
      } catch (err) {
        rethrowIfMissingDescriptor(err);
        console.warn(
          `[pi-steering] predicate threw for rule "${rule.name}"@${source}: ${formatError(err)}`,
        );
        ok = false; // unknown → absent → evaluate rest (strict)
      }
      if (ok) return null;
    }
    const whenOk = await evaluateWhen(
      rule.when,
      { cwd: cand.cwd },
      ctx,
      shared.predicates,
      rule.name,
      source,
      "block",
      false,
      shared.descriptors,
      shared.arityCache,
    );
    if (!whenOk) return null;

    return ctx;
  } catch (err) {
    // Shared backstop (when-path escapes, `arityOf` binding throws,
    // pattern edges): warn+skip posture unchanged (S1). Per-clause
    // throws never reach here — the requires/unless catches above
    // swallow non-MDE after a single warn and rethrow only MDE.
    rethrowIfMissingDescriptor(err);
    console.warn(
      `[pi-steering] predicate threw for rule "${rule.name}"@${source}: ${formatError(err)}`,
    );
    return null;
  }
}

/**
 * Evaluate one candidate against one rule. This is the single pipeline
 * every tool funnels through — differences between bash, write, and
 * edit live entirely in the {@link Candidate} input.
 *
 * Evaluation order (short-circuits on first failure):
 *
 *   1. Tool filter — bash: exact `command:` basename equality vs
 *                     the ref (routing first, resolution second);
 *                     write/edit: `pattern` match. A miss exits
 *                     before allocating the predicate context.
 *   2. `requires`  — optional AND.
 *   3. `unless`    — optional exemption.
 *   4. `when`      — clause tree (`cwd`, `not`, `condition`, plugin
 *                     predicates).
 *
 * All four steps are wrapped in try/catch via
 * {@link runPredicateChain} — a throw is logged (sole exception:
 * `MissingDescriptorError`, which every catch rethrows with rule
 * context to the top-level fail-closed catch — absent descriptors
 * fail CLOSED, never silent). Projection is directional (issue #118):
 * a throwing `requires` fn counts as satisfied and a throwing `unless`
 * fn counts as absent (chain continues — strict); only `when`-path
 * escapes are treated as "rule did not fire". That way a
 * whole rule list (a broken guardrail rule silently poisoning the
 * rest) nor leaks its raw `error.message` back to the agent via a
 * pi-level error tool_result.
 *
 * On rule fire, check for an override comment addressing the rule by
 * name (unless the rule opts out of overrides). An accepted override
 * logs a `steering-override` audit entry and returns `"overridden"`.
 */
async function evaluateCandidate(
  rule: Rule,
  cand: Candidate,
  shared: SharedEvalContext,
): Promise<CandidateOutcome> {
  const ctx = await runPredicateChain(rule, cand, shared);
  if (ctx === null) return "no-fire";

  // Registry exemption check. Sits BETWEEN the when-match and the
  // override-comment check: if any exemption clause for this rule
  // matches the candidate, the rule does NOT fire — evaluation
  // continues to the next rule exactly as if the rule had missed.
  // `onFire` and the `steering-override` audit entry never run. When
  // an exemption clause AND an override comment are both present,
  // the exemption wins — no audit entry (the rule never fired).
  // Override-commented commands on a NON-exempted rule keep today's
  // behavior byte-identical (audit entry + "overridden").
  const exemptionClauses = shared.exemptions.get(rule.name);
  if (exemptionClauses !== undefined) {
    for (const clause of exemptionClauses) {
      if (await evaluateExemptionClause(clause, cand, ctx, shared, rule.name)) {
        return "no-fire";
      }
    }
  }

  // Rule fires. Check for override (if allowed) before committing to
  // blocking.
  const noOverride = effectiveNoOverride(rule, shared.defaultNoOverride);
  if (!noOverride) {
    const reason = extractOverride(cand.overrideCarrier, rule.name);
    if (reason !== null) {
      // Go through the wrapped `shared.appendEntry` so the
      // `_agentLoopIndex` auto-tag lands on the audit entry. Rules
      // using `when.missing: { event: "steering-override", in:
      // "agent_loop" }` rely on the tag to filter overrides by the
      // current loop; a direct `host.appendEntry` here would bypass
      // the wrapper and leave the entry invisible to that predicate.
      shared.appendEntry("steering-override", {
        rule: rule.name,
        reason,
        ...cand.overrideEntryExtras,
        timestamp: new Date().toISOString(),
      });
      return "overridden";
    }
  }

  // Block is going to fire. Run the optional side-effect hook before
  // returning the verdict — rules using `onFire` to self-mark (e.g.
  // "write a session entry so my next attempt this agent loop passes")
  // need the write to land before the agent sees the block. Override
  // paths above already returned, so onFire is skipped when the rule
  // was overridden; fail-closed defaults with no override comment fall
  // through here normally.
  //
  // Fail-closed semantics on onFire errors: a sync throw or rejected
  // promise is logged and SWALLOWED — the block still returns. The
  // block decision already passed every predicate; a broken
  // best-effort side effect must not silently invalidate it. Mirrors
  // the observer-dispatcher's per-observer try/catch (observers are
  // isolated for the same reason).
  if (rule.onFire) {
    try {
      await rule.onFire(ctx);
    } catch (err) {
      console.warn(
        `[pi-steering] onFire for rule "${rule.name}" threw: ${formatError(err)}`,
      );
    }
  }

  return {
    block: true,
    reason: await formatReason(
      rule,
      cand.tool,
      noOverride,
      shared.ruleSources.get(rule) ?? "user",
      ctx,
    ),
  };
}

/**
 * Evaluate one exemption clause against a candidate whose target rule
 * already matched its full predicate chain. Returns `true` when the
 * clause MATCHES — the rule must not fire.
 *
 * Exemption evaluation is fail-CLOSED in the direction that protects
 * the guard (S1):
 *
 *   - `evaluateWhen` runs with the `"allow"`-default projection
 *     (`onUnknownDefault: "allow"`): walker-unknown cwd, throwing
 *     handlers, and `condition:` throws all project to "does not
 *     match" → no exemption → the target guard still fires. (The
 *     stock rule-side default `"block"` would project unknown to
 *     TRUE — clause-true means exempt, so it would fail-OPEN the
 *     guard.)
 *   - STRICT: explicit `onUnknown:` modifiers inside the clause are
 *     IGNORED (`ignoreExplicitModifiers: true` — the projection is
 *     hard "allow" at all four sites). Even an `as any`-smuggled
 *     `onUnknown: "block"` never exempts on unknown; the type-level
 *     ban (`ExemptionWhenClause`) and the load-time rejection
 *     (`validateExemptionWhenClauseShape`) are the other two layers.
 *   - Escapes `evaluateWhen` does not swallow (`evaluateMissing`
 *     shape throws, …) are caught HERE, per
 *     exemption — a throwing exemption predicate = "does not match"
 *     = guard fires. Warn logs label the EXEMPTION, not the target
 *     rule (`Rule "<target>"@<src>` would be misleading).
 *
 * Exported for unit pins of the exemption-catch composition
 * (`MissingDescriptorError` on the exemption path → non-match →
 * guard fires); not part of the package root surface.
 */
export async function evaluateExemptionClause(
  clause: TopLevelWhenClause<string>,
  cand: Candidate,
  ctx: PredicateContext,
  shared: SharedEvalContext,
  ruleName: string,
): Promise<boolean> {
  try {
    return await evaluateWhen(
      clause,
      { cwd: cand.cwd },
      ctx,
      shared.predicates,
      ruleName,
      "exemption",
      "allow",
      true, // ignoreExplicitModifiers — strict fail-closed (S1)
      shared.descriptors,
      shared.arityCache,
    );
  } catch (err) {
    console.warn(
      `[pi-steering] exemption for rule "${ruleName}" threw: ${formatError(err)}`,
    );
    return false;
  }
}

async function evaluateEvent(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  agentLoopIndex: number,
  rules: readonly Rule[],
  trackers: Record<string, Tracker<unknown>>,
  predicates: ResolvedPluginState["predicates"],
  host: EvaluatorHost,
  defaultNoOverride: boolean,
  ruleSources: ReadonlyMap<Rule, string>,
  allObservers: readonly Observer[],
  exemptions: ReadonlyMap<string, readonly TopLevelWhenClause<string>[]>,
  descriptors: Record<string, import("./schema.ts").CLIDescriptor> = {},
): Promise<ToolCallEventResult | void> {
  // Top-level fail-closed wrap (S1). If the engine's own scaffolding
  // throws — parse errors, walker bugs, corrupted session JSONL, etc.
  // — we block the tool AS A SAFETY MEASURE and tag the reason so the
  // agent sees it came from the engine, not from a rule or plugin.
  // Per-predicate throws are handled one level down in
  // {@link runPredicateChain} (treated as "rule does not fire"); this
  // outer wrap only catches throws OUTSIDE the per-rule try/catch.
  try {
    return await evaluateEventInner(
      event,
      ctx,
      agentLoopIndex,
      rules,
      trackers,
      predicates,
      host,
      defaultNoOverride,
      ruleSources,
      allObservers,
      exemptions,
      descriptors,
    );
  } catch (err) {
    // Rule-tagged descriptor block (issue #107): the per-ref binding
    // (or a leaf) rethrew `MissingDescriptorError` with rule context
    // attached — emit an ACTIONABLE block naming rule + basename +
    // remedy (ask the user), NOT the generic engine-error reason.
    // Generic engine-error path below stays byte-identical.
    if (err instanceof MissingDescriptorError && err.ruleName !== undefined) {
      const tag = `[steering:${err.ruleName}@${err.source ?? "user"}]`;
      return {
        block: true,
        reason:
          `${BLOCK_REASON_PREAMBLE}\n\n${tag} ` +
          `${missingDescriptorRemedy(err.basename)} ` +
          `Ask the user to declare it.`,
      };
    }
    console.error(`[pi-steering] steering engine threw: ${formatError(err)}`);
    return {
      block: true,
      reason:
        `${ENGINE_ERROR_PREAMBLE}\n\n` +
        "[steering:engine@internal] steering engine error; " +
        "tool blocked as a safety measure",
    };
  }
}

async function evaluateEventInner(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  agentLoopIndex: number,
  rules: readonly Rule[],
  trackers: Record<string, Tracker<unknown>>,
  predicates: ResolvedPluginState["predicates"],
  host: EvaluatorHost,
  defaultNoOverride: boolean,
  ruleSources: ReadonlyMap<Rule, string>,
  allObservers: readonly Observer[],
  exemptions: ReadonlyMap<string, readonly TopLevelWhenClause<string>[]>,
  descriptors: Record<string, import("./schema.ts").CLIDescriptor> = {},
): Promise<ToolCallEventResult | void> {
  // Shared per-call closures: exec memoized by (cmd, args, cwd);
  // findEntries reads the current session JSONL on demand; appendEntry
  // auto-tags writes with `_agentLoopIndex` so rules using
  // `when.missing` can filter by agent-loop scope.
  //
  // findEntries + appendEntry share a session-entry cache so a write
  // performed by an earlier rule's onFire (or by the override-audit
  // path) invalidates the cached read — later rules' when.missing
  // predicates see the fresh write instead of a stale snapshot
  // (S2/E1). The evaluator itself doesn't interleave writes with reads,
  // but onFire + override-audit do.
  const exec = createExecCache(host, ctx.cwd);
  const entryCache = createSessionEntryCache();
  const findEntries = createFindEntries(ctx, entryCache);
  const appendEntry = createAppendEntry(host, agentLoopIndex, entryCache);

  const shared: SharedEvalContext = {
    agentLoopIndex,
    predicates,
    exec,
    appendEntry,
    findEntries,
    host,
    defaultNoOverride,
    ruleSources,
    exemptions,
    descriptors,
    // Per-tool_call arity hoist (issue #110): created ONCE here, dies with
    // the call; O(distinct basenames). runPredicateChain / evaluateBashRule
    // only thread it, never create.
    arityCache: new Map(),
  };

  // Bash state is lazy: non-bash rules don't pay for parse / walk.
  let bashState: BashRefState[] | null = null;
  const bashEvent = isToolCallEventType("bash", event) ? event : null;

  // Edit events share `allNewText` across every field="content" rule.
  // Computed lazily on the first edit rule so a config with only bash /
  // write rules doesn't pay the join cost. `null` sentinel is safe
  // because `edits` is always a non-null array on edit events.
  const editEvent = isToolCallEventType("edit", event) ? event : null;
  let editAllNewText: string | null = null;

  for (const rule of rules) {
    if (rule.tool !== event.toolName) continue;

    if (rule.tool === "bash") {
      if (!bashEvent) continue;
      if (bashState === null) {
        bashState = prepareBashState(
          bashEvent.input.command,
          ctx.cwd,
          trackers,
          allObservers,
        );
      }
      const result = await evaluateBashRule(
        rule,
        bashEvent.input.command,
        bashState,
        shared,
      );
      if (result !== undefined) return result;
      continue;
    }

    if (rule.tool === "write" && isToolCallEventType("write", event)) {
      const target =
        rule.field === "path" ? event.input.path : event.input.content;
      const result = await evaluateWriteEditRule(
        rule,
        {
          tool: "write",
          path: event.input.path,
          content: event.input.content,
          // Shell env assignments don't apply to file-surface tools;
          // shape as `[]` rather than `undefined` so plugin authors
          // can treat the field uniformly across tools.
          envAssignments: [],
        },
        target,
        // override-comment scanned against content (the natural
        // carrier for write override comments — v1 parity).
        event.input.content,
        event.input.path,
        ctx.cwd,
        shared,
      );
      if (result !== undefined) return result;
      continue;
    }

    if (rule.tool === "edit" && editEvent) {
      // Joined newText is needed as override carrier for EVERY edit
      // rule plus as `target` for field="content" rules. Compute once
      // per tool_call on the first edit rule, reuse for the rest.
      if (editAllNewText === null) {
        editAllNewText = editEvent.input.edits.map((e) => e.newText).join("\n");
      }
      const target =
        rule.field === "path" ? editEvent.input.path : editAllNewText;
      const result = await evaluateWriteEditRule(
        rule,
        {
          tool: "edit",
          path: editEvent.input.path,
          edits: editEvent.input.edits,
          // See the write branch above: `[]` for uniform shape.
          envAssignments: [],
        },
        target,
        editAllNewText,
        editEvent.input.path,
        ctx.cwd,
        shared,
      );
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

/**
 * Per-rule bash evaluation. Iterates every extracted command ref as
 * a {@link Candidate}. The first ref that fires the rule (pattern +
 * requires + unless + when) decides the verdict. Per v1 semantics, an
 * accepted override covers the whole tool_call — we stop scanning
 * further refs and hand control back to the caller.
 */
async function evaluateBashRule(
  rule: Rule,
  rawCommand: string,
  state: BashRefState[],
  shared: SharedEvalContext,
): Promise<ToolCallEventResult | void> {
  for (const refState of state) {
    const cand: Candidate = {
      target: refState.text,
      cwd:
        typeof refState.walkerState["cwd"] === "string"
          ? (refState.walkerState["cwd"] as string)
          : "unknown",
      input: {
        tool: "bash",
        command: refState.text,
        // Nameless refs omit `basename` (`exactOptionalPropertyTypes`:
        // no explicit `undefined`) — downstream treats absent as
        // skip-resolution, same as `undefined`.
        ...(refState.basename !== undefined
          ? { basename: refState.basename }
          : {}),
        args: refState.args,
        envAssignments: refState.envAssignments,
      },
      overrideCarrier: rawCommand,
      tool: "bash",
      overrideEntryExtras: { command: rawCommand },
      walkerState: refState.walkerState,
    };
    const r = await evaluateCandidate(rule, cand, shared);
    if (r === "no-fire") continue;
    if (r === "overridden") return undefined; // v1: override covers whole tool_call
    return r;
  }
  return undefined;
}

/**
 * Per-rule write / edit evaluation. Produces a single {@link Candidate}
 * and defers to {@link evaluateCandidate}.
 *
 * `target` is the pre-resolved string the rule's pattern tests against
 * — the caller computes it once per rule (reading `path` or the joined
 * `newText`), which lets edit tool_calls share the join across every
 * field="content" rule. `overrideCarrier` is the text scanned for
 * override comments (per v1 parity, content / joined newText even for
 * field="path" rules).
 */
async function evaluateWriteEditRule(
  rule: Rule,
  input: PredicateToolInput,
  target: string,
  overrideCarrier: string,
  path: string,
  sessionCwd: string,
  shared: SharedEvalContext,
): Promise<ToolCallEventResult | void> {
  const cand: Candidate = {
    target,
    cwd: sessionCwd,
    input,
    overrideCarrier,
    tool: rule.tool as "write" | "edit",
    overrideEntryExtras: { path },
  };
  const r = await evaluateCandidate(rule, cand, shared);
  if (r === "no-fire" || r === "overridden") return undefined;
  return r;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Format an unknown thrown value for a warning log. Shared across the
 * three places the evaluator catches throws:
 *
 *   - per-predicate try/catch in {@link runPredicateChain} (S1).
 *   - per-rule `onFire` try/catch in {@link evaluateCandidate}.
 *   - top-level engine try/catch in {@link evaluateEvent}.
 *
 * Mirrors the observer-dispatcher's `formatError` so the log shape
 * stays consistent across the two hook surfaces: `message\nstack` for
 * proper Errors, best-effort JSON otherwise, falling through to
 * `String(err)`.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.message}\n${err.stack ?? ""}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Re-export supporting types for consumers embedding the evaluator.
export type { EvaluatorHost } from "./evaluator-internals/context.ts";
