// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Predicate context construction for the v2 evaluator.
 *
 * Two concerns live here because they collaborate tightly:
 *
 *   1. `createExecCache` — memoizes `exec(cmd, args, opts)` by
 *      `(cmd, args, cwd)` so every rule evaluated for ONE tool_call
 *      sees the same result for the same query, without re-running the
 *      underlying child process. A fresh cache is created per
 *      tool_call; cross-call results are never shared.
 *   2. `createFindEntries` — wraps pi's `sessionManager.getEntries()`
 *      into the {@link PredicateContext.findEntries} shape, filtering
 *      to `type: "custom"` entries by `customType` and flattening to
 *      `{ data, timestamp }` (timestamps normalized from ISO strings to
 *      epoch ms, matching what observers producing entries can rely on).
 *
 * The evaluator itself assembles the final {@link PredicateContext}
 * from these closures plus per-candidate fields (cwd / tool / input /
 * agentLoopIndex) as an object literal — no helper needed once the shape
 * is shared across bash and write/edit code paths.
 *
 * Kept internal (under `evaluator-internals/`) so consumers can swap
 * the evaluator without inheriting its helper surface. The only
 * re-export is through `../evaluator.ts`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExecOptions as PiExecOptions,
  ExecResult as PiExecResult,
} from "@earendil-works/pi-coding-agent";
import type { ExecOpts, ExecResult, PredicateContext } from "../schema.ts";

/**
 * Narrow host surface the evaluator needs from the pi runtime. Lets
 * tests pass a stub without building a full fake `ExtensionAPI`, and
 * keeps the evaluator decoupled from the unrelated parts of pi's API
 * (tool registration, slash commands, OAuth, …).
 */
export interface EvaluatorHost {
  /** See {@link ExtensionAPI.exec}. */
  exec: ExtensionAPI["exec"];
  /** See {@link ExtensionAPI.appendEntry}. */
  appendEntry: ExtensionAPI["appendEntry"];
}

/**
 * Key used by the per-tool-call exec cache. Null-byte separator is safe
 * because neither a command path nor POSIX argv can legitimately contain
 * a NUL byte; collisions are impossible in practice.
 */
function execCacheKey(
  cmd: string,
  args: readonly string[],
  cwd: string,
): string {
  return `${cmd}\x00${args.join("\x00")}\x00${cwd}`;
}

/**
 * Bridge pi's `ExecResult` (uses `code`) to the schema's `ExecResult`
 * (uses `exitCode`). Dropping `killed` is intentional — predicate
 * authors don't need to distinguish "timed out" from "exited
 * non-zero"; both surface as a non-zero exit for guardrail purposes.
 */
function toSchemaExecResult(r: PiExecResult): ExecResult {
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
}

/**
 * Create a tool_call-scoped exec function that memoizes by
 * `(cmd, args, cwd)`. Caches only the PROMISE so concurrent
 * predicate evaluations that hit the same key await the same
 * in-flight child process — not N redundant ones.
 *
 * `opts.cwd` defaults to `sessionCwd` (mirroring how predicates see
 * their "current cwd" via {@link PredicateContext.cwd}). `timeoutMs`
 * is forwarded as `timeout`.
 */
export function createExecCache(
  host: EvaluatorHost,
  sessionCwd: string,
): PredicateContext["exec"] {
  const cache = new Map<string, Promise<ExecResult>>();
  return (cmd, args, opts) => {
    const cwd = opts?.cwd ?? sessionCwd;
    const key = execCacheKey(cmd, args, cwd);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const piOpts: PiExecOptions = { cwd };
    if (opts?.timeoutMs !== undefined) piOpts.timeout = opts.timeoutMs;
    const p = host.exec(cmd, args, piOpts).then(toSchemaExecResult);
    cache.set(key, p);
    return p;
  };
}

