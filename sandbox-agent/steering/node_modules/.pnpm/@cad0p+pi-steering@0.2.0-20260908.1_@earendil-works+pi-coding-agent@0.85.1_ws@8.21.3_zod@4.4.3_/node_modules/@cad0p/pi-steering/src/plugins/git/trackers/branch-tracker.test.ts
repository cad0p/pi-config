// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's branch tracker (`./branch-tracker.ts`).
 *
 * These tests exercise the tracker directly via `walk()` from
 * unbash-walker, with small hand-crafted bash scripts. They pin the
 * modifier's semantics independently of the evaluator / predicate
 * wiring. Evaluator-level behaviour is covered by `./integration.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CommandRef,
  extractAllCommandsFromAST,
  getBasename,
  getCommandArgs,
  parse as parseBash,
  walk,
} from "@cad0p/unbash-walker";
import { branchTracker } from "./branch-tracker.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface WalkedCommand {
  ref: CommandRef;
  text: string;
  branch: string;
}

/**
 * Walk `script` with only the branch tracker and return one entry per
 * extracted command ref with its stringified form and snapshot branch.
 *
 * `initialBranch` seeds the tracker's starting value so tests can pin
 * both "checkout advances" and "other subcommands preserve" shapes.
 */
function walkBranches(script: string, initialBranch: string): WalkedCommand[] {
  const ast = parseBash(script);
  const refs = extractAllCommandsFromAST(ast, script);
  const result = walk(
    ast,
    { branch: initialBranch },
    { branch: branchTracker },
    refs,
  );
  return refs.map((ref) => {
    const snap = result.get(ref);
    return {
      ref,
      text: `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim(),
      branch: (snap?.branch as string | undefined) ?? "<missing>",
    };
  });
}

/** Find the recorded branch for the first command whose text starts with `prefix`. */
function branchOf(walked: WalkedCommand[], prefix: string): string {
  const hit = walked.find((w) => w.text.startsWith(prefix));
  if (!hit) {
    throw new Error(
      `no command starting with "${prefix}" in walked set: ` +
        walked.map((w) => w.text).join(" | "),
    );
  }
  return hit.branch;
}

// ---------------------------------------------------------------------------
// Sequential subcommand advancement
// ---------------------------------------------------------------------------

describe("branchTracker: checkout / switch advance the branch", () => {
  it("`git checkout feat` advances to feat for subsequent commands", () => {
    const walked = walkBranches("git checkout feat && git status", "main");
    // The checkout ITSELF is recorded with the pre-checkout branch -
    // same convention as cd in cwdTracker: a sequential modifier's
    // effect only propagates to SUBSEQUENT siblings.
    assert.equal(branchOf(walked, "git checkout"), "main");
    assert.equal(branchOf(walked, "git status"), "feat");
  });

  it("`git switch main` advances to main", () => {
    const walked = walkBranches("git switch main && git status", "feat");
    assert.equal(branchOf(walked, "git status"), "main");
  });

  it("`git checkout -b new-branch` advances to new-branch", () => {
    const walked = walkBranches(
      "git checkout -b new-branch && git push",
      "main",
    );
    assert.equal(branchOf(walked, "git push"), "new-branch");
  });

  it("`git switch -c other-branch` advances to other-branch", () => {
    const walked = walkBranches(
      "git switch -c other-branch && git commit",
      "main",
    );
    assert.equal(branchOf(walked, "git commit"), "other-branch");
  });

  it("chained checkouts - final state wins", () => {
    const walked = walkBranches(
      "git checkout A && git checkout B && git status",
      "main",
    );
    assert.equal(branchOf(walked, "git status"), "B");
  });
});

// ---------------------------------------------------------------------------
// Non-advancing subcommands
// ---------------------------------------------------------------------------

describe("branchTracker: non-checkout subcommands preserve branch", () => {
  it("`git commit` does not change the branch", () => {
    const walked = walkBranches(
      "git status && git commit -m 'x' && git log",
      "feat",
    );
    assert.equal(branchOf(walked, "git status"), "feat");
    assert.equal(branchOf(walked, "git commit"), "feat");
    assert.equal(branchOf(walked, "git log"), "feat");
  });

  it("`git` with no subcommand does not change the branch", () => {
    const walked = walkBranches("git && git commit", "feat");
    assert.equal(branchOf(walked, "git commit"), "feat");
  });

  it('`git commit -m "$MSG"` (non-static args) does not collapse to unknown', () => {
    // Regression guard: the modifier must return `current` (not
    // `undefined`) when the subcommand isn't a branch change. A
    // naive `isStaticallyResolvable(args[1])` check on `-m` would
    // work, but a non-static later arg must not poison the state.
    const walked = walkBranches('git commit -m "$MSG" && git push', "feat");
    assert.equal(branchOf(walked, "git push"), "feat");
  });
});

