// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Unified speculative-entry synthesis for `when.missing`'s tool_call-
 * scope speculative allow.
 *
 * Replaces the pre-PR-5 specialized speculative-allow path (a pair of
 * helpers on the evaluator that matched observers against prior `&&`
 * refs on a per-call boolean basis). For every bash command
 * ref in an unconditionally-`&&`-reachable segment, for every observer
 * writing an event AND matching the ref via the shared
 * {@link matchesWatch} contract, we produce a synthetic entry that
 * later `missing` evaluations merge with real entries via timestamp
 * ordering.
 *
 * Pure function of `(refs, observers, resolvedTexts)`. The evaluator
 * wires the output into per-ref `walkerState.events` before running
 * predicates.
 *
 * `resolvedTexts` is the per-ref ENV-RESOLVED command text (issue #51
 * — the same strings rule patterns match). Observer watch patterns
 * therefore match what the ref will actually execute: a producer
 * `T="feat: x" gh pr create --title "$T"` matches a watch on the
 * resolved `--title "feat: x"`. Refs absent from the map fall back
 * to the raw {@link refToText} form.
 *
 * ## Timestamp convention
 *
 *   speculativeTimestamp(ref_j) = SPECULATIVE_BASELINE + 1 + j
 *
 * where `SPECULATIVE_BASELINE = 2^52` — a literal chosen far above
 * any epoch-ms timestamp pi writes on real entries (`Date.now()`
 * returns < 2^48 for any date through ~year 10,890 AD). The speculative
 * timestamp is thus strictly greater than ANY real entry's timestamp,
 * regardless of type or scope. So a speculative `sync-done` at ts
 * `2^52 + 1` beats a real `upstream-failed` at ts `Date.now()` in
 * the since-invalidator comparison.
 *
 * Two properties follow (see the `unification-reconsider` review's
 * "Timestamp reframing" section for the full walk-through):
 *
 *   1. **Strictly newer than every real entry across all types and
 *      scopes.** The reserved-range literal sidesteps a per-type
 *      max-plus-one approach — which would fail on a two-writes
 *      scenario where the since-invalidator's latest real entry is
 *      newer than the event type's latest real entry. A speculative
 *      entry newer than ALL real entries is newer than any subset.
 *
 *   2. **Relative ordering among multiple speculative writes follows
 *      AST order.** Ref at index `j` gets `BASELINE + 1 + j`; a later
 *      ref at `k > j` gets `BASELINE + 1 + k`. So
 *      `when.missing: { event: X, since: Y }` correctly reads X as
 *      stale when Y is written later — the two-speculative-writes-
 *      with-since-invalidator correctness case pinned by the
 *      `A && B && cr` test in this commit pack.
 *
 * ## Safety
 *
 * **Chain reachability**: only refs with joiner `&&` in an
 * unconditionally-reached segment qualify as eligible producers. The
 * `&&` short-circuit guarantees any later ref that runs saw the
 * producer complete successfully first.
 *
 * **Observer eligibility**: observers must declare
 * `watch.inputMatches.command`. Any-bash-event observers would grant
 * allow for every `foo && cr` regardless of what `foo` does. Non-bash
 * `toolName` watches are rejected early (prior `&&` refs always
 * originate from bash). Other filter fields are delegated to
 * {@link matchesWatch} against a synthesized success event — the
 * single-source-of-truth filter contract gates future new `watch`
 * fields automatically.
 *
 * @internal — not part of the public pi-steering surface.
 */

import type { CommandRef } from "@cad0p/unbash-walker";
import { refToText } from "../internal/ref-text.ts";
import { matchesWatch } from "../internal/watch-matcher.ts";
import type { Observer } from "../schema.ts";

/**
 * Speculative baseline timestamp. All synthetic entries carry
 * `SPECULATIVE_BASELINE + 1 + astIndex` so they order strictly above
 * any real entry's `timestamp` (real entries are epoch-ms from
 * `Date.now()`, well under `2^48` for any realistic date). See the
 * file-level JSDoc's "Timestamp convention" section for the full
 * rationale and the acknowledged numerical-convention caveat.
 *
 * @internal
 */
export const SPECULATIVE_BASELINE = 2 ** 52;