/**
 * Key under which the engine auto-injects the current `agentLoopIndex`
 * into every entry written via `PredicateContext.appendEntry` or
 * `ObserverContext.appendEntry`. Rules using
 * `when.missing: { in: "agent_loop" }` filter session entries by
 * comparing this key against `ctx.agentLoopIndex`.
 *
 * Part of the on-disk session-JSONL format, exposed as a public
 * module-level constant. Re-exported from the package root
 * so plugin authors who manually inspect entries via
 * `findEntries` can import the constant by name rather than
 * hardcoding the string — a future rename would then break at
 * import time instead of silently producing un-filtered entries.
 */
export const AGENT_LOOP_INDEX_KEY = "_agentLoopIndex" as const;

/**
 * Narrow "is plain object" guard used to distinguish payloads that
 * are safe to merge into (spread) from payloads that must be wrapped
 * as `{ value, _agentLoopIndex }`.
 *
 * Anything that is NOT a plain object (arrays, Date, Map, Set, Error,
 * class instances, functions, null, undefined, primitives) falls into
 * the wrap branch. Direct `{...}` or `Object.create(null)` shapes fall
 * into the merge branch.
 *
 * Two-stage detection:
 *   1. `Object.prototype.toString.call(x)` returns `"[object Object]"`
 *      only for plain objects and for class instances of user-defined
 *      classes. It correctly excludes arrays, Date, Map, Set, Error,
 *      etc.
 *   2. A prototype check then rejects user-class instances: plain
 *      objects have `Object.prototype` (or `null` for
 *      `Object.create(null)`) as their prototype; `new Box(...)` has
 *      `Box.prototype`, which is neither.
 *
 * The explicit `Array.isArray` check is belt-and-suspenders — some
 * runtimes have historically misreported arrays via `toString`, and
 * the array case is the one most likely to hit this wrapper (an
 * observer appending a list of watched paths). Cheap to check twice.
 */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== "object") return false;
  if (Array.isArray(x)) return false;
  if (Object.prototype.toString.call(x) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(x);
  if (proto !== null && proto !== Object.prototype) return false;
  return true;
}

/**
 * Wrap a raw `host.appendEntry` so every write auto-injects the
 * current `agentLoopIndex` into the payload. Plain-object payloads
 * get the field merged in; everything else — primitives, arrays,
 * `Date`, `Map`, `Set`, `Error`, class instances, functions, null,
 * undefined — is wrapped as `{ value, _agentLoopIndex }` so
 * downstream consumers always see a consistent object shape.
 *
 * The "everything else" branch exists because the naive spread
 * (`{ ...data, ... }`) silently corrupts non-plain objects: arrays
 * become pseudo-objects with string-indexed keys, Date / Map / Set /
 * Error instances lose their internal state entirely, etc. Wrapping
 * under `value` preserves the original reference unchanged.
 *
 * The returned closure matches both {@link PredicateContext.appendEntry}
 * and {@link ObserverContext.appendEntry} so the evaluator and the
 * observer dispatcher share one wrapper.
 *
 * `findEntriesCache` (optional) is a cache map shared with a sibling
 * {@link createFindEntries} closure. When supplied, every `appendEntry`
 * call invalidates the cache entry for the written `customType` so
 * the next `findEntries(customType)` re-reads the session JSONL and
 * sees the newly-written entry (S2/E1; see ../INVARIANTS.md for the
 * S/E tag glossary). Omit the parameter to keep
 * the pre-S2 behaviour (no invalidation) — handy for tests or callers
 * that don't pair the two closures.
 */
export function createAppendEntry(
  host: EvaluatorHost,
  agentLoopIndex: number,
  findEntriesCache?: Map<string, Array<{ data: unknown; timestamp: number }>>,
): PredicateContext["appendEntry"] {
  return <T>(customType: string, data?: T) => {
    const tagged = isPlainObject(data)
      ? { ...data, [AGENT_LOOP_INDEX_KEY]: agentLoopIndex }
      : { value: data, [AGENT_LOOP_INDEX_KEY]: agentLoopIndex };
    host.appendEntry(customType, tagged);
    // S2/E1: drop the cached read for this customType so a later
    // `findEntries(customType)` call from the same phase re-materializes
    // the list and sees the write we just made. Without this, a rule's
    // `onFire` that writes + a later rule's `when.missing` that reads
    // see inconsistent snapshots within one tool_call.
    findEntriesCache?.delete(customType);
  };
}

