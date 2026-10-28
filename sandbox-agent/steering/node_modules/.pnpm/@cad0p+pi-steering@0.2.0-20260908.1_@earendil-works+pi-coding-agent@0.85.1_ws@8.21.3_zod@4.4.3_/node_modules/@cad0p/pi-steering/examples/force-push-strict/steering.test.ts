// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Smoke test for the force-push-strict rule pack.
 *
 * Scope: README drift guard. Asserts that `steering.ts` compiles
 * (covered by `tsc --noEmit` in the typecheck script) and that the
 * resolved config has the expected shape. Full behavioral coverage
 * (every flag form, every wrapper form) lives in the engine's own test
 * suite, not here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expectAllows,
  expectBlocks,
  loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./steering.ts";

describe("example: force-push-strict", () => {
  it("exports a SteeringConfig with at least one rule", () => {
    assert.ok(config.rules !== undefined, "config.rules should be defined");
    assert.ok(
      config.rules.length >= 1,
      "config.rules should have at least one rule",
    );
  });

  it("registers the strict rule name", () => {
    const names = config.rules!.map((r) => r.name);
    assert.ok(
      names.includes("no-force-push-strict"),
      `expected no-force-push-strict in rules, got: ${names.join(", ")}`,
    );
  });

  it("disables the default `no-force-push` so the stricter variant owns the reason message", () => {
    assert.ok(
      config.disabledRules?.includes("no-force-push"),
      "expected disabledRules to include 'no-force-push'",
    );
  });

  it("strict rule has a bash/command shape and a non-empty reason", () => {
    const strict = config.rules!.find((r) => r.name === "no-force-push-strict");
    assert.ok(strict, "no-force-push-strict not found");
    assert.equal(strict!.tool, "bash");
    assert.ok(
      typeof strict!.reason === "string" && strict!.reason.length > 0,
      "reason should be a non-empty string",
    );
  });

  it("strict rule routes via registered when: leaves (no requires:/unless: fn slots)", () => {
    // Doctrinal shape: the named force signal is a REGISTERED
    // predicate consumed by name alongside `subcommand:` — function-
    // valued `requires:` / `unless:` are an antipattern in examples
    // (CI-pinned repo-wide); `requires:` / `unless:` Pattern string
    // forms stay allowed.
    const strict = config.rules!.find((r) => r.name === "no-force-push-strict");
    assert.ok(strict, "no-force-push-strict not found");
    assert.deepEqual(strict!.when, {
      subcommand: "push",
      isForcePushSignal: true,
    });
    assert.ok(!("requires" in strict!), "requires: slot must be absent");
    assert.ok(!("unless" in strict!), "unless: slot must be absent");
  });

  it("blocks git push --force, allows a plain push", async () => {
    const h = loadHarness({ config });
    await expectBlocks(
      h,
      { command: "git push --force" },
      { rule: "no-force-push-strict" },
    );
    await expectBlocks(
      h,
      { command: "git push origin +main" },
      { rule: "no-force-push-strict" },
    );
    await expectAllows(h, { command: "git push origin main" });
  });
});
