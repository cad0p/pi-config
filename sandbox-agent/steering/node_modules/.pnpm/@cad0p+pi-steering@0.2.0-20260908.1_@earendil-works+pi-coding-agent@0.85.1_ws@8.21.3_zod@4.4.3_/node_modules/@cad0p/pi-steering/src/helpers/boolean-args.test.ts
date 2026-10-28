// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Direct unit tests for the shared boolean-leaf arg unwrapper
 * (`../boolean-args.ts`).
 *
 * `_unwrapBooleanLeafArg` is the test-only re-export of the
 * module-private helper used by `isClean`, `hasStagedChanges`,
 * `isForcePush`, and `hasRecursiveForce` to
 * accept the schema-advertised bare and spread shapes. End-to-end
 * coverage exists via the predicate handler tests; the direct tests
 * pin malformed-input branches the engine has trouble driving.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { _unwrapBooleanLeafArg } from "./boolean-args.ts";

describe("unwrapBooleanLeafArg: direct shape coverage", () => {
  it("bare true passes through", () => {
    assert.equal(_unwrapBooleanLeafArg(true), true);
  });

  it("bare false passes through", () => {
    assert.equal(_unwrapBooleanLeafArg(false), false);
  });

  it("spread { value: true } unwraps to true (regardless of sibling onUnknown)", () => {
    assert.equal(_unwrapBooleanLeafArg({ value: true }), true);
    assert.equal(
      _unwrapBooleanLeafArg({ value: true, onUnknown: "allow" }),
      true,
    );
  });

  it("spread { value: false } unwraps to false (regardless of sibling onUnknown)", () => {
    assert.equal(_unwrapBooleanLeafArg({ value: false }), false);
    assert.equal(
      _unwrapBooleanLeafArg({ value: false, onUnknown: "block" }),
      false,
    );
  });

  it("malformed object without `value:` returns undefined", () => {
    assert.equal(_unwrapBooleanLeafArg({ wrongKey: true }), undefined);
    assert.equal(_unwrapBooleanLeafArg({}), undefined);
  });

  it("primitive non-boolean returns undefined", () => {
    assert.equal(_unwrapBooleanLeafArg(42), undefined);
    assert.equal(_unwrapBooleanLeafArg("true"), undefined);
    assert.equal(_unwrapBooleanLeafArg(null), undefined);
    assert.equal(_unwrapBooleanLeafArg(undefined), undefined);
  });

  it("array returns undefined (not a `{ value: boolean }` shape)", () => {
    assert.equal(_unwrapBooleanLeafArg([true]), undefined);
    assert.equal(_unwrapBooleanLeafArg([]), undefined);
  });
});
