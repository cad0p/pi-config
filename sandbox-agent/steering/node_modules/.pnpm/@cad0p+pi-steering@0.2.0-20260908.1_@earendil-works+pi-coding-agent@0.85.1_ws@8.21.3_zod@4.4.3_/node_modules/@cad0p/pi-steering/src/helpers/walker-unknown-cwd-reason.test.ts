// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `walkerUnknownCwdReason`.
 *
 * Pin the helper's contract via semantic substring assertions, NOT
 * exact-string equality or length checks. Wording-tweak refactors
 * (clarifying the "dynamic cwd" phrasing, swapping em-dash for colon)
 * shouldn't fail these tests; the contract is "the message tells the
 * agent what failed, where the shell is, and how to retry".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mockContext } from "../testing/index.ts";
import { walkerUnknownCwdReason } from "./walker-unknown-cwd-reason.ts";

describe("walkerUnknownCwdReason", () => {
  it("includes the `verifying` arg verbatim", () => {
    const ctx = mockContext({ cwd: "/tmp/test-fixture" });
    const out = walkerUnknownCwdReason(ctx, "working tree status");
    assert.ok(
      out.includes("working tree status"),
      `expected message to include the verifying arg, got: ${out}`,
    );
  });

  it("includes the value of ctx.cwd", () => {
    const ctx = mockContext({ cwd: "/tmp/test-fixture" });
    const out = walkerUnknownCwdReason(ctx, "branch");
    assert.ok(
      out.includes("/tmp/test-fixture"),
      `expected message to include ctx.cwd value, got: ${out}`,
    );
  });

  it("contains the literal substring 'current directory:'", () => {
    // Pin the cue label so agents (and downstream consumers
    // composing extra retry guidance) can rely on a stable anchor
    // when scanning the reason text.
    const ctx = mockContext({ cwd: "/anywhere" });
    const out = walkerUnknownCwdReason(ctx, "upstream");
    assert.ok(
      out.includes("current directory:"),
      `expected 'current directory:' anchor, got: ${out}`,
    );
  });

  it("ends with 'Retry with a literal path.'", () => {
    // Sentence-terminating: the helper is composable via string
    // concatenation (call sites append domain-specific guidance),
    // so the base message must end cleanly.
    const ctx = mockContext({ cwd: "/x" });
    const out = walkerUnknownCwdReason(ctx, "remote");
    assert.ok(
      out.endsWith("Retry with a literal path."),
      `expected trailing 'Retry with a literal path.', got: ${out}`,
    );
  });

  it("is a single line (no embedded newlines)", () => {
    // Pi surfaces ReasonFn output to the agent as a single
    // blocked-rule reason; embedded newlines would look ragged in
    // the agent's transcript. Pin single-line.
    const ctx = mockContext({ cwd: "/repo" });
    const out = walkerUnknownCwdReason(ctx, "commit count");
    assert.ok(
      !out.includes("\n"),
      `expected single-line reason, got: ${JSON.stringify(out)}`,
    );
  });
});
