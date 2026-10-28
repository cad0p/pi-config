// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Smoke test for the draft-prs-only rule pack.
 *
 * Scope: README drift guard. See `force-push-strict/steering.test.ts`
 * for the rationale.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "./steering.ts";

describe("example: draft-prs-only", () => {
  it("exports a SteeringConfig with at least one rule", () => {
    assert.ok(config.rules !== undefined);
    assert.ok(config.rules.length >= 1);
  });

  it("registers pr-create-must-be-draft", () => {
    assert.ok(config.rules);
    const names = config.rules.map((r) => r.name);
    assert.ok(
      names.includes("pr-create-must-be-draft"),
      `expected pr-create-must-be-draft in rules, got: ${names.join(", ")}`,
    );
  });

  it("rule exempts --draft via `not: { flag: }` (not `unless:`)", () => {
    assert.ok(config.rules);
    const rule = config.rules.find((r) => r.name === "pr-create-must-be-draft");
    assert.ok(rule);
    // Structural check: the --draft carve-out lives in `not: { flag: }`
    // (the old `unless: "--draft\\b"` string hack migrates here —
    // the `requires:` / `unless:` Pattern restriction follows the gh
    // table). Its specific contents are pinned by the engine's suite.
    const not = (rule.when as { not?: { flag?: unknown } } | undefined)?.not;
    assert.ok(
      not !== undefined && not.flag !== undefined,
      "rule must declare a `not: { flag: }` carve-out",
    );
  });

  it("declares its plugins explicitly (additive)", () => {
    assert.ok(
      config.disabledRules === undefined || config.disabledRules.length === 0,
    );
  });
});