/**
 * Speculative session entry. Structurally a superset of real entries
 * (`{ data, timestamp }`) plus a `speculative: true` marker so the
 * built-in `missing` predicate and plugin filters over
 * `walkerState.events` can distinguish synthetic writes from real
 * ones. Default direction (include speculative) matches what
 * `missing` wants; plugins wanting pure historical semantics filter
 * with `.filter(e => !e.speculative)`.
 */
export interface SyntheticEntry<T = unknown> {
  readonly data: T;
  readonly timestamp: number;
  readonly speculative: true;
}

/** Per-ref view: `walkerState.events[customType] → SyntheticEntry[]`. */
type SyntheticEventsByType = Readonly<
  Record<string, readonly SyntheticEntry[]>
>;

/** Per-ref output keyed by {@link CommandRef} identity. */
export type SpeculativeEventsByRef = ReadonlyMap<
  CommandRef,
  SyntheticEventsByType
>;

/**
 * Compute per-ref speculative events. See file-level JSDoc for the
 * timestamp convention, reachability model, and observer eligibility.
 */
export function synthesizeSpeculativeEntries(
  refs: readonly CommandRef[],
  observers: readonly Observer[],
  resolvedTexts: ReadonlyMap<CommandRef, string>,
): SpeculativeEventsByRef {
  const result = new Map<CommandRef, SyntheticEventsByType>();

  // Reverse index `customType -> observers writing it`, pre-filtered
  // to eligible observers. Stricter than `matchesWatch` on purpose —
  // layered on top, not a reimplementation.
  const observersByWrite = new Map<string, Observer[]>();
  for (const obs of observers) {
    const watch = obs.watch;
    if (!obs.writes || !watch) continue;
    if (watch.toolName !== undefined && watch.toolName !== "bash") continue;
    if (watch.inputMatches?.["command"] === undefined) continue;
    for (const event of obs.writes) {
      const bucket = observersByWrite.get(event);
      if (bucket) bucket.push(obs);
      else observersByWrite.set(event, [obs]);
    }
  }

  // Fast path: no producing observers → every ref gets empty events.
  if (observersByWrite.size === 0) {
    for (const ref of refs) result.set(ref, EMPTY_EVENTS);
    return result;
  }

  // Single left-to-right walk. Each ref sees the active `&&`-chain's
  // speculative events; the switch below carries the joiner semantics.
  let chainEvents: Record<string, readonly SyntheticEntry[]> = {};
  let reachable = true;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    result.set(
      ref,
      Object.keys(chainEvents).length === 0 ? EMPTY_EVENTS : chainEvents,
    );

    if (ref.joiner === ";") {
      chainEvents = {};
      reachable = true;
      continue;
    }
    if (ref.joiner !== "&&" || !reachable) {
      chainEvents = {};
      reachable = false;
      continue;
    }

    // Eligible producer: test every (customType, observer) against
    // the shared `matchesWatch` with a synthesized success event.
    // First matching observer per customType wins — a second match
    // is redundant for `missing`'s presence + latest-timestamp
    // verdict. Clone the chain before extending: earlier consumer
    // refs hold frozen references to the old map.
    //
    // Resolved text first (the evaluator computes it once in
    // prepareBashState); raw refToText is the fallback for refs the
    // caller couldn't resolve (e.g. no walk state).
    const refText = resolvedTexts.get(ref) ?? refToText(ref);
    let next: Record<string, readonly SyntheticEntry[]> | null = null;
    for (const [customType, observersForType] of observersByWrite) {
      for (const obs of observersForType) {
        const matched = matchesWatch(obs.watch, {
          toolName: "bash",
          input: { command: refText },
          output: undefined,
          exitCode: 0,
        });
        if (!matched) continue;
        if (next === null) next = { ...chainEvents };
        const entry: SyntheticEntry = {
          data: {},
          timestamp: SPECULATIVE_BASELINE + 1 + i,
          speculative: true,
        };
        const existing = next[customType];
        next[customType] = existing ? [...existing, entry] : [entry];
        break;
      }
    }
    if (next !== null) chainEvents = next;
  }
  return result;
}

const EMPTY_EVENTS: SyntheticEventsByType = Object.freeze({});
