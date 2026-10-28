// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Unit tests for the `workItemFormat` predicate.
 *
 * Uses `testPredicate` from `@cad0p/pi-steering/testing` — the lightest
 * possible way to exercise a predicate: construct a `PredicateContext`,
 * call the handler, get the boolean verdict.
 *
 * We do NOT spin up a full harness here; `index.test.ts` covers the
 * end-to-end path. Per-file unit tests focus on the one thing the file
 * owns.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateWord } from "@cad0p/pi-steering";
import { testPredicate } from "@cad0p/pi-steering/testing";
import { workItemFormat } from "./work-item-format.ts";

/**
 * Tiny Word factory. Real predicate words carry `parts` too, but the
 * predicate only ever reads `.value`; omitting the optional `parts`
 * keeps the test concise. Typed as `PredicateWord` — the shape
 * predicates actually receive (`input.args`): `rawText` is the
 * original source token (issue #51), identical to `value` for these
 * static words.
 */
function W(value: string): PredicateWord {
  return { value, text: value, rawText: value, pos: 0, end: value.length };
}

describe("workItemFormat", () => {
  it("matches when the -m value contains the pattern", async () => {
    const fires = await testPredicate(
      workItemFormat,
      { pattern: /\[PROJ-\d+\]/ },
      {
        input: {
          tool: "bash",
          command: 'git commit -m "feat: [PROJ-42] subject"',
          basename: "git",
          args: [W("commit"), W("-m"), W("feat: [PROJ-42] subject")],
        },
        // Explicit-strict git facts (#110 binding symmetry:
        // mocks throw like prod on omitted descriptors + named basename).
        descriptors: { git: {} },
      },
    );
    assert.equal(fires, true);
  });

  it("does NOT match when the -m value lacks the pattern", async () => {
    const fires = await testPredicate(
      workItemFormat,
      { pattern: /\[PROJ-\d+\]/ },
      {
        input: {
          tool: "bash",
          command: 'git commit -m "feat: subject only"',
          basename: "git",
          args: [W("commit"), W("-m"), W("feat: subject only")],
        },
        // Explicit-strict git facts (#110 binding symmetry:
        // mocks throw like prod on omitted descriptors + named basename).
        descriptors: { git: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("supports the --message long form", async () => {
    const fires = await testPredicate(
      workItemFormat,
      { pattern: /\[PROJ-\d+\]/ },
      {
        input: {
          tool: "bash",
          command: 'git commit --message "[PROJ-1] fix"',
          basename: "git",
          args: [W("commit"), W("--message"), W("[PROJ-1] fix")],
        },
        // Explicit-strict git facts (#110 binding symmetry:
        // mocks throw like prod on omitted descriptors + named basename).
        descriptors: { git: {} },
      },
    );
    assert.equal(fires, true);
  });

  it("preserves quote-aware value through -m (no whitespace munging)", async () => {
    // Real-world-ish: a message with internal spaces. The Word's
    // .value gives us the unwrapped literal — we don't have to
    // un-quote ourselves.
    const fires = await testPredicate(
      workItemFormat,
      { pattern: /\[PROJ-\d+\]/ },
      {
        input: {
          tool: "bash",
          command:
            'git commit -m "longer subject with spaces and [PROJ-7] mid-sentence"',
          basename: "git",
          args: [
            W("commit"),
            W("-m"),
            W("longer subject with spaces and [PROJ-7] mid-sentence"),
          ],
        },
        // Explicit-strict git facts (#110 binding symmetry:
        // mocks throw like prod on omitted descriptors + named basename).
        descriptors: { git: {} },
      },
    );
    assert.equal(fires, true);
  });

  it("falls back to command string when no -m flag is found in args", async () => {
    // Rule author wrote a `workItemFormat` predicate on a command
    // whose args don't carry `-m` (e.g. `git commit` with no -m).
    // Fallback matches against `input.command`.
    const fires = await testPredicate(
      workItemFormat,
      { pattern: /\[PROJ-\d+\]/ },
      {
        input: {
          tool: "bash",
          command: "git commit",
          basename: "git",
          args: [W("commit")],
        },
        // Explicit-strict git facts (#110 binding symmetry:
        // mocks throw like prod on omitted descriptors + named basename).
        descriptors: { git: {} },
      },
    );
    // No `-m`, and `"git commit"` has no PROJ token — does not fire.
    assert.equal(fires, false);
  });

  it("returns false when args and command are both absent", async () => {
    const fires = await testPredicate(
      workItemFormat,
      {
        pattern: /\[PROJ-\d+\]/,
      },
      {
        input: { tool: "bash" },
      },
    );
    assert.equal(fires, false);
  });

  it("returns false when the arg shape is malformed", async () => {
    // A rule author who passed a plain string instead of
    // { pattern }. Fail-closed: predicate returns false rather than
    // throwing.
    const fires = await testPredicate(
      workItemFormat,
      // Intentionally wrong shape — widened via `as unknown` so the
      // test isn't a type error (the predicate itself handles bad
      // args defensively).
      "not-an-object" as unknown as { pattern: RegExp },
      {
        input: {
          tool: "bash",
          command: 'git commit -m "[PROJ-1] x"',
          args: [W("commit"), W("-m"), W("[PROJ-1] x")],
        },
        // Explicit-strict git facts (#110 binding symmetry:
        // mocks throw like prod on omitted descriptors + named basename).
        descriptors: { git: {} },
      },
    );
    assert.equal(fires, false);
  });
});
