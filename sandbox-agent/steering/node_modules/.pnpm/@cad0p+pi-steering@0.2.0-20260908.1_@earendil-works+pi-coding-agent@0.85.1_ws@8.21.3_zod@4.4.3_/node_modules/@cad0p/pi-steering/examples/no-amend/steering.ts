// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: no-amend rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * v0.1.0 canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * What it enforces: blocks `git commit --amend` in any form. Useful
 * on review-driven workflows where commit-SHA stability matters (an
 * amend rewrites the SHA, which breaks reviewers' cross-push diff
 * tracking).
 *
 * Scope note: the rule is additive and independent of the git plugin's
 * rails (plain routing + leaves, no predicates) — but it still
 * DECLARES the git plugin, because routing to `git` requires git's
 * CLI facts (the descriptor table the `subcommand:` / `flag:` leaves
 * resolve against). Declaring it also activates the git rails
 * (`no-force-push`, `no-hard-reset`, commit-on-main); the rm
 * declaration below restores the classic filesystem rail; drop either
 * if you want THIS RULE ONLY (and route nowhere else).
 */

import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin, { GIT_CLI_DESCRIPTOR } from "@cad0p/pi-steering/plugins/git";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";

export default defineConfig({
  plugins: [gitPlugin, rmPlugin],
  rules: [
    {
      name: "no-amend",
      tool: "bash",
      command: "git",
      // `subcommand: "commit"` routes the commit slot (the git
      // descriptor's consuming-flag arity keeps `git -C /path commit
      // --amend`, `git -c key=val commit --amend`, and
      // `git --git-dir=/x commit --amend` routed); `--amend` is
      // `--help`-pinned (`git commit -h`).
      when: {
        subcommand: "commit",
        // `--amend` referenced BY VARIABLE from the owning plugin's
        // table (never a hand-built literal in the rule).
        flag: { anyOf: [GIT_CLI_DESCRIPTOR.flags.amend] },
      },
      reason:
        "Don't rewrite history with --amend. Create a new commit instead. If you need to fix the last commit's message, do it in a follow-up commit — PR reviewers track diffs across pushes and amend confuses that.",
    },
  ],
});
