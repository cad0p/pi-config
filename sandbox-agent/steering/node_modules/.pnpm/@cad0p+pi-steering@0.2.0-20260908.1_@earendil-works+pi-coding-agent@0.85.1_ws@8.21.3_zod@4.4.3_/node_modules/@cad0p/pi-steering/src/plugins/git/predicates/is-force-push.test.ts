// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Unit tests for the git plugin's `isForcePush` predicate
 * (`./is-force-push.ts`), per ADR §13 (named predicates carry
 * their own unit tests — the rule-level e2e in
 * `../rules/no-force-push.test.ts` proves composition, these pin the
 * predicate's own truth table).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateContext, PredicateWord } from "../../../schema.ts";
import { mockContext } from "../../../testing/index.ts";
import { GIT_CLI_DESCRIPTOR } from "../descriptors.ts";
import { isForcePush } from "./is-force-push.ts";

function W(value: string): PredicateWord {
  return { value, text: value, rawText: value, pos: 0, end: value.length };
}

function pushCtx(words: string[]): PredicateContext {
  return mockContext({
    input: {
      tool: "bash",
      command: `git push ${words.join(" ")}`,
      basename: "git",
      args: [W("push"), ...words.map(W)],
    },
    descriptors: { git: GIT_CLI_DESCRIPTOR },
  });
}

describe("predicates/is-force-push", () => {
  it("fires on --force", () => {
    assert.equal(isForcePush(true, pushCtx(["--force"])), true);
  });

  it("fires on bundled shorts (-uf, -fu)", () => {
    assert.equal(isForcePush(true, pushCtx(["-uf", "origin", "main"])), true);
    assert.equal(isForcePush(true, pushCtx(["-fu", "origin", "main"])), true);
  });

  it("fires on --force-with-lease / --force-if-includes / --mirror", () => {
    assert.equal(isForcePush(true, pushCtx(["--force-with-lease"])), true);
    assert.equal(isForcePush(true, pushCtx(["--force-if-includes"])), true);
    assert.equal(isForcePush(true, pushCtx(["--mirror"])), true);
  });

  it("fires on leading-+ refspecs", () => {
    assert.equal(isForcePush(true, pushCtx(["origin", "+main"])), true);
    assert.equal(isForcePush(true, pushCtx(["origin", "+src:dst"])), true);
  });

  it("does NOT fire on plain pushes (or c++-port lookalikes)", () => {
    assert.equal(isForcePush(true, pushCtx(["origin", "main"])), false);
    assert.equal(isForcePush(true, pushCtx(["origin", "c++-port"])), false);
    assert.equal(isForcePush(true, pushCtx(["origin", "+"])), false);
  });

  it("inverts under `false` (spread/inner form)", () => {
    assert.equal(isForcePush(false, pushCtx(["--force"])), false);
    assert.equal(isForcePush(false, pushCtx(["origin", "main"])), true);
  });

  it("malformed args fail closed to `false`", () => {
    const ctx = pushCtx(["--force"]);
    assert.equal(isForcePush(undefined as unknown as boolean, ctx), false);
    assert.equal(isForcePush(null as unknown as boolean, ctx), false);
    assert.equal(isForcePush({ nope: 1 } as unknown as boolean, ctx), false);
  });

  it("non-bash tools never fire", () => {
    const ctx = mockContext({
      tool: "write",
      input: { tool: "write", path: "/x", content: "git push --force" },
    });
    assert.equal(isForcePush(true, ctx), false);
  });
});
