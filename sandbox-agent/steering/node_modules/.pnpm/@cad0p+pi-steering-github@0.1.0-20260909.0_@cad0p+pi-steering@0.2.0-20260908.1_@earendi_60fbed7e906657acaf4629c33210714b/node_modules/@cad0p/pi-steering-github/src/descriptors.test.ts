// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Value pins for the gh CLI descriptor (`./descriptors.ts`, #61
 * acceptance: "tail finalized …, value-pinned"; consumption
 * completeness: every Fig + `--help` value-taking spelling tabled).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GH_CLI_DESCRIPTOR } from "./descriptors.ts";

describe("github plugin — gh CLI descriptor", () => {
  it("pins the descriptor by value (position policy + full flag table)", () => {
    assert.deepEqual(GH_CLI_DESCRIPTOR, {
      positionPolicy: "globals-anywhere",
      flags: {
        repo: { aliases: ["-R", "--repo"], takesValue: true },
        hostname: { aliases: ["--hostname"], takesValue: true },
        bodyFile: { aliases: ["--body-file", "-F"], takesValue: true },
        body: { aliases: ["--body", "-b"], takesValue: true },
        title: { aliases: ["--title", "-t"], takesValue: true },
        subject: { aliases: ["--subject", "-t"], takesValue: true },
        addReadme: { aliases: ["--add-readme"], takesValue: false },
        gitignore: { aliases: ["--gitignore", "-g"], takesValue: true },
        license: { aliases: ["--license", "-l"], takesValue: true },
        template: { aliases: ["--template", "-p"], takesValue: true },
        help: { aliases: ["-h", "--help"], takesValue: false },
        version: { aliases: ["--version"], takesValue: false },
        assignee: { aliases: ["-a", "--assignee"], takesValue: true },
        blockedBy: { aliases: ["--blocked-by"], takesValue: true },
        blocking: { aliases: ["--blocking"], takesValue: true },
        base: { aliases: ["-B", "--base"], takesValue: true },
        head: { aliases: ["-H", "--head"], takesValue: true },
        label: { aliases: ["-l", "--label"], takesValue: true },
        milestone: { aliases: ["-m", "--milestone"], takesValue: true },
        project: { aliases: ["-p", "--project"], takesValue: true },
        recover: { aliases: ["--recover"], takesValue: true },
        reviewer: { aliases: ["-r", "--reviewer"], takesValue: true },
        addReviewer: { aliases: ["--add-reviewer"], takesValue: true },
        removeReviewer: {
          aliases: ["--remove-reviewer"],
          takesValue: true,
        },
        addAssignee: { aliases: ["--add-assignee"], takesValue: true },
        removeAssignee: {
          aliases: ["--remove-assignee"],
          takesValue: true,
        },
        addLabel: { aliases: ["--add-label"], takesValue: true },
        removeLabel: { aliases: ["--remove-label"], takesValue: true },
        addProject: { aliases: ["--add-project"], takesValue: true },
        removeProject: { aliases: ["--remove-project"], takesValue: true },
        templateT: { aliases: ["-T", "--template"], takesValue: true },
        authorEmail: { aliases: ["-A", "--author-email"], takesValue: true },
        matchHeadCommit: {
          aliases: ["--match-head-commit"],
          takesValue: true,
        },
        description: { aliases: ["-d", "--description"], takesValue: true },
        homepage: { aliases: ["-h", "--homepage"], takesValue: true },
        remote: { aliases: ["-r", "--remote"], takesValue: true },
        source: { aliases: ["-s", "--source"], takesValue: true },
        team: { aliases: ["-t", "--team"], takesValue: true },
        parent: { aliases: ["--parent"], takesValue: true },
        issueType: { aliases: ["--type"], takesValue: true },
        addBlockedBy: { aliases: ["--add-blocked-by"], takesValue: true },
        addBlocking: { aliases: ["--add-blocking"], takesValue: true },
        addSubIssue: { aliases: ["--add-sub-issue"], takesValue: true },
        removeBlockedBy: {
          aliases: ["--remove-blocked-by"],
          takesValue: true,
        },
        removeBlocking: {
          aliases: ["--remove-blocking"],
          takesValue: true,
        },
        removeSubIssue: {
          aliases: ["--remove-sub-issue"],
          takesValue: true,
        },
      },
    });
  });

  it("the table owns every flag entry: exactly the forty-six keys, no sideways consts", () => {
    // Doctrine alignment (core git-descriptor shape): entries live
    // INLINE in the table — there are no standalone exported
    // `GH_*_FLAG` consts for the table and the rules to drift apart.
    // Consumers read `GH_CLI_DESCRIPTOR.flags.<key>` (or a
    // destructured `ghFlags` alias). This pin guards the key set; the
    // value pin above guards every aliases/takesValue row.
    assert.deepEqual(Object.keys(GH_CLI_DESCRIPTOR.flags).sort(), [
      "addAssignee",
      "addBlockedBy",
      "addBlocking",
      "addLabel",
      "addProject",
      "addReadme",
      "addReviewer",
      "addSubIssue",
      "assignee",
      "authorEmail",
      "base",
      "blockedBy",
      "blocking",
      "body",
      "bodyFile",
      "description",
      "gitignore",
      "head",
      "help",
      "homepage",
      "hostname",
      "issueType",
      "label",
      "license",
      "matchHeadCommit",
      "milestone",
      "parent",
      "project",
      "recover",
      "remote",
      "removeAssignee",
      "removeBlockedBy",
      "removeBlocking",
      "removeLabel",
      "removeProject",
      "removeReviewer",
      "removeSubIssue",
      "repo",
      "reviewer",
      "source",
      "subject",
      "team",
      "template",
      "templateT",
      "title",
      "version",
    ]);
  });
});
