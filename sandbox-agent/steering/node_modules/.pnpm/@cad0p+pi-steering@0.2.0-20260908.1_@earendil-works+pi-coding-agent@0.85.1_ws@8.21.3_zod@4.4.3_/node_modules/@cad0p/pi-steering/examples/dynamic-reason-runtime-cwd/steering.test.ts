// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Tests for the dynamic-reason + walker-unknown-cwd example.
 *
 * Pin the two ReasonFn branches:
 *
 *   1. Walker-unknown cwd → reason text contains
 *      `walkerUnknownCwdReason`'s anchor ("current directory:") AND
 *      the example's appended retry guidance ("literal path"
 *      reference is in the helper, "package directory" is in the
 *      append).
 *   2. Walker-known cwd → reason text is the static "uncommitted
 *      changes" message.
 *
 * Also smoke-test the config shape (registered rule, bash/command,
 * non-empty reason callable). The third branch (walker-known + clean
 * tree → no fire) is covered structurally via the rule-shape pin
 * below — inverting the `when:` clause regresses the test — rather
 * than via a full engine roundtrip; full-engine coverage of the
 * three-branch matrix is a v0.1.x candidate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateContext } from "@cad0p/pi-steering";
import { mockContext } from "@cad0p/pi-steering/testing";
import config from "./steering.ts";

/**
 * Pull the only rule out of the config. Throws if the example
 * regresses to a multi-rule shape — the tests below assume one rule.
 */
function getDeployRule() {
  assert.ok(config.rules !== undefined, "config.rules should be defined");
  const rule = config.rules.find(
    (r) => r.name === "deploy-requires-clean-tree",
  );
  assert.ok(rule, "deploy-requires-clean-tree rule must be registered");
  return rule;
}

/**
 * Invoke the rule's `reason` function. The example uses a function
 * reason (not a string), so this helper unwraps the callable.
 */
async function callReason(ctx: PredicateContext): Promise<string> {
  const rule = getDeployRule();
  assert.equal(
    typeof rule.reason,
    "function",
    "this example's reason should be a ReasonFn",
  );
  const out = await (
    rule.reason as (ctx: PredicateContext) => string | Promise<string>
  )(ctx);
  return out;
}

describe("example: dynamic-reason-runtime-cwd", () => {
  it("rule.when uses the canonical positive form (`isClean: false`)", () => {
    // Pins the rule's `when:` to the `isClean: false` positive form
    // plus the command-first `subcommand` routing (the old
    // `/^npm\\s+run\\s+deploy\\b/` anchor). The equivalent
    // `{ not: { isClean: true } }` shape produces the same fail-CLOSED
    // behavior on the walker-unknown branch under the trinary engine's
    // default block-level `onUnknown: "block"`, but diverges on the
    // walker-known + git-fails row (see README truth table); the
    // positive form is preferred for readability and per-leaf modifier
    // composition. See README "Why isClean: false over not: { isClean: true }".
    const rule = getDeployRule();
    assert.deepEqual(rule.when, {
      subcommand: ["run", "deploy"],
      isClean: false,
    });
  });

  it("registers the deploy-requires-clean-tree rule (bash/command)", () => {
    const rule = getDeployRule();
    assert.equal(rule.tool, "bash");
    assert.equal(rule.command, "npm");
  });

  it("walker-unknown cwd → reason composes walkerUnknownCwdReason + retry guidance", async () => {
    // Walker couldn't statically resolve cwd. The ReasonFn detects
    // `ctx.walkerState.cwd === "unknown"` and delegates to
    // `walkerUnknownCwdReason`, then appends domain-specific retry
    // guidance.
    const ctx = mockContext({
      cwd: "/repo/root",
      walkerState: { cwd: "unknown", env: new Map() },
    });
    const reason = await callReason(ctx);

    // Helper anchor — pinned by walker-unknown-cwd-reason.test.ts.
    assert.ok(
      reason.includes("current directory:"),
      `expected helper anchor, got: ${reason}`,
    );
    // Helper surfaces the actual ctx.cwd.
    assert.ok(
      reason.includes("/repo/root"),
      `expected ctx.cwd in reason, got: ${reason}`,
    );
    // Example's appended retry guidance.
    assert.ok(
      reason.includes("package directory"),
      `expected example's retry guidance ('package directory'), got: ${reason}`,
    );
  });

  it("walker-known cwd → reason is the static `uncommitted changes` message", async () => {
    // Walker statically resolved cwd. The dirty-tree path: gitPlugin's
    // `isClean` returned false, the rule fires, and the ReasonFn
    // produces the domain-specific reason text.
    const ctx = mockContext({
      cwd: "/repo/root",
      walkerState: { cwd: "/repo/root", env: new Map() },
    });
    const reason = await callReason(ctx);

    // Static text — wording-tweak refactors should not break this
    // assertion; pin substrings, not exact equality.
    assert.ok(
      reason.toLowerCase().includes("uncommitted"),
      `expected static reason to mention 'uncommitted', got: ${reason}`,
    );
    // And the helper anchor MUST be absent on the static branch.
    assert.ok(
      !reason.includes("current directory:"),
      `static branch must not emit the helper anchor, got: ${reason}`,
    );
  });
});
