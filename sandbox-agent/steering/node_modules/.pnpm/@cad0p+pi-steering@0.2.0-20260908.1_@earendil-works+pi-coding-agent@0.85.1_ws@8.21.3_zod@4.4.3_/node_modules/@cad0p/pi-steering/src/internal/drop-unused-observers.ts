// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Observer-drop optimization.
 *
 * At config-build time, observers whose declared `writes: [...]` are
 * entirely unconsumed by any rule's `missing.event` / `missing.since`
 * can be dropped: they'd only fire on `tool_result` and write entries
 * no rule ever reads. Dropping them skips both the write (cheaper
 * session JSONL) and the speculative-synthesis contribution (no chain
 * entries for events nobody consults).
 *
 * Observers with `writes === undefined` or `writes: []` are kept
 * unconditionally — without a declaration we can't prove they're
 * unused, and `[]` is conservative parity with undeclared. Plugin
 * authors are encouraged to declare `writes` both for this
 * optimization and for `defineConfig`'s compile-time type inference.
 *
 * Pure function — no logging. Callers (session-runtime, testing)
 * log on drop so tests can inspect `dropped` directly without
 * intercepting stdout.
 */

import type { Observer, Rule, TopLevelWhenClause } from "../schema.ts";

/** An observer dropped by {@link dropUnusedObservers}. */
export interface DroppedObserver {
  readonly name: string;
  readonly writes: readonly string[];
  readonly reason: "unused-writes";
}

/**
 * Partition `observers` into kept and dropped based on whether each
 * observer's declared writes are consumed by any rule.
 *
 * @param observers - Observers to filter (any origin — plugin-merged
 *   or user-authored).
 * @param rules - Full rule set whose `missing.event` / `missing.since`
 *   references determine consumption. Disabled rules should already
 *   be filtered out by the caller — this helper honors whatever's
 *   passed in.
 * @param exemptionWhens - Exemption clauses (config + plugin buckets)
 *   whose top-level `missing` references ALSO count as consumption.
 *   Without this, an observer whose writes are consumed ONLY by an
 *   exemption's `missing` would be dropped and the carve-out would
 *   be silently dead (O1 parity — same scan as rules).
 */
export function dropUnusedObservers(
  observers: readonly Observer[],
  rules: readonly Rule[],
  exemptionWhens: readonly TopLevelWhenClause<string>[] = [],
): { kept: readonly Observer[]; dropped: readonly DroppedObserver[] } {
  const consumed = collectConsumedEvents(rules, exemptionWhens);
  const kept: Observer[] = [];
  const dropped: DroppedObserver[] = [];
  for (const o of observers) {
    if (o.writes === undefined || o.writes.length === 0) {
      kept.push(o);
      continue;
    }
    if (o.writes.some((w) => consumed.has(w))) {
      kept.push(o);
      continue;
    }
    dropped.push({
      name: o.name,
      writes: o.writes,
      reason: "unused-writes",
    });
  }
  return { kept, dropped };
}

/** Collect every event referenced by any rule's `missing.event` /
 *  `missing.since` — plus exemption clauses' top-level `missing`
 *  (identical scan, O1 parity: an observer whose writes feed an
 *  exemption must survive the drop or the carve-out dies silently).
 *  Rules and exemptions without `when.missing` contribute nothing. */
function collectConsumedEvents(
  rules: readonly Rule[],
  exemptionWhens: readonly TopLevelWhenClause<string>[] = [],
): Set<string> {
  const consumed = new Set<string>();
  for (const rule of rules) {
    const h = rule.when?.missing;
    if (h === undefined) continue;
    if (typeof h.event === "string") consumed.add(h.event);
    if (typeof h.since === "string") consumed.add(h.since);
  }
  for (const when of exemptionWhens) {
    const h = when.missing;
    if (h === undefined) continue;
    if (typeof h.event === "string") consumed.add(h.event);
    if (typeof h.since === "string") consumed.add(h.since);
  }
  return consumed;
}
