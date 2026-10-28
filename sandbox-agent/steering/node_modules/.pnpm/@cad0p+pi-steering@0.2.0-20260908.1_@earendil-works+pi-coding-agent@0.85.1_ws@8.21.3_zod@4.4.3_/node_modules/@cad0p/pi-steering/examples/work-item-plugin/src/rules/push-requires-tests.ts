// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `push-requires-tests` — example rule.
 *
 * Demonstrates three v0.1.0 engine features in one rule:
 *
 *   1. Observer → rule coupling via shared constants (ADR §5, §14).
 *      `npm-test-tracker` writes `TEST_PASSED_EVENT` on every
 *      successful `npm test`; this rule gates `git push` on
 *      `when.missing`, which fires while the event is missing.
 *
 *   2. Temporal invalidation via `since` (PR §4). A separate observer
 *      `retest-required-tracker` writes `RETEST_REQUIRED_EVENT` on
 *      every `git pull`. Even if tests passed earlier in the loop, a
 *      subsequent pull stale-s the test state — the rule fires again,
 *      forcing a re-run against the updated tree.
 *
 *   3. `&&`-chain speculative allow (PR §4). Because the engine
 *      sees `npm-test-tracker`'s `writes: [TEST_PASSED_EVENT]`, it
 *      treats `npm test && git push` as safe: the push is gated on
 *      the prior `&&` ref, and `&&` short-circuits on test failure.
 *      This breaks the "block → agent retries same chain → block"
 *      loop without weakening the guardrail for non-chained pushes.
 *
 * `in: "agent_loop"` scopes everything to the current user prompt +
 * its tool calls. Running tests in a prior agent loop doesn't let
 * you push in this one.
 *
 * Override: disallowed. Pushing without proof of green tests is an
 * inherent-risk action here.
 */

import type { Rule } from "@cad0p/pi-steering";
import { TEST_PASSED_EVENT } from "../observers/npm-test-tracker.ts";
import { RETEST_REQUIRED_EVENT } from "../observers/retest-required-tracker.ts";

export const pushRequiresTests = {
  name: "push-requires-tests",
  tool: "bash",
  command: "git",
  when: {
    subcommand: "push",
    // Fires when TEST_PASSED_EVENT has NOT been written in the
    // current agent loop, OR its most-recent entry is older than
    // the most-recent RETEST_REQUIRED_EVENT (e.g. a later `git pull`
    // stale-d the test state).
    missing: {
      event: TEST_PASSED_EVENT,
      in: "agent_loop",
      since: RETEST_REQUIRED_EVENT,
    },
  },
  reason:
    "Run `npm test` successfully in this agent loop before pushing. " +
    "If you ran `git pull` after the last test, re-run tests.",
  noOverride: true,
  // Declaring the observer's write-type in our `writes` is NOT
  // required — the observer already declares it. This rule doesn't
  // write anything, so no `writes` here.
} as const satisfies Rule;
