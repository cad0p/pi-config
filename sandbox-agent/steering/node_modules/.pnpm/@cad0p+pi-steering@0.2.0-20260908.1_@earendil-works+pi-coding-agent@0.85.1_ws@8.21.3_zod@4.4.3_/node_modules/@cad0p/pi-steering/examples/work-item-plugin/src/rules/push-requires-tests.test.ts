// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Integration tests for `push-requires-tests`.
 *
 * Exercises the observer → rule handoff end-to-end via `loadHarness`:
 *
 *   1. Push without a prior TEST_PASSED_EVENT entry → block.
 *   2. Dispatch an `npm test` success event through the harness →
 *      the observer writes TEST_PASSED_EVENT into the session entries.
 *   3. Push in the same agent loop → allow.
 *   4. Dispatch a `git pull` → observer writes RETEST_REQUIRED_EVENT,
 *      stale-ing the test entry. Push now blocks again (PR §4 `since`).
 *   5. Chain-aware: `npm test && git push` allowed pre-execution
 *      because the prior `&&` ref matches the npm-test observer (PR §4).
 *
 * Step (2) uses `harness.dispatch` — the same call production uses on
 * `tool_result`. `createRecordingHost` + `mockExtensionContext` share
 * a single entries array so writes via `harness.dispatch` flow back
 * into `harness.evaluate`'s view of the session.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plugin } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import {
  createRecordingHost,
  expectAllows,
  expectBlocks,
  loadHarness,
  mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import {
  npmTestTracker,
  TEST_PASSED_EVENT,
} from "../observers/npm-test-tracker.ts";
import {
  RETEST_REQUIRED_EVENT,
  retestRequiredTracker,
} from "../observers/retest-required-tracker.ts";

import { pushRequiresTests } from "./push-requires-tests.ts";

/**
 * Plugin bundling the two observers this rule interacts with. Keeps
 * the test config focused on what's under exercise — no unrelated
 * rules from the work-item plugin.
 */
const testPlugin: Plugin = {
  name: "test",
  observers: [npmTestTracker, retestRequiredTracker],
};

