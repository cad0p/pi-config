// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Count lock + shape invariants for the rm plugin (`./index.ts`).
 *
 * Replaces the engine-side `defaults.test.ts` count lock (issue #72):
 * the rm plugin ships EXACTLY ONE rule. Any addition is a deliberate
 * ship-surface change and must update this assertion explicitly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Rule } from "../../schema.ts";
import rmPlugin, { RM_PLUGIN_NAME } from "./index.ts";

// Widen once for shape-invariant iteration (optional fields visible).
const RULES_AS_RULE: readonly Rule[] = rmPlugin.rules ?? [];

describe("rm plugin: ship surface", () => {
  it("ships exactly one rule (count lock)", () => {
    // Locking the count keeps additions/removals a deliberate,
    // reviewed edit.
    assert.equal(rmPlugin.rules?.length, 1);
  });

  it("the shipped rule is no-rm-rf-slash", () => {
    assert.deepEqual(
      RULES_AS_RULE.map((r) => r.name),
      ["no-rm-rf-slash"],
    );
  });

  it('keeps the plugin name literal narrowed to "rm"', () => {
    // Type-level sentinel: if the literal ever widens to string, the
    // defineConfig typo-check unions collapse silently.
    const name: "rm" = RM_PLUGIN_NAME;
    assert.equal(name, "rm");
  });

  it("every rule has non-empty name, command routing, and reason", () => {
    for (const r of RULES_AS_RULE) {
      assert.ok(r.name.length > 0);
      if (r.tool !== "bash") throw new Error("narrow");
      const cmds = Array.isArray(r.command) ? r.command : [r.command];
      assert.ok(cmds.length > 0, `empty command in ${r.name}`);
      for (const c of cmds) {
        assert.ok(
          typeof c === "string" && c.length > 0 && !/\s/.test(c),
          `bad command entry in ${r.name}`,
        );
      }
      assert.ok(
        !("pattern" in r) && !("field" in r),
        `bash remnant in ${r.name}`,
      );
      assert.ok(r.reason.length > 0, `empty reason in ${r.name}`);
    }
  });
});
