// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Smoke test for the no-amend rule pack.
 *
 * Scope: README drift guard. See `force-push-strict/steering.test.ts`
 * for the rationale (we're catching compilation drift, not regressing
 * every rule behavior).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "./steering.ts";

describe("example: no-amend", () => {
  it("exports a SteeringConfig with at least one rule", () => {
    assert.ok(config.rules !== undefined, "config.rules should be defined");
    assert.ok(
      config.rules.length >= 1,
      "config.rules should have at least one rule",
    );
  });

  it("registers the no-amend rule", () => {
    const names = config.rules!.map((r) => r.name);
    assert.ok(
      names.includes("no-amend"),
      `expected no-amend in rules, got: ${names.join(", ")}`,
    );
  });

  it("no-amend rule has a bash/command shape and a non-empty reason", () => {
    const rule = config.rules!.find((r) => r.name === "no-amend");
    assert.ok(rule);
    assert.equal(rule!.tool, "bash");
    assert.ok(
      typeof rule!.reason === "string" && rule!.reason.length > 0,
      "reason should be a non-empty string",
    );
  });

  it("declares its plugins explicitly (additive)", () => {
    assert.ok(
      config.disabledRules === undefined || config.disabledRules.length === 0,
      "no-amend is additive; disabledRules should be empty or absent",
    );
  });
});
