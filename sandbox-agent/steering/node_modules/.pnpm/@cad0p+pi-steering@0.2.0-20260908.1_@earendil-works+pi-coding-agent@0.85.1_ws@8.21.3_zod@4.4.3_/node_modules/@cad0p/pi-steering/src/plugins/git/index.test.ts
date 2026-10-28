// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `rules` array (`./index.ts`).
 *
 * Load-bearing array-level pins:
 *
 *   - Ship-surface count lock: EXACTLY FOUR rules — the two
 *     commit-on-main rules plus the two rails migrated from the
 *     engine's former default-rule bundle (issue #72). Any addition or
 *     removal is a deliberate ship-surface change and must update the
 *     assertion explicitly.
 *   - First-match-wins ordering. The github-specific rule
 *     (`no-main-commit-github`) must appear BEFORE the generic
 *     (`no-main-commit`) in the plugin's rule array — on a github
 *     clone + on main, BOTH rules' `when:` clauses match and
 *     first-match-wins routes the github-flavored guidance to github
 *     users. Reordering for stylistic reasons silently regresses the
 *     user-facing message; this test makes that regression visible.
 *
 * (Per-rule shape / behavior pins live in `./rules/*.test.ts`.)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePlugins } from "../../plugin-merger.ts";
import type { Rule } from "../../schema.ts";
import gitPlugin from "./index.ts";

// Widen once for shape-invariant iteration (optional fields visible).
const RULES_AS_RULE: readonly Rule[] = gitPlugin.rules ?? [];

describe("git plugin: ship surface (count lock, issue #72)", () => {
  it("ships exactly four rules (count lock)", () => {
    // Two commit-on-main rules + no-force-push + no-hard-reset (the
    // rails migrated out of the engine's defaults). Locking the count
    // keeps additions/removals deliberate, reviewed edits.
    assert.equal(gitPlugin.rules?.length, 4);
  });

  it("ships the migrated destructive-command rails by name", () => {
    const names = RULES_AS_RULE.map((r) => r.name);
    for (const expected of [
      "no-main-commit",
      "no-main-commit-github",
      "no-force-push",
      "no-hard-reset",
    ]) {
      assert.ok(
        names.includes(expected),
        `expected "${expected}" in shipped rules; got: ${names.join(", ")}`,
      );
    }
  });
});

describe('git plugin: disabledPlugins: ["git"] opts out of every surface', () => {
  it("removes no-main-commit rule, branch predicate, and cwd.git tracker extension", () => {
    // Ported from the former defaults.test.ts fence (issue #72): drive
    // resolvePlugins over the REAL plugin with disabledPlugins set and
    // assert every registered surface is absent — a regression that
    // merged the plugin in through a second code path would escape a
    // synthetic-plugin test entirely.
    const resolved = resolvePlugins([gitPlugin], {
      disabledPlugins: ["git"],
    });

    // Rule surface: none of the four shipped rules may appear.
    const ruleNames = resolved.rules.map((r) => r.name);
    for (const name of RULES_AS_RULE.map((r) => r.name)) {
      assert.ok(
        !ruleNames.includes(name),
        `${name} leaked past disabledPlugins: ["git"]; rules: ${ruleNames.join(", ")}`,
      );
    }

    // Predicate surface: `branch` (canonical git predicate) must not
    // be registered. Spot-checking one predicate is enough — if the
    // plugin's predicate bundle was registered at all, `branch` would
    // be present.
    assert.ok(
      !("branch" in resolved.predicates),
      'branch predicate leaked past disabledPlugins: ["git"]',
    );

    // Tracker-extension surface: `cwd.git` (the --git-dir / --work-tree
    // parser layered on the core cwd tracker) must not be registered.
    const cwdExts = resolved.trackerModifiers["cwd"];
    assert.ok(
      cwdExts === undefined || !("git" in cwdExts),
      'cwd.git tracker extension leaked past disabledPlugins: ["git"]',
    );

    // Plugin-merger surfaces a `console.info` breadcrumb for every
    // opted-out plugin; spot-check that it fires here too.
    const origInfo = console.info;
    const infos: string[] = [];
    console.info = (msg: unknown) => {
      infos.push(String(msg));
    };
    try {
      resolvePlugins([gitPlugin], { disabledPlugins: ["git"] });
    } finally {
      console.info = origInfo;
    }
    assert.ok(
      infos.some(
        (m) =>
          m.includes("[pi-steering]") &&
          m.includes('plugin "git"') &&
          m.includes("disabled via config.disabledPlugins"),
      ),
      `expected a console.info breadcrumb for the disabled git plugin; got: ${JSON.stringify(infos)}`,
    );
  });
});

describe("rules: array order (first-match-wins)", () => {
  it("first-match-wins ordering: github rule appears BEFORE no-main-commit in the plugin's rule array", () => {
    // Load-bearing ordering. On a github clone + on main, BOTH rules'
    // `when:` clauses match — first-match-wins routes the github-
    // flavored guidance to github users. Reordering for stylistic
    // reasons (alphabetical, etc.) silently regresses user-facing
    // behavior; this assertion makes that regression visible.
    const rules = gitPlugin.rules ?? [];
    const githubIdx = rules.findIndex(
      (r) => r.name === "no-main-commit-github",
    );
    const genericIdx = rules.findIndex((r) => r.name === "no-main-commit");
    assert.notEqual(githubIdx, -1, "no-main-commit-github must be registered");
    assert.notEqual(genericIdx, -1, "no-main-commit must be registered");
    assert.ok(
      githubIdx < genericIdx,
      `expected no-main-commit-github (idx ${githubIdx}) BEFORE no-main-commit (idx ${genericIdx})`,
    );
  });
});
