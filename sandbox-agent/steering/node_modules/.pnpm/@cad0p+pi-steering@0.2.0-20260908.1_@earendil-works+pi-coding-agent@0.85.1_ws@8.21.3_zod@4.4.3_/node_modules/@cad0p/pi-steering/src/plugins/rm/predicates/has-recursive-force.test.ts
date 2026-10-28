// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Unit tests for the rm plugin's `hasRecursiveForce` predicate
 * (`./has-recursive-force.ts`), per ADR §13 (named predicates carry
 * their own unit tests — the rule-level e2e in
 * `../rules/no-rm-rf-slash.test.ts` proves composition, these pin the
 * predicate's own truth table).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateContext, PredicateWord } from "../../../schema.ts";
import { mockContext } from "../../../testing/index.ts";
import { RM_CLI_DESCRIPTOR } from "../descriptors.ts";
import { hasRecursiveForce } from "./has-recursive-force.ts";

function W(value: string): PredicateWord {
  return { value, text: value, rawText: value, pos: 0, end: value.length };
}

function rmCtx(words: string[]): PredicateContext {
  return mockContext({
    input: {
      tool: "bash",
      command: `rm ${words.join(" ")}`,
      basename: "rm",
      args: words.map(W),
    },
    descriptors: { rm: RM_CLI_DESCRIPTOR },
  });
}

describe("predicates/has-recursive-force", () => {
  it("fires on recursive + force + `/`", () => {
    assert.equal(hasRecursiveForce(true, rmCtx(["-rf", "/"])), true);
  });

  it("fires on separated long forms", () => {
    assert.equal(
      hasRecursiveForce(true, rmCtx(["--recursive", "--force", "/"])),
      true,
    );
  });

  it("does NOT fire on recursive-only", () => {
    assert.equal(hasRecursiveForce(true, rmCtx(["-r", "/"])), false);
  });

  it("does NOT fire on force-only", () => {
    assert.equal(hasRecursiveForce(true, rmCtx(["-f", "/"])), false);
  });

  it("does NOT fire when `/` is absent (`rm -rf /tmp`)", () => {
    assert.equal(hasRecursiveForce(true, rmCtx(["-rf", "/tmp"])), false);
  });

  it("inverts under `false` (spread/inner form)", () => {
    assert.equal(hasRecursiveForce(false, rmCtx(["-rf", "/"])), false);
    assert.equal(hasRecursiveForce(false, rmCtx(["-rf", "/tmp"])), true);
  });

  it("malformed args fail closed to `false`", () => {
    const ctx = rmCtx(["-rf", "/"]);
    assert.equal(
      hasRecursiveForce(undefined as unknown as boolean, ctx),
      false,
    );
    assert.equal(hasRecursiveForce(null as unknown as boolean, ctx), false);
    assert.equal(
      hasRecursiveForce({ nope: 1 } as unknown as boolean, ctx),
      false,
    );
  });

  it("non-bash tools never fire", () => {
    const ctx = mockContext({
      tool: "write",
      input: { tool: "write", path: "/x", content: "rm -rf /" },
    });
    assert.equal(hasRecursiveForce(true, ctx), false);
  });
});
