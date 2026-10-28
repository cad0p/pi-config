// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Testing primitives for rule and plugin authors.
 *
 * Subpath export: `@cad0p/pi-steering/testing`. Also re-exported
 * at the package root for discoverability.
 *
 * Phase 5a ships four low-level primitives that wrap the engine's
 * internals without forcing authors to stand up a pi runtime stub:
 *
 *   - {@link loadHarness}         — build an evaluator + dispatcher
 *                                    pair from a static
 *                                    {@link SteeringConfig}. No
 *                                    filesystem discovery — tests
 *                                    pass explicit config.
 *   - {@link mockContext}         — build a {@link PredicateContext}
 *                                    for unit-testing predicate
 *                                    handlers in isolation.
 *   - {@link mockObserverContext} — same for {@link ObserverContext}.
 *   - {@link getAppendedEntries}  — read back `appendEntry` writes
 *                                    captured by either mock context.
 *
 * The convenience wrappers (`testPredicate`, `expectBlocks`,
 * `runMatrix`, …) that build on these live in a Phase 5b follow-up.
 *
 * Design notes:
 *
 *   - `exec` is deliberately stub-required. The defaults reject with a
 *     clear error so a test forgetting to stub fails loudly instead of
 *     silently evaluating predicates against an always-empty exec
 *     result.
 *   - `appendEntry` captures are tracked in a module-level WeakMap
 *     keyed by the context object, so {@link getAppendedEntries}
 *     accesses cleanly without leaking state across tests and without
 *     requiring users to pass capture buffers around.
 *   - `findEntries` draws from an entries array passed in at context
 *     build time; it does NOT pick up entries written via the
 *     context's own `appendEntry`. That mirrors the production
 *     evaluator's per-call snapshot semantics — appends are visible
 *     on the NEXT evaluation, not the current one.
 */

