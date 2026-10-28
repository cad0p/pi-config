// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Roster-order pin + reason-string byte-identity pins for the rules
 * roster (assembled in `./index.ts`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateContext } from "@cad0p/pi-steering";
import { BODY_STRIP } from "./helpers/body-strip.ts";
import {
  ghRepoCreateNeedsSeed,
  issueBodyFromVaultFile,
  prBodyFromVaultFile,
  prCreateNeedsIssueLink,
  prMergeNeedsClosingKeywords,
  rules,
} from "./index.ts";

describe("github plugin — pattern constants", () => {
  it("rules array ships in roster order (first-match-wins routing)", () => {
    assert.deepEqual(
      rules.map((r) => r.name),
      [
        "gh-repo-flag-before-subcommand",
        "pr-body-from-vault-file",
        "pr-create-needs-issue-link",
        "pr-merge-needs-closing-keywords",
        "issue-body-from-vault-file",
        "gh-repo-create-needs-seed",
      ],
    );
  });
});

describe("github plugin — reason strings (byte-identity pins)", () => {
  // The keyword-rule reason strings are byte-identical to the live
  // global-config prototype (verified at ship time 2026-08-14 by an
  // independent reviewer comparing both modules field-by-field); the
  // two body-file rules were reworded in the pinned-perl work (issue
  // #3) to teach the pinned perl body-strip substitution. Agents in
  // the wild receive these verbatim in block reasons, and the global
  // config's integration tests match rule NAMES only — so these
  // literals are the only CI pin keeping the full reason text from
  // drifting. A future reword MUST update this test in the same
  // commit (and ideally the goldmine changelog note). Since #43 the
  // two body-file rules' reason is a ReasonFn — the pins below call
  // it on the missing stage (empty args), which returns the static
  // recipe byte-for-byte; the dynamic diagnostic stages are pinned
  // by pattern-args.test.ts + integration.test.ts.
  it("pr-body-from-vault-file reason (dynamic — missing stage returns the static recipe byte-for-byte)", async () => {
    // reason is now an async ReasonFn (dynamic mirror+trace diagnostic,
    // #50). Invoked with a minimal empty-args ctx: findBodyFileValue →
    // "" → missing stage → the static recipe, byte-for-byte, no throw
    // (the chain is fs/exec-free on the static path).
    const reason = await prBodyFromVaultFile.reason({
      input: { args: [] },
    } as unknown as PredicateContext);
    assert.equal(
      reason,
      "PR bodies must come from a body file in the napkin vault:\n" +
        '  gh pr create --title "..." --body-file ' +
        `<(perl -0777 -pe '${BODY_STRIP}' ` +
        "VAULT/**/REPO/prs/YYYY-MM-DD-pr<N>-<slug>.md)",
    );
  });

  it("pr-create-needs-issue-link reason", () => {
    assert.equal(
      prCreateNeedsIssueLink.reason,
      "A PR must close at least one issue — put the closing keyword in BOTH the " +
        "title and body:\n" +
        '  e.g: title: "feat: x (closes #12)"; body: contains "Closes #12"\n' +
        "- Title keyword: makes the issue(s) auto-close.\n" +
        "- Body keyword: only links the issue(s) to the PR on a Title-Only squash merge.\n" +
        '- Multiple issues: repeat the keyword per issue — "Closes #A, closes #B" — ' +
        '"Closes #A #B" honors only the first number.',
    );
  });

  it("pr-merge-needs-closing-keywords reason", () => {
    assert.equal(
      prMergeNeedsClosingKeywords.reason,
      "Merging requires a closing keyword in the squash commit subject " +
        "— every PR must close at least one issue:\n" +
        '  gh pr merge --squash --subject "feat: x (closes #12)"\n' +
        '- Repeat the keyword per issue — "Closes #A #B" honors only the first number.\n',
    );
  });

  it("issue-body-from-vault-file reason (dynamic — missing stage returns the static recipe byte-for-byte)", async () => {
    // Same async-ReasonFn invocation pin as the PR twin (missing stage).
    const reason = await issueBodyFromVaultFile.reason({
      input: { args: [] },
    } as unknown as PredicateContext);
    assert.equal(
      reason,
      "Issue bodies must come from a body file in the napkin vault:\n" +
        '  gh issue create --title "..." --body-file ' +
        `<(perl -0777 -pe '${BODY_STRIP}' ` +
        "VAULT/**/REPO/issues/YYYY-MM-DD-issue<N>-<slug>.md)\n" +
        "- If foreign issue: cd to the repo you want to file the issue; " +
        "REQUIREMENT: have a foreign subagent maintainer loop before filing",
    );
  });

  it("gh-repo-create-needs-seed reason", () => {
    assert.equal(
      ghRepoCreateNeedsSeed.reason,
      "gh repo create must seed the repo — a bare create births an EMPTY repo (no branches, no commits), " +
        "forcing UNREVIEWED first content. Use seed flags and seek explicit user approval for PR merge.\n" +
        "  gh repo create cad0p/<name> --add-readme\n" +
        "- Seed flags: --add-readme (recommended), --license <x>, --gitignore <x>, --template <repo>.\n" +
        "- The seed commit is the PR's base — the PR diff replaces the README.",
    );
  });
});
