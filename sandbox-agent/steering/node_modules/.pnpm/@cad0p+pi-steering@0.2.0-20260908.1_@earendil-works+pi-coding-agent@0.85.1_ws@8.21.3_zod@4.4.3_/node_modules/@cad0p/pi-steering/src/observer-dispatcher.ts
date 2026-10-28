// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * v2 observer dispatcher.
 *
 * Observers are the `tool_result` side of the steering engine: rules
 * decide "can this run" pre-execution; observers record what occurred
 * post-execution. Typical use is to `appendEntry` into pi's session
 * JSONL so later predicates can gate on prior turn state (the
 * "description was read in a PRIOR turn" idiom from the ADR).
 *
 * This module merges user-declared observers (from
 * {@link SteeringConfig.observers}) with plugin-shipped ones (from
 * {@link ResolvedPluginState.observers}), then on every `tool_result`:
 *
 *   1. Applies the observer's `watch` filter (toolName + inputMatches
 *      + exitCode). No `watch` means "fire on every tool_result".
 *   2. Calls `observer.onResult(event, observerCtx)`. Awaits if it
 *      returns a promise.
 *   3. Catches thrown errors per-observer — one buggy observer does
 *      NOT prevent the rest from running.
 *
 * Observer context (`ObserverContext`) is built fresh per event, using
 * `appendEntry` and `findEntries` closures shared with the evaluator.
 * `exec` is deliberately NOT exposed — observers are expected to be
 * lightweight state-recording hooks. Complex tool_result analysis that
 * needs to shell out belongs in a separate pi extension hook or in a
 * rule's `when.condition` pre-execution, not in an observer.
 *
 * Wiring (Phase 3c): the extension runtime subscribes to `tool_result`
 * and forwards the event + current `agentLoopIndex` into `dispatch`.
 *
 * ## Walk-registry parity (issue #54)
 *
 * `buildObserverDispatcher` derives the effective walker registry
 * from its `resolved` plugin state (via {@link buildWalkRegistry} in
 * `internal/walk-registry.ts`) — the SAME derivation the evaluator's
 * rule surface uses — and seeds each watch walk with the per-event
 * `ctx.cwd`. The watch surface therefore resolves the same
 * plugin-composed env trackers as the rule surface (closing the
 * parity gap where observers matched raw forms while rules saw
 * resolved forms); per-event cwd keeps cwd-dependent loaders in step
 * with the rule side (which is already per-event).
 */

import type { Tracker } from "@cad0p/unbash-walker";
import type {
  ExtensionContext,
  ToolResultEvent as PiToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createAppendEntry,
  createFindEntries,
  createSessionEntryCache,
  type EvaluatorHost,
} from "./evaluator-internals/context.ts";
import { mergeObserversUserFirst } from "./internal/merge-observers.ts";
import { buildWalkRegistry } from "./internal/walk-registry.ts";
import {
  extractRefTextsForBash,
  matchesWatch,
} from "./internal/watch-matcher.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import { validateName } from "./plugin-merger.ts";
import type {
  Observer,
  ObserverContext,
  ToolResultEvent as SchemaToolResultEvent,
} from "./schema.ts";

// Re-export the shared filter contract so existing consumers that
// imported `matchesWatch` from this module (most notably the testing
// harness's `testObserver`) don't need to switch imports. The source
// of truth lives in `./internal/watch-matcher.ts`; this re-export
// keeps the public surface stable.
export { matchesWatch } from "./internal/watch-matcher.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Runtime-facing dispatcher handle. Phase 3c holds an instance per
 * session and calls {@link dispatch} from the pi `tool_result` listener.
 */
export interface ObserverDispatcher {
  /**
   * Dispatch a single `tool_result` to every matching observer.
   *
   * Resolves when all observer handlers have settled. Handlers that
   * throw are caught + logged via `console.warn` and do not prevent
   * subsequent observers from running.
   */
  dispatch(
    event: PiToolResultEvent,
    ctx: ExtensionContext,
    agentLoopIndex: number,
  ): Promise<void>;
}

