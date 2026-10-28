// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// pi-steering — deterministic steering hooks for pi agents.
// Inspired by @samfp/pi-steering-hooks (schema, override-comment,
// defaults). AST backend + command-level effective-cwd via
// unbash-walker. This file is the thin wiring layer between pi's
// extension API and the engine (loader + plugin-merger + evaluator
// + observer-dispatcher).

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EvaluatorHost } from "./evaluator.ts";
import { buildSessionRuntime } from "./internal/session-runtime.ts";

/**
 * Pi extension factory. Wires the steering engine onto pi's
 * lifecycle events.
 *
 * Strict-mode contract: see {@link SteeringConfig.failOnWarnings}.
 *
 * Lifecycle wiring:
 *
 *   - factory time      — register-only, synchronous: no config load,
 *                         no evaluator construction, no `process.cwd()`
 *                         capture. One-shot CLI contexts (`pi config`,
 *                         `pi list`) never fire `session_start`, so
 *                         they never execute steering configs.
 *   - `agent_start`     — bump the internal `agentLoopIndex` counter
 *                         so tool_call / tool_result handlers can
 *                         forward it into the evaluator + dispatcher.
 *                         One agent loop = one user prompt + all the
 *                         tool calls it spawns.
 *   - `session_start`   — lazily build the runtime on the first event,
 *                         anchored on the session's `ctx.cwd` (NOT the
 *                         process launch cwd). The project layer is
 *                         gated on pi's RESOLVED project-trust decision
 *                         (`ctx.isProjectTrusted()`, captured before the
 *                         await; absent → gate inert); the global layer
 *                         always loads. Build failures surface
 *                         per the strict-mode contract: an aggregate
 *                         diagnostic throw renders the full body via
 *                         `console.error` + an in-chat `ui.notify`
 *                         ("error") and leaves the session unsteered
 *                         (fail-closed); any other error is rethrown
 *                         and stays loud. Later `session_start`s on
 *                         the same instance are no-ops (safety net;
 *                         fresh instance per session — `/reload`,
 *                         `/new`, `/resume`, `/fork` re-validate).
 *   - `tool_call` / `tool_result` — route through the evaluator and
 *     dispatcher when the runtime is built; return `undefined`
 *     (unsteered) while unbuilt. See {@link buildSessionRuntime}.
 *
 * Exported as the default export per pi's extension convention.
 *
 * The optional `deps` parameter is a TEST-ONLY injection seam for the
 * runtime builder; pi calls `register(pi)` with a single argument.
 */