/**
 * Adapt pi's `sessionManager.getEntries()` into the typed-and-filtered
 * view predicates (and observers) expect.
 *
 * Strategy:
 *   - pick only `type: "custom"` entries (the shape `pi.appendEntry`
 *     produces — see `CustomEntry` in pi's session-manager),
 *   - filter by `customType`,
 *   - project to `{ data, timestamp }` where `timestamp` is epoch-ms
 *     (parsed from the entry's ISO string). Epoch-ms is what turn-state
 *     checks want for chronological comparisons without having to
 *     re-parse.
 *
 * Results are memoized PER invocation of `createFindEntries` by
 * customType. The evaluator rebuilds the closure on every tool_call;
 * the observer dispatcher rebuilds on every tool_result. So each phase
 * sees a consistent snapshot across reads.
 *
 * Cross-rule write visibility (S2/E1): when the same phase also uses
 * a paired {@link createAppendEntry} with the SAME cache map, a write
 * during rule A's `onFire` invalidates the cached read for that
 * customType so rule B's `when.missing` predicate sees the fresh
 * entry. Callers that want this consistency pass in a shared cache
 * via the optional `cache` parameter; callers that omit it get the
 * old per-closure snapshot behaviour (pre-S2), which is sound only
 * when the closure never interleaves reads with writes.
 *
 * The `ctx` argument is the pi `ExtensionContext` — we re-read
 * `getEntries()` only on a cache miss. Cache keys are per-closure (or
 * per shared cache) so cross-tool_call or cross-tool_result reads
 * always see the freshest state (a new closure = a new cache).
 */
export function createFindEntries(
  ctx: ExtensionContext,
  cache?: Map<string, Array<{ data: unknown; timestamp: number }>>,
): PredicateContext["findEntries"] {
  const entryCache =
    cache ?? new Map<string, Array<{ data: unknown; timestamp: number }>>();
  return <T>(customType: string) => {
    const hit = entryCache.get(customType);
    if (hit !== undefined) {
      return hit as Array<{ data: T; timestamp: number }>;
    }
    const out: Array<{ data: T; timestamp: number }> = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType !== customType) continue;
      const ts = Date.parse(entry.timestamp);
      out.push({
        data: entry.data as T,
        timestamp: Number.isNaN(ts) ? 0 : ts,
      });
    }
    entryCache.set(
      customType,
      out as Array<{ data: unknown; timestamp: number }>,
    );
    return out;
  };
}

/**
 * Allocate a fresh session-entry cache shared between a paired
 * {@link createFindEntries} + {@link createAppendEntry} for the same
 * tool_call (evaluator) or tool_result (observer dispatcher) phase.
 *
 * Using a shared cache gives two guarantees the evaluator + dispatcher
 * rely on:
 *
 *   1. Consistent reads: N calls to `findEntries(type)` within one
 *      phase materialize the entry list ONCE per type.
 *   2. Write-through-reads (S2/E1): a write via the paired
 *      `appendEntry` invalidates that type's cached list, so the next
 *      read re-scans the session JSONL and observes the write. Without
 *      this, a rule's `onFire` appending X followed by a later rule's
 *      `when.missing: { event: X }` would read a stale pre-write
 *      snapshot.
 *
 * Consumers who don't need write-through-reads (tests, one-shot
 * `findEntries` calls) can pass a fresh cache or omit the parameter
 * on both constructors — the closures then each get their own cache
 * map and behave like the pre-S2 implementation.
 */
export function createSessionEntryCache(): Map<
  string,
  Array<{ data: unknown; timestamp: number }>
> {
  return new Map<string, Array<{ data: unknown; timestamp: number }>>();
}

// Silence a re-import of ExecOpts that older linters flag (we only use
// the type via PredicateContext["exec"] signature above).
export type { ExecOpts };
