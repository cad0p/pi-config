// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Tests for `commit-description-check`. The critical path is the
 * two-call sequence within one agent loop:
 *   1. First commit blocks, onFire writes the self-mark.
 *   2. Second commit in the same loop passes.
 *   3. A commit in the NEXT agent loop blocks again.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import {
  expectAllows,
  loadHarness,
  mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import { featureBranchHost } from "../__test-helpers__.ts";
import {
  commitDescriptionCheck,
  DESCRIPTION_REVIEWED_EVENT,
} from "./commit-description-check.ts";

describe("commit-description-check", () => {
  it("blocks the first commit per loop, allows the second (self-mark)", async () => {
    // Recording host + shared ExtensionContext: writes via
    // host.appendEntry flow back into ctx.sessionManager.getEntries
    // so later evaluate() calls see the self-mark the previous call
    // wrote. Same plumbing the real pi runtime wires, minus the
    // child-process bits.
    const host = featureBranchHost();
    const ctx = mockExtensionContext("/tmp/test", host.entries);

    const harness = loadHarness({
      config: {
        plugins: [gitPlugin],
        rules: [commitDescriptionCheck],
      },
      host,
    });

    // First commit in loop 1 — blocks AND self-marks.
    const first = await harness.evaluate(
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "bash",
        input: { command: 'git commit -m "first"' },
      } as unknown as Parameters<typeof harness.evaluate>[0],
      ctx,
      1,
    );
    assert.ok(
      first !== undefined && first !== null,
      "first commit should block",
    );

    // `onFire` wrote the reminder entry.
    assert.ok(
      host.entries.some((e) => e.customType === DESCRIPTION_REVIEWED_EVENT),
      "onFire did not self-mark the DESCRIPTION_REVIEWED_EVENT entry",
    );

    // Second commit in the same loop — the reminder entry is now
    // present, so `when.missing` no longer fires; the rule
    // passes.
    const second = await harness.evaluate(
      {
        type: "tool_call",
        toolCallId: "tc2",
        toolName: "bash",
        input: { command: 'git commit -m "second"' },
      } as unknown as Parameters<typeof harness.evaluate>[0],
      ctx,
      1,
    );
    assert.equal(
      second,
      undefined,
      "second commit in the same loop should pass after self-mark",
    );

    // New agent loop (index bumps) — the entry's
    // `_agentLoopIndex` is 1, but this is loop 2, so
    // `when.missing` filters it out and the reminder fires
    // again.
    const nextLoop = await harness.evaluate(
      {
        type: "tool_call",
        toolCallId: "tc3",
        toolName: "bash",
        input: { command: 'git commit -m "new loop"' },
      } as unknown as Parameters<typeof harness.evaluate>[0],
      ctx,
      2,
    );
    assert.ok(
      nextLoop !== undefined && nextLoop !== null,
      "new-loop commit should block — stale reminder doesn't carry over",
    );
  });

  it("does NOT fire on a non-commit command", async () => {
    const harness = loadHarness({
      config: {
        plugins: [gitPlugin],
        rules: [commitDescriptionCheck],
      },
    });
    await expectAllows(harness, { command: "git status" });
  });
});
