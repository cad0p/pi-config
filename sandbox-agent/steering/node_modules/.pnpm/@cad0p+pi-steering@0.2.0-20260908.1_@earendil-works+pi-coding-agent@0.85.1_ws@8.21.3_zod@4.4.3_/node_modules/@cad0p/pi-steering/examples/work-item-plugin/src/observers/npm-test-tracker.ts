// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `npm-test-tracker` — example observer.
 *
 * Watches `bash` tool_results where the command matches `/^npm test/`
 * with `exitCode: "success"`. On match, records a `TEST_PASSED_EVENT`
 * session entry so rules can later consult whether tests have passed
 * this agent loop.
 *
 * ## What this file demonstrates (ADR §14)
 *
 * The canonical observer encapsulation convention — every observer
 * file exports three things:
 *
 *   1. A `<EVENT>_EVENT` constant (the session-entry event type).
 *   2. A `mark<Event>` helper that calls `ctx.appendEntry(<TYPE>)`
 *      with the right shape.
 *   3. The observer itself, using the helper.
 *
 * Rules that gate on this event import `TEST_PASSED_EVENT` (not the
 * raw string) and/or call `markTestPassed` from their own `onFire`.
 * The raw string literal lives in exactly one place — here — and
 * downstream typos become compile errors.
 */

import type {
  Observer,
  ObserverContext,
  PredicateContext,
} from "@cad0p/pi-steering";

/**
 * Session-entry type written when `npm test` succeeds. Rules gate via
 * `when: { missing: { event: TEST_PASSED_EVENT, in: "agent_loop" } }`.
 */
export const TEST_PASSED_EVENT = "example-npm-test-passed" as const;

/**
 * Typed shape for the payload we write. Observers that need richer
 * state (e.g. the test command variant, time-stamp, etc.) extend this
 * interface; keeping the write helper as the one-stop shape definition
 * keeps rule authors reading just the observer file to understand the
 * contract.
 */
export interface TestPassedPayload {
  /** Which command variant passed. Handy for debugging / filtering. */
  command: string;
}

/**
 * Record a "tests passed" session entry. Callable from either an
 * observer (`tool_result` hook) or a rule's `onFire` hook — both
 * receive a ctx with `appendEntry`. The loose context type here keeps
 * the helper reusable across both.
 */
export function markTestPassed(
  ctx: ObserverContext | PredicateContext,
  payload: TestPassedPayload = { command: "npm test" },
): void {
  ctx.appendEntry<TestPassedPayload>(TEST_PASSED_EVENT, payload);
}

/**
 * The observer itself. `as const satisfies Observer` preserves the
 * literal `name: "npm-test-tracker"` and the `writes` tuple so
 * `defineConfig`'s compile-time cross-reference checking works —
 * rules referencing `missing: { event: TEST_PASSED_EVENT }` get
 * validated against this observer's declared writes.
 *
 * See ADR §7 (`writes` declarations) for the authoring-pattern
 * footgun around bare `: Observer` annotations.
 */
export const npmTestTracker = {
  name: "npm-test-tracker",
  writes: [TEST_PASSED_EVENT],
  watch: {
    toolName: "bash",
    inputMatches: { command: /^npm\s+test\b/ },
    exitCode: "success",
  },
  onResult: (event, ctx) => {
    // Pull the command out of the raw event for the payload. The
    // watch filter already guaranteed we're on a bash event whose
    // `input.command` matches our regex — the cast is safe.
    const input = event.input as { command?: string } | undefined;
    markTestPassed(ctx, {
      command: input?.command ?? "npm test",
    });
  },
} as const satisfies Observer;