/**
 * Construct an {@link ObserverDispatcher}.
 *
 * Arguments:
 *   - `resolved`       — merged plugin state from {@link resolvePlugins}.
 *                         Source of plugin-shipped observers and the
 *                         registry used by the evaluator at the same
 *                         level.
 *   - `userObservers`  — the user's `config.observers` list (already
 *                         deduped at the loader level in Phase 2). User
 *                         observers fire BEFORE plugin observers on the
 *                         same event; within each group, registration
 *                         order decides.
 *   - `host`           — narrow surface exposing pi's `exec` +
 *                         `appendEntry`. Passed straight through to the
 *                         per-event observer context.
 */
export function buildObserverDispatcher(
  resolved: ResolvedPluginState,
  userObservers: readonly Observer[],
  host: EvaluatorHost,
): ObserverDispatcher {
  // S3 defense-in-depth: validate user-authored observer names so a
  // malformed name surfaces with the same `(user config)` label as
  // production diagnostics. Production routes through
  // `runMergerPipeline`'s `invalid-name` diagnostic; this throw
  // covers direct-caller paths (unit tests, SDK embedders).
  // See ./INVARIANTS.md for the S/E tag glossary.
  for (const o of userObservers) {
    const d = validateName("observer", o.name, "user config");
    if (d !== undefined) throw new Error(`[pi-steering] ${d.message}`);
  }

  // Merge user and plugin observers; duplicates of observer.name are
  // deduped here by first-registered (user takes precedence over a
  // plugin observer of the same name — matches the "user overrides
  // plugin by declaring their own" pattern the rule list uses). Shared
  // with the evaluator's speculative-synthesis reverse-index via
  // `mergeObserversUserFirst` so both callers see the same final list.
  const merged = mergeObserversUserFirst(userObservers, resolved.observers);

  // Effective walker registry for the watch surface — same derivation
  // the evaluator's rule surface uses (see internal/walk-registry.ts),
  // so plugin-composed env/cwd trackers resolve identically on both
  // surfaces (issue #54). Captured into the dispatch closure; the
  // per-event cwd seed comes from `ctx.cwd` at dispatch time.
  const trackers = buildWalkRegistry(resolved);

  return {
    dispatch: (event, ctx, agentLoopIndex) =>
      dispatchEvent(event, ctx, agentLoopIndex, merged, host, trackers),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchEvent(
  event: PiToolResultEvent,
  ctx: ExtensionContext,
  agentLoopIndex: number,
  observers: readonly Observer[],
  host: EvaluatorHost,
  trackers: Record<string, Tracker<unknown>>,
): Promise<void> {
  // Top-level fail-open wrap. Per-observer throws are already
  // isolated in the inner loop; this outer wrap exists so a throw in
  // the dispatch SCAFFOLDING (e.g. a session-JSONL read blowing up
  // inside `createFindEntries`, or an unexpected shape on the
  // incoming event) is logged rather than propagating back into pi's
  // `tool_result` hook. Observers are best-effort state recorders —
  // a broken engine should not take down the tool_result pipeline.
  try {
    await dispatchEventInner(
      event,
      ctx,
      agentLoopIndex,
      observers,
      host,
      trackers,
    );
  } catch (err) {
    console.warn(
      `[pi-steering] observer dispatcher threw: ${formatError(err)}`,
    );
  }
}

async function dispatchEventInner(
  event: PiToolResultEvent,
  ctx: ExtensionContext,
  agentLoopIndex: number,
  observers: readonly Observer[],
  host: EvaluatorHost,
  trackers: Record<string, Tracker<unknown>>,
): Promise<void> {
  // Shared per-event session-entry cache: findEntries + appendEntry
  // share it so an earlier observer's appendEntry invalidates the
  // cached read for that customType, and a later observer's
  // findEntries(customType) sees the fresh write (S2/E1). Without the
  // shared cache, observer A appending "description-read" + observer
  // B reading "description-read" on the same event would see a stale
  // pre-write snapshot.
  const entryCache = createSessionEntryCache();
  const findEntries = createFindEntries(ctx, entryCache);
  // Shared appendEntry: auto-tags writes with `_agentLoopIndex` so
  // `when.missing: { in: "agent_loop" }` can filter by agent-loop
  // scope. Safe to hoist out of the loop: the wrapper is stateless.
  const appendEntry = createAppendEntry(host, agentLoopIndex, entryCache);

  // Hoist the per-event projections out of the loop so N observers
  // each get the identical event shape + exit code without paying N
  // copies of the same work.
  const exitCode = extractExitCode(event);
  const schemaEvent = toSchemaEvent(event, exitCode);

  // Wrapper-aware command-ref cache (ADR §12). Populated lazily on the
  // first observer whose watch filter references `inputMatches.command`
  // against a bash event; reused across subsequent observers on the
  // same event so `sh -c '…'` / `sudo …` are parsed at most once per
  // dispatch regardless of how many observers share the filter shape.
  // `null` encodes "extraction attempted but failed (parse error or
  // non-bash event)" so we don't retry per observer.
  let refTextsCache: readonly string[] | null | undefined;
  const getRefTexts = (): readonly string[] | null => {
    if (refTextsCache !== undefined) return refTextsCache;
    refTextsCache = extractRefTextsForBash(schemaEvent, {
      // Plugin-composed walk registry (same derivation as the rule
      // surface) + per-event cwd — the parity fix of issue #54.
      // `ctx.cwd` is load-bearing: a cwd-dependent env loader must
      // resolve the same on both surfaces.
      trackers,
      cwd: ctx.cwd,
    });
    return refTextsCache;
  };

  for (const observer of observers) {
    if (!matchesWatch(observer.watch, schemaEvent, getRefTexts)) continue;

    // Each observer gets its own ctx so appendEntry writes attribute
    // cleanly. `exec` is intentionally absent — observers are recording
    // hooks, not shell-out points.
    const observerCtx: ObserverContext = {
      cwd: ctx.cwd,
      agentLoopIndex,
      appendEntry,
      findEntries,
    };

    try {
      const result = observer.onResult(schemaEvent, observerCtx);
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      // One observer's bug must not poison the rest. Log with the
      // observer name so the operator can locate + disable it.
      console.warn(
        `[pi-steering] observer "${observer.name}" threw: ${formatError(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Schema event projection
// ---------------------------------------------------------------------------

/**
 * Extract an exit code from a pi tool_result event. Only bash events
 * carry one (via `details.exitCode`). Other tool results lack a
 * meaningful numeric code; we return `undefined` and let the watch
 * filter's `exitCode` check decide.
 */
function extractExitCode(event: PiToolResultEvent): number | undefined {
  if (event.toolName !== "bash") return undefined;
  const details = event.details as { exitCode?: number } | undefined;
  if (!details || typeof details.exitCode !== "number") return undefined;
  return details.exitCode;
}

/**
 * Project pi's concrete `ToolResultEvent` onto the schema's minimal
 * {@link SchemaToolResultEvent}. Observers are typed against the schema
 * shape — they don't depend on pi's internal tool details unions. The
 * fields we fill:
 *
 *   - `toolName` + `input`   — direct.
 *   - `output`               — pi's `content` (TextContent/ImageContent
 *                               array) passed through unchanged. Observer
 *                               handlers cast to the shape they expect.
 *   - `exitCode`             — passed in precomputed by the caller
 *                               (so the extraction runs once per event,
 *                               not once per matching observer); bash
 *                               events only, others leave it `undefined`.
 */
function toSchemaEvent(
  event: PiToolResultEvent,
  exitCode: number | undefined,
): SchemaToolResultEvent {
  const out: SchemaToolResultEvent = {
    toolName: event.toolName,
    input: event.input,
    output: event.content,
  };
  if (exitCode !== undefined) out.exitCode = exitCode;
  return out;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.message}\n${err.stack ?? ""}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Re-export host type for symmetry with evaluator.ts.
export type { EvaluatorHost } from "./evaluator-internals/context.ts";
