// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Smoke test for the combined-git-discipline rule pack.
 *
 * Scope: README drift guard. See `force-push-strict/steering.test.ts`
 * for the rationale.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "./steering.ts";

describe("example: combined-git-discipline", () => {
  it("exports a SteeringConfig with the two expected rules", () => {
    assert.ok(config.rules !== undefined);
    const names = config.rules.map((r) => r.name).sort();
    assert.deepEqual(
      names,
      ["no-amend", "pr-create-must-be-draft"],
      `unexpected rule set: ${names.join(", ")}`,
    );
  });

  it("does NOT disable the shipped `no-force-push` default (sealed default is wanted here)", () => {
    // Since issue #65 the default no-force-push rule blocks every
    // history-rewrite form, so this pack keeps it active instead of
    // the old disable-and-replace dance.
    assert.ok(
      !config.disabledRules?.includes("no-force-push"),
      "expected disabledRules to NOT include 'no-force-push'",
    );
  });

  it("every rule has tool=bash and a non-empty reason", () => {
    for (const rule of config.rules ?? []) {
      assert.equal(rule.tool, "bash", `rule ${rule.name} should be bash`);
      assert.ok(
        typeof rule.reason === "string" && rule.reason.length > 0,
        `rule ${rule.name} should have a non-empty reason`,
      );
    }
  });
});