// ---------------------------------------------------------------------------
// Unknown collapse on dynamic targets
// ---------------------------------------------------------------------------

describe("branchTracker: non-static targets collapse to unknown", () => {
  it("`git checkout $VAR` produces unknown for subsequent commands", () => {
    const walked = walkBranches("git checkout $VAR && git status", "main");
    assert.equal(branchOf(walked, "git status"), "unknown");
  });

  it("`git checkout -b $NEW` produces unknown", () => {
    const walked = walkBranches("git checkout -b $NEW && git status", "main");
    assert.equal(branchOf(walked, "git status"), "unknown");
  });

  it('`git switch "$BR"` (double-quoted with expansion) produces unknown', () => {
    const walked = walkBranches('git switch "$BR" && git log', "main");
    assert.equal(branchOf(walked, "git log"), "unknown");
  });
});

// ---------------------------------------------------------------------------
// Subshell isolation
// ---------------------------------------------------------------------------

describe("branchTracker: subshell isolation", () => {
  it("`(git checkout A)` does not escape the subshell", () => {
    const walked = walkBranches("(git checkout A) && git status", "main");
    // `git status` runs after the subshell in the OUTER scope - branch
    // should still be the pre-subshell value.
    assert.equal(branchOf(walked, "git status"), "main");
  });

  it("subshell body sees the outer branch value", () => {
    const walked = walkBranches(
      "git checkout feat && (git log && git status)",
      "main",
    );
    // Both commands inside the subshell see `feat` (the propagated
    // outer value at the point the subshell starts).
    assert.equal(branchOf(walked, "git log"), "feat");
    assert.equal(branchOf(walked, "git status"), "feat");
  });
});

// ---------------------------------------------------------------------------
// Pre-subcommand flags
// ---------------------------------------------------------------------------

describe("branchTracker: pre-subcommand flags", () => {
  it("`git -C /other checkout feat && git commit` advances branch to feat", () => {
    const walked = walkBranches(
      "git -C /other checkout feat && git commit -m 'x'",
      "main",
    );
    assert.equal(branchOf(walked, "git commit"), "feat");
  });

  it("`git -c key=val checkout feat` advances (-c consumes next arg)", () => {
    const walked = walkBranches(
      "git -c color.ui=never checkout feat && git commit",
      "main",
    );
    assert.equal(branchOf(walked, "git commit"), "feat");
  });

  it("`git --no-pager checkout feat` advances (long flag without value)", () => {
    const walked = walkBranches(
      "git --no-pager checkout feat && git commit",
      "main",
    );
    assert.equal(branchOf(walked, "git commit"), "feat");
  });

  it("`git --git-dir=/g checkout feat` advances (long flag with =value)", () => {
    const walked = walkBranches(
      "git --git-dir=/g checkout feat && git commit",
      "main",
    );
    assert.equal(branchOf(walked, "git commit"), "feat");
  });

  it("`git -C /other checkout -b new-branch` advances via -b path", () => {
    const walked = walkBranches(
      "git -C /other checkout -b new-branch && git commit",
      "main",
    );
    assert.equal(branchOf(walked, "git commit"), "new-branch");
  });
});

// ---------------------------------------------------------------------------
// Pathological cases (documented corners)
// ---------------------------------------------------------------------------

describe("branchTracker: pathological cases (documented corners)", () => {
  it("`git checkout --help` leaves branch unchanged", () => {
    const walked = walkBranches("git checkout --help && git status", "main");
    assert.equal(branchOf(walked, "git status"), "main");
  });

  it("`git checkout .` sets branch to `.` (documented false-positive - path reset)", () => {
    // Real git interprets `.` as "reset path", not a branch. Our tracker
    // treats the first static arg after checkout as the branch name,
    // which is wrong in this corner. Documented accepted false-positive.
    const walked = walkBranches("git checkout . && git status", "main");
    assert.equal(branchOf(walked, "git status"), ".");
  });

  it("`git checkout -- file.txt` sets branch to `--` (documented false-positive)", () => {
    const walked = walkBranches(
      "git checkout -- file.txt && git status",
      "main",
    );
    assert.equal(branchOf(walked, "git status"), "--");
  });
});

// ---------------------------------------------------------------------------
// Motivating case: `git checkout A && git commit`
// ---------------------------------------------------------------------------

describe("branchTracker: the ADR's motivating case", () => {
  it("`git checkout main && git commit` reports branch=main on the commit", () => {
    // This is the KEY test. A session-level "current branch" check
    // would see the PRE-checkout branch and miss this case. The
    // walker-backed tracker folds the checkout into the commit's
    // branch snapshot, so a `when.branch: /^main$/` predicate fires.
    const walked = walkBranches(
      "git checkout main && git commit -m 'x'",
      "feat",
    );
    assert.equal(branchOf(walked, "git commit"), "main");
  });
});
