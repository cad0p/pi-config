// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `retest-required-tracker` — invalidation observer for the `since`
 * sentinel pattern.
 *
 * ## What this file demonstrates (commit-4 polish, ADR §5 `since`)
 *
 * Observers can write "invalidator" events whose presence stale-s an
 * earlier satisfied `missing` clause:
 *
 *   - `npm-test-tracker`       writes `TEST_PASSED_EVENT` on `npm test`
 *                               success.
 *   - `retest-required-tracker` (this file) writes `RETEST_REQUIRED_EVENT`
 *                               on `git pull` success \u2014 the workspace
 *                               just changed; prior test state is stale.
 *   - `push-requires-tests` gates via
 *       `missing: { event: TEST_PASSED_EVENT, in: "agent_loop",
 *                    since: RETEST_REQUIRED_EVENT }`
 *     which fires when the most-recent `TEST_PASSED_EVENT` is older
 *     than the most-recent `RETEST_REQUIRED_EVENT` (or the tests
 *     never ran at all in this agent loop).
 *
 * Same encapsulation convention as `npm-test-tracker`: this file
 * owns the `RETEST_REQUIRED_EVENT` constant + `markRetestRequired`
 * helper + the observer, so `defineConfig` type-checks references
 * from downstream rules.
 */

import type {
  Observer,
  ObserverContext,
  PredicateContext,
} from "@cad0p/pi-steering";

/**
 * Session-entry event written when `git pull` succeeds. Rules that
 * previously satisfied `TEST_PASSED_EVENT` become stale relative to
 * this event; `push-requires-tests` compares the two via
 * `missing.since` to require a re-run after any pull.
 */
export const RETEST_REQUIRED_EVENT = "example-retest-required" as const;

/**
 * Payload shape. Minimal \u2014 we just need a presence marker with a
 * timestamp (engine-attached via `findEntries`).
 */
export interface RetestRequiredPayload {
  /** Which pull command triggered the invalidation. Debug-only. */
  command: string;
}

/**
 * Record a "retest required" session entry. Callable from an observer
 * or a rule's `onFire` \u2014 both receive a ctx with `appendEntry`.
 */
export function markRetestRequired(
  ctx: ObserverContext | PredicateContext,
  payload: RetestRequiredPayload = { command: "git pull" },
): void {
  ctx.appendEntry<RetestRequiredPayload>(RETEST_REQUIRED_EVENT, payload);
}

/**
 * The observer. `as const satisfies Observer` preserves the literal
 * `writes` tuple so `defineConfig` threads `RETEST_REQUIRED_EVENT`
 * into the `AllWrites` union \u2014 letting rules reference it from
 * `when.missing.since` with a compile-time typo check.
 */
export const retestRequiredTracker = {
  name: "retest-required-tracker",
  writes: [RETEST_REQUIRED_EVENT],
  watch: {
    toolName: "bash",
    inputMatches: { command: /^git\s+pull\b/ },
    exitCode: "success",
  },
  onResult: (event, ctx) => {
    const input = event.input as { command?: string } | undefined;
    markRetestRequired(ctx, {
      command: input?.command ?? "git pull",
    });
  },
} as const satisfies Observer;
