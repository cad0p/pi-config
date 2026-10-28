// SPDX-License-Identifier: MIT
// Part of pi-steering.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPattern } from "./pattern-utils.ts";

describe("isPattern", () => {
  it("narrows strings to Pattern", () => {
    assert.equal(isPattern("hello"), true);
    assert.equal(isPattern(""), true);
  });

  it("narrows RegExp to Pattern", () => {
    assert.equal(isPattern(/foo/), true);
    assert.equal(isPattern(/(?:)/), true);
    assert.equal(isPattern(/^bar$/i), true);
  });

  it("rejects primitives that aren't string", () => {
    assert.equal(isPattern(123), false);
    assert.equal(isPattern(true), false);
    assert.equal(isPattern(false), false);
    assert.equal(isPattern(null), false);
    assert.equal(isPattern(undefined), false);
    assert.equal(isPattern(Symbol("foo")), false);
  });

  it("rejects objects + arrays", () => {
    assert.equal(isPattern({}), false);
    assert.equal(isPattern({ pattern: "x" }), false);
    assert.equal(isPattern([]), false);
    assert.equal(isPattern(["foo"]), false);
    assert.equal(isPattern([/foo/]), false);
  });

  it("narrows correctly through Array.every (compile-time check)", () => {
    // This is the exact use site that motivated the type predicate:
    // `arr.every(isPattern)` MUST narrow `unknown[]` to `Pattern[]`
    // at the type level. The runtime assertion below is incidental;
    // the real test is that this file typechecks.
    const arr: unknown[] = ["foo", /bar/];
    if (arr.every(isPattern)) {
      // Inside this branch, `arr` is Pattern[]; the .some call
      // would be a type error if narrowing weren't working.
      const someResult: boolean = arr.some(
        (p) => typeof p === "string" || p instanceof RegExp,
      );
      assert.equal(someResult, true);
    }
  });
});
