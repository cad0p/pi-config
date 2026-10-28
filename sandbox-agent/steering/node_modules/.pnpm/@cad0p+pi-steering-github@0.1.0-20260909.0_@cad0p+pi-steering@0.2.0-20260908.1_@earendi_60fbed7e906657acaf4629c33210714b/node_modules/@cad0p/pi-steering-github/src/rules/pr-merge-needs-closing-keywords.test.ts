// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `pr-merge-needs-closing-keywords` pins: the command-first routing
 * shape plus the fully declarative gate. The anchor surface (which
 * commands route at all) is covered end-to-end in
 * `../integration.test.ts`; this describe pins the rule OBJECT
 * (routing keys + the `when` leaves the gate composes).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
import { ISSUE_REF } from "../helpers/patterns.ts";
import { prMergeNeedsClosingKeywords } from "./pr-merge-needs-closing-keywords.ts";

describe("github plugin — pr-merge-needs-closing-keywords (declarative shape)", () => {
  it("routes command-first: command gh + the pr merge sequence", () => {
    const rule = prMergeNeedsClosingKeywords as unknown as {
      tool?: unknown;
      command?: unknown;
      field?: unknown;
      pattern?: unknown;
      when?: { subcommand?: unknown };
    };
    assert.equal(rule.tool, "bash");
    assert.equal(rule.command, "gh");
    assert.equal(rule.field, undefined);
    assert.equal(rule.pattern, undefined);
    assert.deepEqual(rule.when?.subcommand, {
      anyOf: [["pr", "merge"]],
      onUnknown: "allow",
    });
  });

  it("gates fully declaratively: not.infoOnly + requiresFlagValue, zero condition code", () => {
    const rule = prMergeNeedsClosingKeywords as unknown as {
      unless?: unknown;
      when?: {
        condition?: unknown;
        not?: { infoOnly?: unknown };
        requiresFlagValue?: { flags?: readonly string[]; matches?: RegExp };
      };
    };
    assert.equal(
      rule.unless,
      undefined,
      "no unless — the gate must be declarative when-only",
    );
    assert.equal(
      rule.when?.condition,
      undefined,
      "zero condition code — the predicates fully replace when.condition",
    );
    // Carve-out leaf: read-only introspection never blocks (--help/
    // --version defaults + GitHub's additive -h).
    assert.deepEqual(
      rule.when?.not?.infoOnly,
      { extraFlags: ["-h"] },
      "the info-only carve-out must be negated via not:",
    );
    // Subject leaf: LAST-flag-wins across the subject aliases — derived
    // from the owning table entry (INTENTIONALLY changed: was the
    // hand-built literal `["--subject", "-t"]`; the rule now spreads
    // the entry's `aliases`, so a table change flows through with no
    // second edit site). The pattern is compared by source/flags
    // (deepEqual compares RegExps exactly that way), not by identity.
    assert.deepEqual(
      rule.when?.requiresFlagValue,
      {
        flags: [...GH_CLI_DESCRIPTOR.flags.subject.aliases],
        matches: new RegExp(ISSUE_REF, "i"),
      },
      "requiresFlagValue must pin the alias set and the ISSUE_REF match",
    );
  });
});
