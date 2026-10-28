// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Unit tests for `extractOverride` — the inline override-comment
 * detector the v2 evaluator uses to surface `# steering-override:
 * <rule> — <reason>` annotations on bash / write / edit inputs.
 *
 * Ported from the v1 suite in `../../evaluator.test.ts` (the
 * `describe("extractOverride", ...)` block) so the v2 module is
 * directly pinned against the v1 behavior it claims parity with.
 * Phase 3c deletes v1; these tests preserve every documented regex
 * edge case independently of the evaluator pipeline.
 *
 * Each test targets one axis of the override grammar (leader
 * character, separator character, empty reason, stacked overrides,
 * mismatched rule name, …). Kept as a flat `describe` block to match
 * the v1 shape for diff-friendly porting.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractOverride } from "./override.ts";

describe("extractOverride", () => {
  it("extracts reason from a hash-leader override", () => {
    const r = extractOverride(
      "git push --force # steering-override: no-force-push \u2014 coordinated rewrite",
      "no-force-push",
    );
    assert.equal(r, "coordinated rewrite");
  });

  it("extracts reason from a slash-leader override", () => {
    const r = extractOverride(
      "// steering-override: no-console \u2014 debug session only",
      "no-console",
    );
    assert.equal(r, "debug session only");
  });

  it("accepts em dash, en dash, and hyphen as separators", () => {
    assert.equal(
      extractOverride("# steering-override: r \u2014 em", "r"),
      "em",
    );
    assert.equal(
      extractOverride("# steering-override: r \u2013 en", "r"),
      "en",
    );
    assert.equal(
      extractOverride("# steering-override: r - hyphen", "r"),
      "hyphen",
    );
  });

  it("returns null when no override is present", () => {
    assert.equal(extractOverride("git push --force", "no-force-push"), null);
  });

  it("returns null when the override targets a different rule", () => {
    const r = extractOverride(
      "# steering-override: other-rule \u2014 reason",
      "no-force-push",
    );
    assert.equal(r, null);
  });

  it("returns null when reason is empty", () => {
    const r = extractOverride("# steering-override: r \u2014   ", "r");
    assert.equal(r, null);
  });

  it("stacked overrides: looking up first rule returns its reason only", () => {
    const text =
      "cmd # steering-override: rule-a \u2014 reason-a # steering-override: rule-b \u2014 reason-b";
    assert.equal(extractOverride(text, "rule-a"), "reason-a");
  });

  it("stacked overrides: looking up second rule returns its reason only", () => {
    const text =
      "cmd # steering-override: rule-a \u2014 reason-a # steering-override: rule-b \u2014 reason-b";
    assert.equal(extractOverride(text, "rule-b"), "reason-b");
  });

  it("stacked overrides: unrelated lookup returns null (no bleed from either)", () => {
    const text =
      "cmd # steering-override: rule-a \u2014 reason-a # steering-override: rule-b \u2014 reason-b";
    assert.equal(extractOverride(text, "rule-c"), null);
  });

  it("stacked overrides: empty reason on first is skipped, scanner finds second match for same rule", () => {
    // First `foo` override has no reason (whitespace only). The scanner
    // must keep going and surface the second `foo` override's reason.
    const text =
      "# steering-override: foo \u2014   # steering-override: foo \u2014 actual reason";
    assert.equal(extractOverride(text, "foo"), "actual reason");
  });
});
