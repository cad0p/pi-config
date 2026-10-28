// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `pr-create-needs-issue-link` — a PR may not be opened without at
 * least one attached issue: a closing keyword + `#N` in BOTH the
 * inline `--title` value and the body (stripped vault body-file
 * content, with inline `--body` as a fallback). Fires when EITHER is missing
 * (`when.condition` is an OR — the `subcommand:` leaf only routes the command).
 *
 * Does NOT fire on other gh subcommands. Fires on draft PRs without
 * keywords too (a tracking issue is the allowed pattern while a draft
 * is open). Routes on `command: "gh"` + the create/new sequences —
 * a gate-released flag-first create lands here instead of bypassing
 * the issue-link policy. Strict — no override (schema default).
 */

import type { Rule } from "@cad0p/pi-steering";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
import { bodyHasClosingKeyword } from "../helpers/body-keyword.ts";
import { ISSUE_REF } from "../helpers/patterns.ts";

/** Table-owned gh flag entries, referenced by variable (never re-spelled). */
const { flags: ghFlags } = GH_CLI_DESCRIPTOR;

export const prCreateNeedsIssueLink = {
  name: "pr-create-needs-issue-link",
  tool: "bash",
  command: "gh",
  when: {
    subcommand: {
      anyOf: [
        ["pr", "create"],
        ["pr", "new"],
      ],
      onUnknown: "allow",
    },
    condition: async (ctx) => {
      // Last-wins across the --title/-t aliases (gh/cobra collapse
      // repeated spellings to the final value) via the bound facade.
      const title = ctx.command.getFlagValue(ghFlags.title);
      const titleOk = title !== null && new RegExp(ISSUE_REF, "i").test(title);
      return !titleOk || !(await bodyHasClosingKeyword(ctx));
    },
  },
  reason:
    `A PR must close at least one issue — put the closing keyword in BOTH the ` +
    `title and body:\n` +
    `  e.g: title: "feat: x (closes #12)"; body: contains "Closes #12"\n` +
    `- Title keyword: makes the issue(s) auto-close.\n` +
    `- Body keyword: only links the issue(s) to the PR on a Title-Only squash merge.\n` +
    `- Multiple issues: repeat the keyword per issue — "Closes #A, closes #B" — ` +
    `"Closes #A #B" honors only the first number.`,
} as const satisfies Rule;