describe("push-requires-tests", () => {
  it("blocks git push when no TEST_PASSED entry exists", async () => {
    const harness = loadHarness({
      config: {
        plugins: [testPlugin, gitPlugin],
        rules: [pushRequiresTests],
      },
    });
    await expectBlocks(
      harness,
      { command: "git push origin feat/x" },
      { rule: "push-requires-tests" },
    );
  });

  it("does NOT fire on unrelated commands", async () => {
    const harness = loadHarness({
      config: {
        plugins: [testPlugin, gitPlugin],
        rules: [pushRequiresTests],
      },
    });
    await expectAllows(harness, { command: "git status" });
  });

  it("allows git push after observer records a TEST_PASSED entry", async () => {
    // Recording host + shared ExtensionContext: writes via
    // host.appendEntry (from the dispatcher) flow into
    // ctx.sessionManager.getEntries so the later evaluate() sees
    // the TEST_PASSED entry the observer recorded. Mirrors the
    // bridge the real pi runtime builds in `src/index.ts`.
    const host = createRecordingHost();
    const ctx = mockExtensionContext("/tmp/test", host.entries);

    const harness = loadHarness({
      config: {
        plugins: [testPlugin, gitPlugin],
        rules: [pushRequiresTests],
      },
      host,
    });

    // Simulate: pi emits a tool_result for a successful `npm test`.
    await harness.dispatch(
      {
        type: "tool_result",
        toolCallId: "tc1",
        toolName: "bash",
        input: { command: "npm test" },
        content: [],
        details: { exitCode: 0 },
      } as unknown as Parameters<typeof harness.dispatch>[0],
      ctx,
      0,
    );

    // The observer should have written TEST_PASSED_EVENT.
    assert.ok(
      host.entries.some((e) => e.customType === TEST_PASSED_EVENT),
      "observer did not record TEST_PASSED_EVENT",
    );

    // Now the push should be allowed — the rule's
    // `when.missing` finds the entry in the current agent loop.
    const result = await harness.evaluate(
      {
        type: "tool_call",
        toolCallId: "tc2",
        toolName: "bash",
        input: { command: "git push origin feat/x" },
      } as unknown as Parameters<typeof harness.evaluate>[0],
      ctx,
      0,
    );
    assert.equal(result, undefined);
  });

  it("re-blocks push after `git pull` stale-s the test entry (missing.since)", async () => {
    // Demonstrates the PR #4 `since` invalidation sentinel. The
    // rule is gated on `TEST_PASSED_EVENT` but `since: RETEST_REQUIRED_EVENT`
    // means a later pull stale-s the test state.
    const host = createRecordingHost();
    const ctx = mockExtensionContext("/tmp/test", host.entries);

    const harness = loadHarness({
      config: {
        plugins: [testPlugin, gitPlugin],
        rules: [pushRequiresTests],
      },
      host,
    });

    // 1. Tests pass.
    await harness.dispatch(
      {
        type: "tool_result",
        toolCallId: "tc1",
        toolName: "bash",
        input: { command: "npm test" },
        content: [],
        details: { exitCode: 0 },
      } as unknown as Parameters<typeof harness.dispatch>[0],
      ctx,
      0,
    );

    // 2. Pull stale-s the test state.
    await harness.dispatch(
      {
        type: "tool_result",
        toolCallId: "tc2",
        toolName: "bash",
        input: { command: "git pull" },
        content: [],
        details: { exitCode: 0 },
      } as unknown as Parameters<typeof harness.dispatch>[0],
      ctx,
      0,
    );

    assert.ok(
      host.entries.some((e) => e.customType === RETEST_REQUIRED_EVENT),
      "retest observer did not record RETEST_REQUIRED_EVENT",
    );

    // 3. Push blocked now — the most-recent TEST_PASSED_EVENT is
    // older than the most-recent RETEST_REQUIRED_EVENT.
    const result = await harness.evaluate(
      {
        type: "tool_call",
        toolCallId: "tc3",
        toolName: "bash",
        input: { command: "git push origin feat/x" },
      } as unknown as Parameters<typeof harness.evaluate>[0],
      ctx,
      0,
    );
    assert.ok(result && "block" in result, "post-pull push should block");
  });

  it("`&&`-chain: `npm test && git push` is allowed pre-execution", async () => {
    // Demonstrates the PR #4 speculative allow. The
    // evaluator runs BEFORE the chain executes, so the observer
    // hasn't written TEST_PASSED_EVENT yet — but because the prior
    // `&&` ref matches the npm-test observer's watch, the engine
    // speculatively allows. Safe: if `npm test` fails, `&&` short-
    // circuits and `git push` never runs.
    const harness = loadHarness({
      config: {
        plugins: [testPlugin, gitPlugin],
        rules: [pushRequiresTests],
      },
    });
    await expectAllows(harness, {
      command: "npm test && git push origin feat/x",
    });
  });

  it("`&&`-chain: `git push && npm test` is NOT allowed (push is first)", async () => {
    // Order matters — the speculative allow looks at PRIOR && refs
    // only. Here push is first, so there's no prior observer to
    // cite; the rule fires normally.
    const harness = loadHarness({
      config: {
        plugins: [testPlugin, gitPlugin],
        rules: [pushRequiresTests],
      },
    });
    await expectBlocks(
      harness,
      { command: "git push origin feat/x && npm test" },
      { rule: "push-requires-tests" },
    );
  });

  it("`&&`-chain: `npm test ; git push` still blocks (`;` does not qualify)", async () => {
    // Only `&&` predecessors qualify for speculative allow. A
    // `;`-joined prior doesn't short-circuit, so granting the
    // allow would be unsafe.
    const harness = loadHarness({
      config: {
        plugins: [testPlugin, gitPlugin],
        rules: [pushRequiresTests],
      },
    });
    await expectBlocks(
      harness,
      { command: "npm test ; git push origin feat/x" },
      { rule: "push-requires-tests" },
    );
  });
});