export default function register(
  pi: ExtensionAPI,
  deps: { buildSessionRuntime?: typeof buildSessionRuntime } = {},
): void {
  let agentLoopIndex = 0;
  let runtime: Awaited<ReturnType<typeof buildSessionRuntime>> | null = null;

  const build = deps.buildSessionRuntime ?? buildSessionRuntime;
  const host: EvaluatorHost = { exec: pi.exec, appendEntry: pi.appendEntry };

  pi.on("agent_start", () => {
    agentLoopIndex += 1;
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (runtime !== null) return; // safety net; fresh instance per session anyway
    const ui = ctx.ui; // capture BEFORE await (getter asserts active)
    try {
      // Capture pi's resolved project-trust decision BEFORE the await
      // (same D3 pattern as `ui` — the getter must run against the
      // live session context). `?.() ?? true` keeps the gate inert
      // when the API is absent (pi < 0.79.1, test mocks): the project
      // layer then loads exactly as before. The peer floor is
      // `>=0.79.1` (the release that added `ctx.isProjectTrusted()`);
      // the breadcrumb makes the inert fallback observable instead of
      // silent, so an old-pi install doesn't quietly lose the gate.
      if (typeof ctx.isProjectTrusted !== "function") {
        console.info(
          "[pi-steering] ctx.isProjectTrusted() unavailable (pi >=0.79.1 " +
            "required) — project-layer trust gate inert; project layer loads",
        );
      }
      const projectLayerTrusted = ctx.isProjectTrusted?.() ?? true;
      runtime = await build(ctx.cwd, host, { projectLayerTrusted });
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !/^\d+ config issues?:/.test(err.message)
      ) {
        throw err;
      }
      const body = err.message;
      console.error(`[pi-steering] ${body}`);
      ui.notify(`pi-steering disabled (strict mode): ${body}`, "error");
    }
  });

  pi.on("tool_call", (event, ctx) =>
    runtime
      ? runtime.evaluator.evaluate(event, ctx, agentLoopIndex)
      : undefined,
  );

  pi.on("tool_result", (event, ctx) =>
    runtime
      ? runtime.dispatcher.dispatch(event, ctx, agentLoopIndex)
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// Public surface — the engine.
//
// Consumers embedding the engine (building their own extensions, a CLI
// that lints commands, a test harness, …) import these from the
// package root.
// ---------------------------------------------------------------------------

// Walker types re-exported for plugin authors. Forward-compatible with
// future unbash-walker extraction — imports from this package won't
// break.
// Walker option types for the subcommand surface (issues #90/#91):
// `getSubcommandWords` is the CommandRef-based extraction entry point;
// plugin authors declaring per-binary flag tables do so via the
// `Plugin.cliDescriptors` slot (table channel since #110 — no leaf-inline
// channel). The bare-words `locateSubcommandRun` (+
// `SubcommandRun`) is re-exported here so custom predicates can run
// the engine's own extraction over projected `PredicateWord[]`
// (see `projectSubcommandWords` in `evaluator-internals/predicates.ts`
// for the required `.value` projection — the walker reads `.value`
// ONLY, never `.text`).
export type {
  Command,
  CommandRef,
  EnvState,
  Modifier,
  Node,
  PositionPolicy,
  Script,
  SubcommandOptions,
  SubcommandRun,
  SubshellSemantics,
  Tracker,
  WalkResult,
  Word,
  WordPart,
} from "@cad0p/unbash-walker";
// Walker functions re-exported for plugin authors writing custom
// predicates and trackers. Forward-compatible with future
// unbash-walker extraction. Dependency rule (see README "Writing plugins › Dependency rule"): import these from here, never from @cad0p/unbash-walker directly.
export {
  bundleContains,
  cwdTracker,
  DEFAULT_POSITION_POLICIES,
  envTracker,
  expandTildeIfLeading,
  expandWrapperCommands,
  extractAllCommandsFromAST,
  formatCommand,
  getBasename,
  getCommandArgs,
  getCommandName,
  getSubcommandWords,
  isStaticallyResolvable,
  locateSubcommandRun,
  parse,
  resolveWord,
  walk,
} from "@cad0p/unbash-walker";
// Core CLI-descriptor fallback map (issue #106): currently empty —
// core seeds nothing. Per-binary facts live in their owning plugins
// (the git const re-exports from `pi-steering/plugins/git`).
export { CORE_CLI_DESCRIPTORS } from "./arity.ts";
// JSON compat — convert v1 JSON configs to v2 TS configs.
export { FromJSONError, fromJSON } from "./compat.ts";
export type { DefineConfigInput } from "./define-config.ts";
// Config helper (preferred entry point).
export { defineConfig } from "./define-config.ts";
// Predicate helper.
export { definePredicate } from "./define-predicate.ts";
// Auto-tag key for session-entry writes. Exposed so plugin authors
// inspecting raw session entries via `findEntries` can reference the
// constant instead of hardcoding the string.
export { AGENT_LOOP_INDEX_KEY } from "./evaluator-internals/context.ts";
// Block-reason preambles — fixed prefixes prepended to every steering
// block reason (rule path and engine-error path respectively) so the
// agent-facing message ALWAYS states the tool call was not executed
// (issue #85). Consumers matching on the `[steering:…]` tag should
// strip the preamble first (see `stripPreamble` in `testing`).
export {
  BLOCK_REASON_PREAMBLE,
  ENGINE_ERROR_PREAMBLE,
} from "./helpers/block-reason-preamble.ts";
export type { BooleanLeafArgs } from "./helpers/boolean-args.ts";
export { unwrapBooleanLeafArg } from "./helpers/boolean-args.ts";
export type { SteeringCommand } from "./helpers/command.ts";
export { commandFromInput } from "./helpers/command.ts";
// Command facade: context-provided flag-value view (issue #101; #110
// entry-only). Rule code reads flags through `ctx.command` (engine-built
// per ref); out-of-handler / test use goes through the `commandFromInput`
// factory. `INFO_FLAGS` (data constant) stays; `FlagLookupOptions` is
// deleted (entry-only queries — a flag worth gating is worth a table row).
export { INFO_FLAGS } from "./helpers/flags.ts";
// Reason-text helper for custom predicates that read runtime
// `ctx.cwd` (shell-exec or filesystem queries) rather than
// walker-tracked state.
//
// `walkerUnknownCwdReason`: composable agent-facing reason text
// for ReasonFns to call on the walker-unknown branch of those
// runtime-cwd predicates (typical handler shape:
// `if (ctx.walkerState?.cwd === "unknown") return "unknown";`,
// then the engine projects via `onUnknown:` policy).
export { walkerUnknownCwdReason } from "./helpers/walker-unknown-cwd-reason.ts";
// Loader — two-layer config discovery + merge.
export { buildConfig, loadConfigs, loadSteeringConfig } from "./loader.ts";
// Schema types — the public authoring surface.
export type {
  AnyPredicateHandler,
  Basename,
  BaseRule,
  BashRule,
  BuiltInWhenLeaves,
  BuiltInWhenLeavesInner,
  BuiltInWhenLeavesOuter,
  CLIDescriptor,
  CLIFlag,
  DefaultSpreadBase,
  EditRule,
  ExecOpts,
  ExecResult,
  Exemption,
  ExemptionWhenClause,
  FlagLeaf,
  FlagLeafInner,
  FlagSpreadBase,
  InnerValue,
  Observer,
  ObserverContext,
  ObserverWatch,
  OperatorField,
  OuterValue,
  Pattern,
  Patterns,
  Plugin,
  PluginPredicateKey,
  PredicateContext,
  PredicateFn,
  PredicateHandler,
  PredicateModifiers,
  PredicateShape,
  PredicateToolInput,
  PredicateVerdict,
  PredicateWord,
  ReasonFn,
  ReservedPredicateKey,
  Rule,
  SteeringConfig,
  SteeringDiagnostic,
  SteeringDiagnosticKind,
  SubcommandLeaf,
  SubcommandLeafInner,
  SubcommandPattern,
  SubcommandSpreadBase,
  ToolResultEvent,
  TopLevelWhenClause,
  TopLevelWhenClauseNoRecurse,
  WhenClause,
  WhenWalkerState,
  WriteRule,
} from "./schema.ts";
export type {
  BashShorthand,
  CreateRecordingHostOptions,
  EditShorthand,
  ExpectBlocksOptions,
  Harness,
  LoadHarnessOptions,
  MatrixCase,
  MatrixCaseResult,
  MatrixResult,
  MockContextOptions,
  MockEntry,
  MockObserverContextOptions,
  PriorEntryOptions,
  RecordedExecCall,
  RecordedSessionEntry,
  RecordingHost,
  ToolCallShorthand,
  ToolResultShorthand,
  WriteShorthand,
} from "./testing/index.ts";
// Testing primitives — re-exported at the root for discoverability.
// The canonical import path is `@cad0p/pi-steering/testing`;
// this root re-export means a test file that already imports
// `defineConfig` from the root doesn't need a second import line for
// `loadHarness`. See `./testing/index.ts` for the API docs.
export {
  createRecordingHost,
  expectAllows,
  expectBlocks,
  expectRuleFires,
  formatMatrix,
  getAppendedEntries,
  loadHarness,
  mockContext,
  mockExtensionContext,
  mockObserverContext,
  priorEntry,
  runMatrix,
  testObserver,
  testPredicate,
} from "./testing/index.ts";