import type { Tracker } from "@cad0p/unbash-walker";
import type {
  ExtensionContext,
  ExecResult as PiExecResult,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { arityOf } from "../arity.ts";
import {
  buildEvaluator,
  EVALUATOR_BUILTIN_TRACKERS,
  type EvaluatorHost,
  type EvaluatorRuntime,
} from "../evaluator.ts";
import {
  AGENT_LOOP_INDEX_KEY,
  createAppendEntry,
  isPlainObject,
} from "../evaluator-internals/context.ts";
import type { SyntheticEntry } from "../evaluator-internals/speculative-synthesis.ts";
import {
  BLOCK_REASON_PREAMBLE,
  ENGINE_ERROR_PREAMBLE,
} from "../helpers/block-reason-preamble.ts";
import { commandFromInput } from "../helpers/command.ts";
import { finalizePluginState } from "../internal/finalize-plugin-state.ts";
import { runMergerPipeline } from "../internal/session-runtime.ts";
import { WATCH_DEFAULT_WALK } from "../internal/walk-registry.ts";
import { extractRefTextsForBash } from "../internal/watch-matcher.ts";
import {
  buildObserverDispatcher,
  matchesWatch,
  type ObserverDispatcher,
} from "../observer-dispatcher.ts";
import type { ResolvedPluginState } from "../plugin-merger.ts";
import type {
  ExecOpts,
  ExecResult,
  Observer,
  ObserverContext,
  PredicateContext,
  PredicateHandler,
  PredicateToolInput,
  PredicateVerdict,
  ToolResultEvent as SchemaToolResultEvent,
  SteeringConfig,
  SteeringDiagnostic,
  WhenWalkerState,
} from "../schema.ts";

// ---------------------------------------------------------------------------
// Capture tracking
// ---------------------------------------------------------------------------

/**
 * Entry shape recorded by a mock context's `appendEntry`. Mirrors the
 * call signature `appendEntry<T>(customType, data?)`; `data` is
 * optional because pi's API accepts a bare customType.
 */
interface CapturedEntry {
  readonly customType: string;
  readonly data?: unknown;
}

/**
 * Global, per-context append buffers. Weak so dropped contexts free
 * the buffer. Never holds a reference to the test's context object
 * itself beyond the weak slot.
 */
const appendBuffers = new WeakMap<object, CapturedEntry[]>();

/**
 * Minimal {@link EvaluatorHost} whose `appendEntry` pushes into the
 * given capture buffer. Used by {@link mockContext} /
 * {@link mockObserverContext} to share the production
 * `createAppendEntry` wrapper: the wrapper expects an
 * `EvaluatorHost`, and wiring a buffering host here lets the mocks
 * auto-tag writes with `_agentLoopIndex` in the exact same shape the
 * real engine and dispatcher produce.
 *
 * `exec` is stubbed to reject — it's never touched on this path
 * (`createAppendEntry` only calls `host.appendEntry`) but has to be
 * present to satisfy the {@link EvaluatorHost} shape.
 */
function bufferingAppendHost(buffer: CapturedEntry[]): EvaluatorHost {
  return {
    exec: () =>
      Promise.reject(
        new Error(
          "[@cad0p/pi-steering/testing] internal: bufferingAppendHost.exec " +
            "should never be called",
        ),
      ),
    appendEntry: (customType: string, data?: unknown) => {
      buffer.push({
        customType,
        ...(data !== undefined ? { data } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build-once, invoke-many handle a test uses to drive the engine
 * against a scenario. `evaluate` and `dispatch` have identical
 * signatures to {@link EvaluatorRuntime.evaluate} and
 * {@link ObserverDispatcher.dispatch} so production call sites can be
 * ported verbatim.
 */
export interface Harness {
  /** See {@link EvaluatorRuntime.evaluate}. */
  evaluate: EvaluatorRuntime["evaluate"];
  /** See {@link ObserverDispatcher.dispatch}. */
  dispatch: ObserverDispatcher["dispatch"];
  /**
   * The effective config the harness was built from (after default
   * injection and `disable` filtering).
   *
   * No-op short-circuit caveat: when `harness.diagnostics` has an
   * error-class entry, treat `harness.config` as the post-merge,
   * post-disabledRules-filter snapshot pi-steering would have
   * handed to `buildEvaluator` if the diagnostics had been clean —
   * provided as a debugging artifact, NOT an executable config
   * production would accept (production would have thrown).
   * Inspect `harness.diagnostics` first to learn which surface
   * flagged a problem, then fix the source config and re-load
   * before reading `config` for any "production would have run on
   * this shape" interpretation.
   */
  readonly config: SteeringConfig;
  /**
   * The plugin merger's resolved state, for introspection /
   * assertions.
   *
   * No-op short-circuit caveat: when an error-class diagnostic fires
   * and the harness returns the no-op evaluator/dispatcher pair,
   * `resolved.diagnostics` carries the FULL diagnostic list (merge-
   * side + user-config-name + resolve-side) to mirror
   * `harness.diagnostics`. In the regular path, `resolved.diagnostics`
   * carries only the resolve-side stream — see
   * {@link SteeringDiagnosticKind} for the per-kind
   * loader-vs-merger split. Consumers should prefer
   * `harness.diagnostics` for the canonical full list.
   */
  readonly resolved: ResolvedPluginState;
  /**
   * Every {@link SteeringDiagnostic} produced while building the
   * harness — merge-side (within-layer collisions, cross-bucket
   * rule-collision warnings between inline rules and plugin-shipped
   * rules) and plugin-merger-side (predicate / observer / rule /
   * extension-orphan / reserved-name / invalid-name diagnostics,
   * plus user-config rule and observer name validation).
   *
   * Unlike production, `loadHarness` does NOT throw on error-class
   * diagnostics. Plugin-author tests assert directly on this array
   * (e.g. `harness.diagnostics.some(d => d.kind === "reserved-tracker-name")`)
   * so the failure surface is observable in test output rather than
   * a thrown error that hides which other diagnostics fired. Both
   * plugin-shipped and user-config malformed names route through the
   * same `kind: "invalid-name"` diagnostic stream — plugin-author
   * tests can use a uniform matrix of malformed-name cases without
   * worrying about which surface raised the issue.
   *
   * Production-strictness divergence: `loadHarness` does NOT honor
   * the merged config's `failOnWarnings` flag. Production's
   * `buildSessionRuntime` throws when `failOnWarnings !== false`
   * (default `true`) AND any warning-class diagnostic is present;
   * the harness ignores `failOnWarnings` and returns a real
   * evaluator/dispatcher running on the post-collision merged
   * state. Tests intending to use the harness as a "production
   * prediction" should check this array against the strict-mode
   * rule themselves, e.g.
   * `harness.diagnostics.some(d => d.type === "error" || (config.failOnWarnings !== false && d.type === "warning"))`
   * before treating the harness's verdict as production-faithful.
   */
  readonly diagnostics: readonly SteeringDiagnostic[];
}

/**
 * Options for {@link loadHarness}.
 */
export interface LoadHarnessOptions {
  /** The config under test. */
  readonly config: SteeringConfig;

  /**
   * Host to drive `exec` / `appendEntry` off. Defaults to an
   * in-memory stub whose `exec` rejects with a clear error (tests
   * needing exec must stub it explicitly) and whose `appendEntry`
   * is a silent sink.
   */
  readonly host?: EvaluatorHost;
}

/**
 * Build an evaluator + observer dispatcher pair from a static
 * {@link SteeringConfig}. Tests drive rules through the same pipeline
 * production uses, without filesystem discovery.
 */
export function loadHarness(options: LoadHarnessOptions): Harness {
  const inputConfig = options.config;

  // Run the same merge that production does (single layer here, since
  // loadHarness operates on an in-memory config rather than a
  // filesystem discovery chain). The shared helper short-circuits
  // between buildConfig and
  // resolvePlugins on error-class merge diagnostics so a
  // `tracker-name-collision` flagged by `buildConfig` is not also
  // re-flagged by `resolvePlugins`. The diagnostics surface within-
  // layer rule-name and observer-name collisions, plus tracker-name
  // collisions and cross-bucket rule-collision warnings between
  // inline rules and declared plugins' shipped rules.
  const {
    merged: mergedConfig,
    resolved,
    diagnostics,
  } = runMergerPipeline([inputConfig], EVALUATOR_BUILTIN_TRACKERS);

  // Apply `config.disabledRules` to user rules. Plugin-shipped
  // rules are filtered inside `resolvePlugins`. Mirrors
  // `buildSessionRuntime`.
  const disabled = new Set(mergedConfig.disabledRules ?? []);
  const filteredConfig: SteeringConfig = { ...mergedConfig };
  if (mergedConfig.rules !== undefined) {
    const kept = mergedConfig.rules.filter((r) => !disabled.has(r.name));
    if (kept.length > 0) filteredConfig.rules = kept;
    else delete filteredConfig.rules;
  }

  // Aggregate every diagnostic produced during construction. Unlike
  // `buildSessionRuntime`, loadHarness does NOT throw on error-class
  // diagnostics — plugin-author tests assert on the array directly so
  // they can see every diagnostic that fired in one read.
  //
  // Short-circuit on ANY error-class diagnostic — from the cross-
  // layer merge (`buildConfig`'s `detectTrackerNameCollisions`) or
  // from the plugin merger (`reserved-tracker-name`,
  // `reserved-predicate-key`, `invalid-name`, `tracker-name-collision`).
  // All error-class diagnostics produce the same no-op harness so
  // plugin-author tests see uniform behavior regardless of which
  // surface flagged the problem. Mirrors production's bridge-disabled
  // state under the same conditions.
  if (resolved === null || diagnostics.some((d) => d.type === "error")) {
    return buildNoopHarness(filteredConfig, diagnostics);
  }

  // Mirror session-runtime's unused-observer drop so loadHarness
  // tests produce the same verdicts as production for rules that
  // rely on observer writes.
  const { pluginKept, userKept } = finalizePluginState(
    filteredConfig.rules ?? [],
    resolved.rules,
    filteredConfig.observers ?? [],
    resolved.observers,
    filteredConfig.exemptions ?? [],
    resolved.exemptions ?? [],
  );
  const filteredResolved = { ...resolved, observers: [...pluginKept] };

  const host = options.host ?? defaultHarnessHost();
  const evaluator = buildEvaluator(filteredConfig, filteredResolved, host);
  const dispatcher = buildObserverDispatcher(filteredResolved, userKept, host);

  return {
    evaluate: evaluator.evaluate,
    dispatch: dispatcher.dispatch,
    config: filteredConfig,
    resolved: filteredResolved,
    diagnostics,
  };
}

/**
 * Build a no-op {@link Harness} that surfaces the given diagnostics
 * but doesn't drive the evaluator / dispatcher. Used when an
 * error-class loader diagnostic prevents safe construction of the
 * runtime; mirrors production's bridge-disabled state under the same
 * conditions.
 */
function buildNoopHarness(
  config: SteeringConfig,
  diagnostics: readonly SteeringDiagnostic[],
): Harness {
  const emptyResolved: ResolvedPluginState = {
    predicates: {},
    observers: [],
    trackers: {},
    trackerModifiers: {},
    composedTrackers: {},
    cliDescriptors: {},
    rules: [],
    rulePluginOwners: {},
    // Mirror harness.diagnostics so consumers reading either surface
    // (harness.resolved.diagnostics or harness.diagnostics) see the
    // same list. Otherwise harness.resolved.diagnostics would be
    // silently empty in the no-op short-circuit branch while the
    // outer harness.diagnostics carries the real entries.
    diagnostics: [...diagnostics],
  };
  return {
    evaluate: async () => {},
    dispatch: async () => {},
    config,
    resolved: emptyResolved,
    diagnostics: [...diagnostics],
  };
}

/**
 * Default in-memory host for {@link loadHarness}. `exec` rejects
 * explicitly — authors needing a stub pass their own host. `appendEntry`
 * is a silent sink (writes into a throwaway array not exposed on the
 * return).
 */
function defaultHarnessHost(): EvaluatorHost {
  return {
    exec: () =>
      Promise.reject(
        new Error(
          "loadHarness: exec not stubbed — pass options.host with an exec implementation",
        ),
      ),
    appendEntry: () => {},
  };
}

// ---------------------------------------------------------------------------
// mockContext
// ---------------------------------------------------------------------------

/**
 * Shape of an entry fed into {@link mockContext} / {@link
 * mockObserverContext} to back `findEntries`. Mirrors the subset of
 * pi's `CustomEntry` the evaluator + dispatcher actually read.
 */
export interface MockEntry {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
  readonly timestamp: string;
}

/**
 * Options for {@link priorEntry}.
 */
export interface PriorEntryOptions {
  /**
   * Agent-loop index to stamp on the payload. The engine's live
   * `appendEntry` wrapper stamps this automatically on every write;
   * fixture entries must reproduce the same shape so `when.missing:
   * { in: "agent_loop" }` scope filtering works identically whether
   * the entry was written at runtime or seeded into the mock.
   *
   * Defaults to `0`. Set to the value of {@link MockContextOptions.agentLoopIndex}
   * to place the entry in the current agent loop; set to a lower
   * value (or 0 with `agentLoopIndex: 1+` on the context) to place
   * it in a prior agent loop.
   */
  readonly agentLoopIndex?: number;

  /**
   * ISO-8601 timestamp string. Defaults to `"2026-01-01T00:00:00.000Z"`.
   * Use distinct, monotonically-increasing timestamps when seeding
   * multiple entries the `since` invalidation sentinel needs to
   * order.
   */
  readonly timestamp?: string;
}

/**
 * Build a {@link MockEntry} for {@link MockContextOptions.entries}
 * (and the observer-context equivalent) with the reserved
 * `_agentLoopIndex` tag stamped on the payload exactly as the live
 * engine's `appendEntry` wrapper would.
 *
 * The reserved-key name is kept as an internal detail of the engine
 * so plugin / fixture authors don't have to remember the underscore
 * prefix. A typo on the `agentLoopIndex` field of {@link PriorEntryOptions}
 * is a TypeScript compile error; the equivalent typo on a hand-rolled
 * `data: { agentLoopIndex: 5 }` literal is silent — the entry passes
 * through `findEntries` but then fails to match the current
 * agent-loop scope, and the rule under test appears to misbehave.
 *
 * Payload shaping mirrors the live `createAppendEntry`:
 *   - Plain-object `data`: merged as `{ ...data, _agentLoopIndex }`.
 *   - Anything else (arrays, Date, Map, Set, Error, primitives,
 *     null, undefined): wrapped as `{ value: data, _agentLoopIndex }`.
 *
 * @example
 *   const ctx = mockContext({
 *     agentLoopIndex: 5,
 *     entries: [
 *       priorEntry("ws-sync-done", {}, { agentLoopIndex: 5 }),
 *     ],
 *   });
 *   // `when.missing: { event: "ws-sync-done", in: "agent_loop" }`
 *   // now sees the entry as present in the current loop.
 */
export function priorEntry(
  customType: string,
  data?: unknown,
  opts?: PriorEntryOptions,
): MockEntry {
  const agentLoopIndex = opts?.agentLoopIndex ?? 0;
  const tagged = isPlainObject(data)
    ? { ...data, [AGENT_LOOP_INDEX_KEY]: agentLoopIndex }
    : { value: data, [AGENT_LOOP_INDEX_KEY]: agentLoopIndex };
  return {
    type: "custom",
    customType,
    timestamp: opts?.timestamp ?? "2026-01-01T00:00:00.000Z",
    data: tagged,
  };
}

/**
 * Re-exported for plugin authors constructing `toolCallEvents`
 * fixtures on {@link MockContextOptions}. Structurally `{ data,
 * timestamp, speculative: true }` — the same shape the walker-level
 * speculative-entry synthesis pass produces in production. Plugin
 * predicates that filter out speculative entries check
 * `entry.speculative === true`.
 */
export type { SyntheticEntry } from "../evaluator-internals/speculative-synthesis.ts";

/**
 * Options for {@link mockContext}.
 */
export interface MockContextOptions {
  /** Defaults to `"/tmp/test"`. */
  readonly cwd?: string;

  /** Engine agent-loop counter. Defaults to `0`. */
  readonly agentLoopIndex?: number;

  /**
   * Which tool this predicate is evaluating under. Defaults to
   * `"bash"`. Drives the default shape of {@link input} when the
   * caller doesn't supply one.
   */
  readonly tool?: "bash" | "write" | "edit";

  /**
   * Tool input. Omitted: derived from {@link tool} as the empty
   * shape for that tool (bash: `{ command: "" }`, write:
   * `{ path: "", content: "" }`, edit: `{ path: "", edits: [] }`).
   */
  readonly input?: PredicateToolInput;

  /**
   * Walker-state snapshot the predicate sees via
   * {@link PredicateContext.walkerState}.
   *
   * Defaults to `{ cwd: options.cwd, env: new Map() }` so the
   * built-in `when.cwd` predicate and any plugin reading
   * `walkerState.env` work without wiring up a full walker. Callers
   * who want a specific env map or branch tracker state pass it in
   * via this option.
   *
   * The typed shape is {@link WhenWalkerState} with every field
   * optional (partial) so tests that only care about one dimension
   * don't have to fill in the others. The engine's production path
   * always populates `cwd` + `env`; the mock's default matches.
   *
   * Partial override: fields you pass merge over the defaults, so
   * `mockContext({ walkerState: { cwd: "/x" } })` keeps the default
   * empty env Map (same shape as production). Pass `env` explicitly
   * only when you need a seeded map.
   */
  readonly walkerState?: Partial<WhenWalkerState> & Record<string, unknown>;

  /**
   * Stub for `ctx.exec`. Defaults to rejecting with a clear error
   * message — tests that call out to exec must stub explicitly
   * (silent `undefined` would make predicate logic hard to reason
   * about).
   */
  readonly exec?: (
    cmd: string,
    args: readonly string[],
    opts?: ExecOpts,
  ) => ExecResult | Promise<ExecResult>;

  /**
   * Prior session entries `findEntries` reads from. Filtered by
   * customType; timestamps parsed from the ISO string to epoch-ms,
   * matching the production shape.
   *
   * For rules that use `when.missing: { in: "agent_loop" }` (or
   * `in: "session"` with the same-loop filter), construct entries
   * via {@link priorEntry} so the engine's reserved
   * `_agentLoopIndex` tag is stamped correctly — hand-rolled
   * literals with a typo (`agentLoopIndex` instead of the underscore
   * form) silently fail to match the current agent-loop scope and
   * the rule appears to misbehave.
   */
  readonly entries?: ReadonlyArray<MockEntry>;

  /**
   * Per-ref speculative events the built-in `when.missing` predicate
   * reads from `ctx.walkerState.events` (see
   * {@link PredicateContext.walkerState}'s reserved `events` key).
   * Keys are the `customType` event literals; values are the
   * synthetic entries for that type. When provided, overwrites any
   * `events` entry on the caller's {@link walkerState}.
   *
   * Use this to drive `when.missing` with `in: "tool_call"` (or any plugin
   * predicate that introspects `walkerState.events`) in isolation
   * without wiring up `loadHarness` + a full bash event. The shape
   * matches what the walker-level synthesis pass produces in
   * production — `{ data, timestamp, speculative: true }` per entry.
   */
  readonly toolCallEvents?: Readonly<Record<string, readonly SyntheticEntry[]>>;

  /**
   * CLI descriptors for the facade binding symmetry (issue #110).
   * When provided, `command` binds via
   * `arityOf(input.basename, descriptors, cache)` exactly as the engine
   * does per ref. Omitted descriptors + defined basename → THROWS
   * `MissingDescriptorError` (binding symmetry — mocks don't silently
   * strict where prod loudly blocks). Nameless → silent strict.
   */
  readonly descriptors?: Readonly<
    Record<string, import("../schema.ts").CLIDescriptor>
  >;
}

/**
 * Build a {@link PredicateContext} for unit-testing predicates in
 * isolation. See {@link MockContextOptions} for defaults. The returned
 * context's `appendEntry` captures into a buffer accessible via
 * {@link getAppendedEntries}. The `command` view derives from the
 * resolved `input` — `mockContext({ input: { tool: "bash", args: […] } })`
 * drives `ctx.command` the same way the engine does.
 */
export function mockContext(
  options: MockContextOptions = {},
): PredicateContext {
  const cwd = options.cwd ?? "/tmp/test";
  const tool = options.tool ?? "bash";
  const input = options.input ?? defaultInputFor(tool);
  // Default walker state satisfies the required `cwd` + `env` fields
  // of {@link WhenWalkerState}. Callers supplying their own
  // walkerState get a shallow merge: defaults first, override last,
  // so `mockContext({ walkerState: { cwd: "/x" } })` keeps the
  // default env Map instead of dropping it (which would crash any
  // predicate that reads `ctx.walkerState.env.get(...)`). This
  // matches the production evaluator, which always populates both
  // cwd and env.
  const baseWalkerState: Record<string, unknown> = {
    cwd,
    env: new Map<string, string>(),
    ...(options.walkerState as Record<string, unknown> | undefined),
  };
  // Fold `toolCallEvents` (option) into `walkerState.events` (ctx
  // shape) the same way the evaluator's `prepareBashState` does —
  // the caller doesn't have to know the reserved-key convention.
  // Explicit option wins over any `events` entry the caller placed
  // directly on `walkerState`.
  const walkerState: Record<string, unknown> =
    options.toolCallEvents !== undefined
      ? { ...baseWalkerState, events: options.toolCallEvents }
      : baseWalkerState;
  const agentLoopIndex = options.agentLoopIndex ?? 0;
  const buffer: CapturedEntry[] = [];

  // Route through the production `createAppendEntry` wrapper so mock
  // and real engine stay in lockstep: plain-object payloads get
  // `_agentLoopIndex` merged in, everything else wraps as
  // `{ value, _agentLoopIndex }`. Without this, a rule author testing
  // their self-mark pattern via `mockContext` would see un-tagged
  // entries that would never have been written that way in
  // production, and a follow-up `when.missing: { in: "agent_loop" }`
  // simulation would disagree with the real engine.
  const bufferingHost = bufferingAppendHost(buffer);

  // Binding symmetry (issue #110): mirror the engine — per-call arityCache,
  // arityOf(input.basename, options.descriptors, cache) → commandFromInput.
  // Omitted options.descriptors + defined basename → THROW
  // MissingDescriptorError exactly as the engine does (a mock that silently
  // stricts where prod loudly blocks is a lie). Nameless → EMPTY_ARITY.
  const mockArityCache = new Map();
  const mockArity = arityOf(
    input.basename,
    options.descriptors as
      | Record<string, import("../schema.ts").CLIDescriptor>
      | undefined,
    mockArityCache,
  );
  const ctx: PredicateContext = {
    cwd,
    tool,
    input,
    command: commandFromInput(input, mockArity),
    agentLoopIndex,
    exec: buildExec(options.exec, "mockContext"),
    appendEntry: createAppendEntry(bufferingHost, agentLoopIndex),
    findEntries: buildFindEntries(options.entries ?? []),
    // Cast: mockContext's walkerState may be a user-supplied `Partial<
    // WhenWalkerState>`. The default path above fills in cwd + env;
    // explicit-override callers might omit them intentionally (testing
    // plugin predicates that don't read cwd / env). The production
    // evaluator always populates both, so tests that care match that
    // via the default. The Partial<> option shape signals "bring what
    // you need"; this cast acknowledges the resulting schema-strict
    // shape is the mock's responsibility.
    walkerState: walkerState as Readonly<WhenWalkerState>,
  };

  appendBuffers.set(ctx, buffer);
  return ctx;
}

/**
 * Shape-of-`input` default per tool. Kept narrow — just the shape
 * required by `PredicateToolInput` so unit tests don't have to invent
 * placeholder values.
 */
function defaultInputFor(tool: "bash" | "write" | "edit"): PredicateToolInput {
  switch (tool) {
    case "bash":
      return { tool: "bash", command: "" };
    case "write":
      return { tool: "write", path: "", content: "" };
    case "edit":
      return { tool: "edit", path: "", edits: [] };
  }
}

// ---------------------------------------------------------------------------
// mockObserverContext
// ---------------------------------------------------------------------------

/**
 * Options for {@link mockObserverContext}. Observers don't see
 * `tool`, `input`, or `walkerState` — those are predicate-side
 * concepts — so those fields are omitted here.
 *
 * The `walkRegistry` extension belongs HERE (not on
 * {@link MockContextOptions}): it drives the observer's
 * `watch.inputMatches.command` resolution, a watch-surface-only
 * concept.
 */
export type MockObserverContextOptions = Omit<
  MockContextOptions,
  "tool" | "input" | "walkerState" | "toolCallEvents"
> & {
  /**
   * Effective walker registry for resolving `watch.inputMatches.command`
   * on bash events. Defaults to {@link WATCH_DEFAULT_WALK} (builtin env
   * only). Pass a `buildWalkRegistry(resolved)` result (from
   * `internal/walk-registry.ts`) to test an observer against the SAME
   * plugin-composed env trackers production dispatch uses — without it,
   * the lightweight `testObserver` path can pass green while production
   * dispatch diverges (issue #54 verification-tool blind spot).
   */
  readonly walkRegistry?: Record<string, Tracker<unknown>>;
};

/**
 * Build an {@link ObserverContext} for unit-testing observer
 * `onResult` handlers. Same capture + `findEntries` pattern as
 * {@link mockContext}.
 *
 * Note: production `ObserverContext` does NOT expose `exec` — but the
 * mock does (as an `exec`-like stub on a different property name is
 * more confusing than forbidding it outright). Observer authors that
 * reach for `exec` are probably using the wrong hook; rules / plugins
 * carrying that logic belong in a predicate. The mock still accepts
 * the stub so tests composing an observer + predicate through a shared
 * options object don't have to strip the field.
 *
 * We DO NOT attach `exec` to the returned ObserverContext — the
 * schema doesn't expose it. The stub is accepted but silently unused
 * at this phase; the follow-up `testObserver` wrapper (Phase 5b) will
 * surface a warning when the stub is set but can never fire.
 */
export function mockObserverContext(
  options: MockObserverContextOptions = {},
): ObserverContext {
  const cwd = options.cwd ?? "/tmp/test";
  const agentLoopIndex = options.agentLoopIndex ?? 0;
  const buffer: CapturedEntry[] = [];

  // Same wrapper as mockContext: keeps the mock observer context
  // writing entries in the auto-tagged shape the real dispatcher
  // produces.
  const bufferingHost = bufferingAppendHost(buffer);

  const ctx: ObserverContext = {
    cwd,
    agentLoopIndex,
    appendEntry: createAppendEntry(bufferingHost, agentLoopIndex),
    findEntries: buildFindEntries(options.entries ?? []),
  };

  appendBuffers.set(ctx, buffer);
  return ctx;
}

// ---------------------------------------------------------------------------
// createRecordingHost + mockExtensionContext
// ---------------------------------------------------------------------------
//
// Low-level factories for tests that drive `harness.evaluate` /
// `harness.dispatch` directly and need to inspect what the engine
// wrote. Most plugin authors should reach for {@link loadHarness} +
// {@link expectBlocks} / {@link expectAllows} first — those cover the
// common rule-gating assertions without exposing the host/ctx surface.
//
// The factories here are the escape hatch for the 10% of tests that:
//
//   - Drive a multi-call sequence where earlier `appendEntry` writes
//     must be visible to later `findEntries` reads (self-marking rules,
//     `when.missing` gating, observer → rule handoff).
//   - Assert the exact shape of `appendEntry` writes (audit entries,
//     tracker state) without going through a shorthand expectation.
//   - Compose a custom {@link EvaluatorHost} for an existing
//     {@link loadHarness} call while still getting typed access to
//     recorded exec / appendEntry calls.
//
// Use {@link createRecordingHost} with {@link loadHarness} as follows:
//
// ```ts
// const host = createRecordingHost();
// const ctx = mockExtensionContext("/tmp/test", host.entries);
// const harness = loadHarness({ config: {...}, host });
// await harness.evaluate(event, ctx, 1);
// assert.ok(host.entries.some((e) => e.customType === "my-mark"));
// ```
//
// Prior art: these graduate the `makeTrackedHost` + `makeCtx` helpers
// previously private to `src/__test-helpers__.ts`. Kept as a separate
// pair (not merged into {@link loadHarness}) so authors can wire the
// host and ctx to their own production-runtime facsimile when the
// default harness plumbing doesn't fit.

/**
 * Shape of a session-entry produced by {@link createRecordingHost}'s
 * `appendEntry`, readable by an {@link ExtensionContext} built from
 * {@link mockExtensionContext}. Mirrors the subset of pi's
 * `CustomEntry` the engine reads — `id` and `parentId` exist on real
 * pi entries, so we populate them too to keep type-shape drift from
 * masking silent divergence.
 */
export interface RecordedSessionEntry {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
  readonly timestamp: string;
  readonly id: string;
  readonly parentId: string | null;
}

/**
 * Exec-call record captured by {@link createRecordingHost}. One entry
 * per invocation, in registration order. `args` is defensively copied

 * so later mutation of the caller's argv array doesn't corrupt the
 * record.
 */
export interface RecordedExecCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * Options for {@link createRecordingHost}.
 */
export interface CreateRecordingHostOptions {
  /**
   * Stub for `host.exec`. Receives the normalized `cwd` (either the
   * caller's `opts.cwd` or `"/"`). Defaults to resolving with an
   * empty successful result — override when tests need to assert
   * behavior against a specific stdout / exit code.
   */
  readonly exec?: (
    cmd: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<PiExecResult>;
}

/**
 * Recording {@link EvaluatorHost}. Every `exec` and `appendEntry`
 * call is captured into readable accumulators; `entries` mirrors the
 * `appendEntry` writes in the shape pi's `sessionManager.getEntries()`
 * returns, so feeding `host.entries` into {@link mockExtensionContext}
 * makes the engine's writes visible to its subsequent reads in the
 * same test.
 *
 * Note: `entries` and `execCalls` / `appendedEntries` are returned as
 * mutable arrays so asserts can use `.some`, `.find`, etc. directly
 * without a copy. They are owned by the host; don't splice or reassign
 * them out from under it.
 */
export interface RecordingHost extends EvaluatorHost {
  /**
   * Session-entry log backing {@link mockExtensionContext}. Mutated
   * in-place on every `appendEntry` call. Pass this array to
   * `mockExtensionContext(cwd, host.entries)` so the host and the
   * ctx share the same store.
   */
  readonly entries: RecordedSessionEntry[];

  /** Every `exec` invocation, in call order. */
  readonly execCalls: RecordedExecCall[];

  /**
   * Every `appendEntry(type, data)` invocation, in call order. The
   * `data` field is stored verbatim — NOT the auto-tagged shape the
   * engine produces (that's reflected in {@link entries} instead).
   * This buffer is the raw host-level log; use it for assertions that
   * care about exactly which calls the engine made.
   */
  readonly appendedEntries: Array<{ type: string; data: unknown }>;
}

/**
 * Build a {@link RecordingHost}. Every `exec` call is recorded, and
 * every `appendEntry` call appends both to {@link RecordingHost.
 * appendedEntries} (raw host-level log) and to {@link RecordingHost.
 * entries} (session-entry shape used by {@link mockExtensionContext}).
 *
 * Timestamps on the session-entry log are monotonically-incrementing
 * ISO strings starting at `2026-01-01T00:00:00Z` (+ 1s per entry) so
 * chronological-order asserts stay stable across test runs without a
 * live clock dependency. Override with a wrapping host if your test
 * needs real timestamps.
 *
 * The default `exec` stub resolves with an empty successful result —
 * safer than rejecting by default because most tests don't exercise
 * exec at all and a loud reject would swamp the signal. Opt in to
 * rejection via `options.exec` when a test must assert "exec was NOT
 * called".
 */
export function createRecordingHost(
  options: CreateRecordingHostOptions = {},
): RecordingHost {
  const execCalls: RecordedExecCall[] = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const entries: RecordedSessionEntry[] = [];
  let idCounter = 0;
  return {
    execCalls,
    appendedEntries,
    entries,
    exec: async (cmd, args, opts) => {
      const cwd = opts?.cwd ?? "/";
      execCalls.push({ cmd, args: [...args], cwd });
      if (options.exec) {
        return options.exec(cmd, args, cwd);
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    appendEntry: (type, data) => {
      appendedEntries.push({ type, data });
      entries.push({
        type: "custom",
        customType: type,
        data,
        timestamp: new Date(
          Date.UTC(2026, 0, 1, 0, 0, idCounter++),
        ).toISOString(),
        id: `entry-${idCounter}`,
        parentId: null,
      });
    },
  };
}

/**
 * Build a minimal {@link ExtensionContext} stub backed by a
 * {@link RecordedSessionEntry} array. Used with {@link loadHarness}'s
 * `harness.evaluate` / `harness.dispatch` when a test needs the engine
 * to see entries a {@link RecordingHost} previously recorded.
 *
 * Only `cwd` and `sessionManager.getEntries()` are populated — the
 * two fields the engine actually reads. Everything else on
 * `ExtensionContext` throws on access (via an `unknown` cast) so an
 * accidental reliance on unsupported surface surfaces as a clear
 * `TypeError` rather than silently passing.
 *
 * Pass `host.entries` from {@link createRecordingHost} to share the
 * backing store between the engine's writes and its subsequent reads.
 *
 * Choosing between this and {@link loadHarness} alone:
 *
 *   - Use {@link loadHarness} + {@link expectBlocks}/{@link expectAllows}
 *     when the test only asserts block vs allow on a single event.
 *   - Use {@link createRecordingHost} + `mockExtensionContext` when the
 *     test drives a multi-call sequence, asserts on session-entry
 *     shape, or inspects exec calls.
 */
export function mockExtensionContext(
  cwd: string,
  entries: ReadonlyArray<RecordedSessionEntry> = [],
): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getEntries: () => entries,
      // Other SessionManager methods are stubbed to throw via the
      // unknown-cast below; any accidental dependency surfaces as a
      // clear TypeError rather than silently passing.
    } as unknown as ExtensionContext["sessionManager"],
  } as ExtensionContext;
}

// ---------------------------------------------------------------------------
// getAppendedEntries
// ---------------------------------------------------------------------------

/**
 * Read the `appendEntry` capture buffer for a mock context.
 *
 * Returns an empty array when:
 *   - nothing has been appended yet, OR
 *   - the context wasn't built by {@link mockContext} /
 *     {@link mockObserverContext} (safe lookup — no throw).
 *
 * The returned array is a snapshot (copy) so callers can iterate
 * without worrying about concurrent appends racing the assertion.
 */
export function getAppendedEntries(
  ctx: PredicateContext | ObserverContext,
): ReadonlyArray<{ customType: string; data?: unknown }> {
  const buf = appendBuffers.get(ctx);
  if (buf === undefined) return [];
  return [...buf];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the `exec` closure for a mock context. Wraps a user-supplied
 * stub or returns a "not stubbed" rejecter. Normalizes the return
 * type to `Promise<ExecResult>` so sync stubs work too.
 */
function buildExec(
  stub: MockContextOptions["exec"],
  who: "mockContext" | "mockObserverContext",
): PredicateContext["exec"] {
  if (stub === undefined) {
    return () =>
      Promise.reject(new Error(`${who}: exec not stubbed — pass options.exec`));
  }
  return async (cmd, args, opts) => stub(cmd, args, opts);
}

/**
 * Build the `findEntries` closure backing mock contexts. Filters the
 * entries array by customType and projects timestamps from ISO
 * strings to epoch-ms — matches {@link createFindEntries} on the
 * production path.
 *
 * No caching here: test-context entry lists are tiny and the cache
 * would make it harder to reason about repeated reads during a test
 * mutating the underlying array.
 */
function buildFindEntries(
  entries: ReadonlyArray<MockEntry>,
): PredicateContext["findEntries"] {
  return <T>(customType: string) => {
    const out: Array<{ data: T; timestamp: number }> = [];
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType !== customType) continue;
      const ts = Date.parse(entry.timestamp);
      out.push({
        data: entry.data as T,
        timestamp: Number.isNaN(ts) ? 0 : ts,
      });
    }
    return out;
  };
}

// ===========================================================================
// Phase 5b — Convenience wrappers
// ===========================================================================

// ---------------------------------------------------------------------------
// Shorthand input types
// ---------------------------------------------------------------------------

/**
 * Convenience shape for a bash tool-call event. Accepted by
 * {@link expectBlocks}, {@link expectAllows}, {@link expectRuleFires},
 * and {@link runMatrix} in place of a full {@link ToolCallEvent}.
 */
export interface BashShorthand {
  readonly command: string;
  readonly cwd?: string;
}

/** Convenience shape for a write tool-call event. */
export interface WriteShorthand {
  readonly write: { readonly path: string; readonly content: string };
  readonly cwd?: string;
}

/** Convenience shape for an edit tool-call event. */
export interface EditShorthand {
  readonly edit: {
    readonly path: string;
    readonly edits: ReadonlyArray<{
      readonly oldText: string;
      readonly newText: string;
    }>;
  };
  readonly cwd?: string;
}

/** Union of the bash/write/edit shorthands. */
export type ToolCallShorthand = BashShorthand | WriteShorthand | EditShorthand;

/**
 * Convenience shape for a tool-result event, accepted by
 * {@link testObserver}. Mirrors the minimal {@link SchemaToolResultEvent}
 * fields observers actually read.
 */
export interface ToolResultShorthand {
  readonly toolName: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly exitCode?: number;
}

// ---------------------------------------------------------------------------
// Event + context resolution helpers
// ---------------------------------------------------------------------------

/**
 * Detect a {@link ToolCallShorthand} by its tag field. Actual
 * {@link ToolCallEvent} instances carry a `type: "tool_call"` marker
 * that shorthands never have.
 */
function isShorthand(
  input: ToolCallEvent | ToolCallShorthand,
): input is ToolCallShorthand {
  return !("type" in input && input.type === "tool_call");
}

/**
 * Resolve a shorthand-or-event input into a concrete
 * {@link ToolCallEvent} + a minimal {@link ExtensionContext} stub.
 * The stub carries only `cwd` and a `sessionManager.getEntries()`
 * returning `[]` — enough for the evaluator to build its per-call
 * closures without failing on undefined reads.
 */
function resolveToolCallEvent(
  input: ToolCallEvent | ToolCallShorthand,
  fallbackCwd: string,
): { event: ToolCallEvent; ctx: ExtensionContext } {
  const event = isShorthand(input) ? shorthandToEvent(input) : input;
  const cwd = isShorthand(input) ? (input.cwd ?? fallbackCwd) : fallbackCwd;
  const ctx = {
    cwd,
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  return { event, ctx };
}

/** Build a synthetic {@link ToolCallEvent} from a shorthand. */
function shorthandToEvent(s: ToolCallShorthand): ToolCallEvent {
  if ("command" in s) {
    return {
      type: "tool_call",
      toolName: "bash",
      input: { command: s.command },
    } as unknown as ToolCallEvent;
  }
  if ("write" in s) {
    return {
      type: "tool_call",
      toolName: "write",
      input: { path: s.write.path, content: s.write.content },
    } as unknown as ToolCallEvent;
  }
  return {
    type: "tool_call",
    toolName: "edit",
    input: { path: s.edit.path, edits: s.edit.edits },
  } as unknown as ToolCallEvent;
}

/** Short human-readable summary of an event for failure messages. */
function describeEvent(event: ToolCallEvent): string {
  const input = (event as unknown as { input: unknown }).input;
  if (
    event.toolName === "bash" &&
    typeof input === "object" &&
    input !== null &&
    "command" in input
  ) {
    const cmd = (input as { command: unknown }).command;
    return `bash \`${String(cmd)}\``;
  }
  if (typeof input === "object" && input !== null && "path" in input) {
    const p = (input as { path: unknown }).path;
    return `${event.toolName} ${String(p)}`;
  }
  return event.toolName;
}

/**
 * Resolve a tool-result event or shorthand into a full
 * {@link SchemaToolResultEvent}. Used by {@link testObserver} to drive
 * observers without making the caller stand up a pi-shape result.
 */
function resolveToolResultEvent(
  input: SchemaToolResultEvent | ToolResultShorthand,
): SchemaToolResultEvent {
  // Both shapes carry `toolName` + `input` + `output` + `exitCode?`.
  // Accept either; project to the minimal schema shape.
  return {
    toolName: input.toolName,
    input: (input as { input?: unknown }).input ?? {},
    output: (input as { output?: unknown }).output ?? {},
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  };
}

// ---------------------------------------------------------------------------
// testPredicate
// ---------------------------------------------------------------------------

/**
 * Drive a single {@link PredicateHandler} against a {@link mockContext}.
 * Returns the boolean verdict.
 *
 * Usage:
 * ```ts
 * const fires = await testPredicate(branch, /^main$/, {
 *   walkerState: { branch: "main" },
 * });
 * ```
 *
 * Chain-aware predicates (e.g. the built-in `missing` with its
 * `&&`-chain speculative allow) read per-ref synthetic events from
 * `ctx.walkerState.events`. Populate `toolCallEvents` (or set
 * `walkerState` directly) in {@link MockContextOptions} to simulate
 * that surface in isolation without wiring up `loadHarness` + a
 * full bash event.
 */
export async function testPredicate<A = unknown>(
  predicate: PredicateHandler<A>,
  args: A,
  options: MockContextOptions = {},
): Promise<PredicateVerdict> {
  const ctx = mockContext(options);
  return predicate(args, ctx);
}

// ---------------------------------------------------------------------------
// testObserver
// ---------------------------------------------------------------------------

/**
 * Fire an {@link Observer} at an event, returning the captured
 * `appendEntry` writes plus whether the observer's `watch` filter
 * accepted the event. Use the `entries` field to assert what the
 * observer recorded; use `watchMatched` to assert the filter gated
 * firing correctly.
 *
 * If the observer's `watch` did NOT match, `onResult` is NOT called
 * (mirrors production dispatch).
 *
 * If `options.exec` is supplied, emits a `console.warn` — observers
 * don't see `exec`, so the stub can never fire. Exists on the options
 * shape only because {@link MockObserverContextOptions} is derived
 * from {@link MockContextOptions} for ergonomic test composition.
 */
export async function testObserver(
  observer: Observer,
  event: SchemaToolResultEvent | ToolResultShorthand,
  options: MockObserverContextOptions = {},
): Promise<{
  entries: ReadonlyArray<{ customType: string; data?: unknown }>;
  watchMatched: boolean;
}> {
  if (options.exec !== undefined) {
    console.warn(
      "testObserver: exec option ignored — ObserverContext doesn't expose exec",
    );
  }

  const ctx = mockObserverContext(options);
  const resolvedEvent = resolveToolResultEvent(event);
  // Resolve `inputMatches.command` against the caller's walk registry
  // (default: builtin) + the mock cwd — same derivation shape as
  // production dispatch's per-event ctx.cwd. Passing a provider always
  // is safe: `matchesWatch` only invokes it for `command` on bash events.
  const walkRegistry = options.walkRegistry ?? WATCH_DEFAULT_WALK;
  const getRefTexts = (): readonly string[] | null =>
    extractRefTextsForBash(resolvedEvent, {
      trackers: walkRegistry,
      cwd: options.cwd ?? "/tmp/test",
    });
  const watchMatched = matchesWatch(observer.watch, resolvedEvent, getRefTexts);

  if (watchMatched) {
    await Promise.resolve(observer.onResult(resolvedEvent, ctx));
  }

  return { entries: getAppendedEntries(ctx), watchMatched };
}

// ---------------------------------------------------------------------------
// expectBlocks / expectAllows / expectRuleFires
// ---------------------------------------------------------------------------

/** Options for {@link expectBlocks}. */
export interface ExpectBlocksOptions {
  /**
   * Expected rule name — matched against the `[steering:<name>@<source>]`
   * prefix (source-tagged format per ADR §11). The source suffix is
   * ignored for matching; pass the bare rule name.
   */
  readonly rule?: string;
  /** Expected reason — exact string match (string) or pattern match (RegExp). */
  readonly reason?: string | RegExp;
}

/**
 * Strip a leading block-reason preamble from `reason`, returning the
 * remainder (the source-tagged portion).
 *
 * Block reasons are prefixed with {@link BLOCK_REASON_PREAMBLE} (rule
 * path) or {@link ENGINE_ERROR_PREAMBLE} (engine-error path) followed
 * by `\n\n` (issue #85 — every steering message must state the tool
 * call was not executed). Matching helpers that anchor on the
 * `[steering:…]` tag apply this first so their `^` anchors stay
 * correct. Backward-compatible: reasons in the pre-preamble format
 * (or anything else) pass through unchanged.
 */
function stripPreamble(reason: string): string {
  for (const p of [BLOCK_REASON_PREAMBLE, ENGINE_ERROR_PREAMBLE]) {
    if (reason.startsWith(`${p}\n\n`)) return reason.slice(p.length + 2);
  }
  return reason;
}

/**
 * Extract the rule name from a block reason. Reasons are source-tagged
 * as `[steering:<rule>@<source>] …` (after the engine's preamble — see
 * {@link stripPreamble}); we return the `<rule>` portion
 * so callers can assert by name without caring which plugin shipped
 * the rule.
 */
function extractRuleName(reason: string): string | null {
  const m = stripPreamble(reason).match(/^\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
  return m?.[1] ?? null;
}

/** Normalize the `ToolCallEventResult` to a concrete block payload or null. */
// biome-ignore lint/suspicious/noConfusingVoidType: mirrors EvaluatorRuntime["evaluate"]'s return type (`void` when the event passes through unblocked); callers pass its result through unchanged.
function interpretResult(result: ToolCallEventResult | void): {
  blocked: boolean;
  reason: string | null;
} {
  if (result === undefined || result === null) {
    return { blocked: false, reason: null };
  }
  const r = result as { block?: boolean; reason?: unknown };
  if (r.block !== true) return { blocked: false, reason: null };
  return {
    blocked: true,
    reason: typeof r.reason === "string" ? r.reason : String(r.reason ?? ""),
  };
}

/**
 * Assert that the harness blocks the given event. Returns the block
 * payload for further inspection. Throws on allow.
 *
 * Optional `expected.rule` / `expected.reason` narrow the assertion:
 *   - `rule: "no-force-push"` — the fired rule's name must match.
 *   - `reason: /force-push/` — the reason string must match (exact
 *     string or regex). Matching runs against the rule-authored
 *     portion of the reason (the engine's preamble is stripped
 *     first — see {@link stripPreamble}), so `^`-anchored patterns
 *     and exact strings keep working across the preamble format.
 */
export async function expectBlocks(
  harness: Harness,
  event: ToolCallEvent | ToolCallShorthand,
  expected: ExpectBlocksOptions = {},
): Promise<ToolCallEventResult> {
  const { event: resolvedEvent, ctx } = resolveToolCallEvent(
    event,
    "/tmp/test",
  );
  const result = await harness.evaluate(resolvedEvent, ctx, 0);
  const { blocked, reason } = interpretResult(result);

  if (!blocked) {
    throw new Error(
      `expectBlocks: expected block, got allow for ${describeEvent(resolvedEvent)} at ${ctx.cwd}`,
    );
  }

  if (expected.rule !== undefined) {
    const firedRule = extractRuleName(reason ?? "");
    if (firedRule !== expected.rule) {
      throw new Error(
        `expectBlocks: expected rule "${expected.rule}" to fire, ` +
          `got "${firedRule ?? "<none>"}" for ${describeEvent(resolvedEvent)}\n` +
          `  reason: ${reason}`,
      );
    }
  }

  if (expected.reason !== undefined && reason !== null) {
    const matches =
      expected.reason instanceof RegExp
        ? expected.reason.test(stripPreamble(reason))
        : expected.reason === stripPreamble(reason);
    if (!matches) {
      throw new Error(
        `expectBlocks: reason did not match expected pattern\n` +
          `  expected: ${String(expected.reason)}\n` +
          `  got:      ${reason}`,
      );
    }
  }

  return result as ToolCallEventResult;
}

/**
 * Assert that the harness allows the given event (no rule fires).
 * Throws with a rich message on block.
 */
export async function expectAllows(
  harness: Harness,
  event: ToolCallEvent | ToolCallShorthand,
): Promise<void> {
  const { event: resolvedEvent, ctx } = resolveToolCallEvent(
    event,
    "/tmp/test",
  );
  const result = await harness.evaluate(resolvedEvent, ctx, 0);
  const { blocked, reason } = interpretResult(result);

  if (blocked) {
    const firedRule = extractRuleName(reason ?? "") ?? "<unknown>";
    throw new Error(
      `expectAllows: expected allow, got block for ${describeEvent(resolvedEvent)}\n` +
        `  rule:   ${firedRule}\n` +
        `  reason: ${reason}`,
    );
  }
}

/**
 * Assert that a specific rule fires on the given event. Thin alias
 * over {@link expectBlocks}; kept as a distinct helper for tests whose
 * intent is "which rule fired" rather than "the tool was blocked".
 */
export async function expectRuleFires(
  harness: Harness,
  event: ToolCallEvent | ToolCallShorthand,
  ruleName: string,
): Promise<void> {
  await expectBlocks(harness, event, { rule: ruleName });
}

// ---------------------------------------------------------------------------
// runMatrix / formatMatrix
// ---------------------------------------------------------------------------

/** One row of a {@link runMatrix} input. */
export interface MatrixCase {
  readonly name: string;
  readonly event: ToolCallEvent | ToolCallShorthand;
  readonly expect:
    | "block"
    | "allow"
    | { readonly block: true; readonly rule?: string };
  readonly cwd?: string;
}

/** Per-case outcome. */
export interface MatrixCaseResult {
  readonly case: MatrixCase;
  readonly passed: boolean;
  readonly actual: "block" | "allow";
  readonly reason?: string;
  readonly errorMessage?: string;
}

/** Aggregate outcome of {@link runMatrix}. */
export interface MatrixResult {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly cases: ReadonlyArray<MatrixCaseResult>;
}

/**
 * Batch-evaluate a list of cases against a harness. Never throws —
 * failures surface in `result.cases`. Pair with {@link formatMatrix}
 * to render a human-readable report.
 */
export async function runMatrix(
  harness: Harness,
  cases: readonly MatrixCase[],
): Promise<MatrixResult> {
  const caseResults: MatrixCaseResult[] = [];

  for (const c of cases) {
    const fallback = c.cwd ?? "/tmp/test";
    const { event, ctx } = resolveToolCallEvent(c.event, fallback);
    const evalResult = await harness.evaluate(event, ctx, 0);
    const { blocked, reason } = interpretResult(evalResult);
    const actual: "block" | "allow" = blocked ? "block" : "allow";

    let passed = false;
    let errorMessage: string | undefined;

    if (c.expect === "allow") {
      passed = !blocked;
      if (!passed) {
        errorMessage = `expected allow; got block (${extractRuleName(reason ?? "") ?? "<unknown>"})`;
      }
    } else if (c.expect === "block") {
      passed = blocked;
      if (!passed) errorMessage = "expected block; got allow";
    } else {
      if (!blocked) {
        passed = false;
        errorMessage = "expected block; got allow";
      } else if (c.expect.rule !== undefined) {
        const firedRule = extractRuleName(reason ?? "");
        passed = firedRule === c.expect.rule;
        if (!passed) {
          errorMessage = `expected rule "${c.expect.rule}"; got "${firedRule ?? "<unknown>"}"`;
        }
      } else {
        passed = true;
      }
    }

    caseResults.push({
      case: c,
      passed,
      actual,
      ...(reason !== null ? { reason } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    });
  }

  const passed = caseResults.filter((r) => r.passed).length;
  return {
    total: caseResults.length,
    passed,
    failed: caseResults.length - passed,
    cases: caseResults,
  };
}

/**
 * Pretty-print a {@link MatrixResult}. ASCII-friendly for CI log
 * aggregators; structure mirrors the adversarial-matrix report style.
 */
export function formatMatrix(result: MatrixResult): string {
  const lines: string[] = [];
  lines.push(
    `MATRIX — ${result.total} cases. ${result.passed} pass, ${result.failed} fail.`,
  );
  lines.push("=".repeat(64));
  for (const r of result.cases) {
    const expect =
      typeof r.case.expect === "string"
        ? r.case.expect
        : `block:${r.case.expect.rule ?? "*"}`;
    const actualLabel =
      r.actual === "block"
        ? `BLOCK (${extractRuleName(r.reason ?? "") ?? "?"})`
        : "allow";
    const status = r.passed ? "" : "  FAIL";
    lines.push(
      `[${r.case.name}]  expect:${expect}  actual:${actualLabel}${status}`,
    );
    if (!r.passed && r.errorMessage) {
      lines.push(`  ↳ ${r.errorMessage}`);
    }
  }
  lines.push("=".repeat(64));
  lines.push(`PASS: ${result.passed}/${result.total}`);
  return lines.join("\n");
}
