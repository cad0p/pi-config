// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: combined-git-discipline rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * Stacks two guardrails on top of the declared domain plugins:
 *
 *   1. `no-amend` - no `git commit --amend` (rewrites history).
 *   2. `pr-create-must-be-draft` - `gh pr create` must include
 *       `--draft`.
 *
 * Since issue #72 nothing is engine-injected: this config DECLARES
 * git + rm to get the classic rails (plus minimal synthetic `gh`
 * facts — the real `gh` table is owned by pi-steering-github#61).
 * Force pushes need NO extra rule here: since issue #65 the git
 * plugin's `no-force-push` rule is sealed — it already blocks every
 * remote-history-rewrite form (`--force`, `--force-with-lease`,
 * bundled shorts like `-uf`, leading-`+` refspecs, `--mirror`). Older
 * copies of this pack disabled that rule and re-added a stricter
 * variant; that disable-and-replace step is redundant (and would
 * actually WEAKEN coverage — see ../force-push-strict for the idiom if
 * you genuinely want to swap the shipped rule out).
 *
 * Use this as a starting point for teams that want "disciplined PR
 * flow" out of the box. Tweak individual routing + leaves downstream.
 *
 * Scope note: the other shipped rails (no-hard-reset via git,
 * no-rm-rf-slash via rm) are active because their plugins are
 * declared explicitly below.
 */

import { defineConfig, type Plugin } from "@cad0p/pi-steering";
import gitPlugin, { GIT_CLI_DESCRIPTOR } from "@cad0p/pi-steering/plugins/git";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";

/**
 * Minimal synthetic `gh` facts (placeholder for pi-steering-github#61).
 * See ../draft-prs-only/steering.ts for the entry rationale.
 *
 * One declaration, two uses: the `ghFlags` table feeds
 * `cliDescriptors` below AND the `flag:` leaves reference its entries
 * by variable (never hand-built literals in rules).
 */
const ghFlags = {
  draft: { aliases: ["--draft"], takesValue: false },
  repo: { aliases: ["-R", "--repo"], takesValue: true },
} as const;

const ghFacts = {
  name: "gh-facts",
  cliDescriptors: {
    gh: {
      flags: ghFlags,
    },
  },
} as const satisfies Plugin;

export default defineConfig({
  // Post-#72 there are no implicit rails: declare every domain plugin
  // whose rules you want active (plus the facts your rules route to).
  plugins: [gitPlugin, rmPlugin, ghFacts],
  rules: [
    {
      name: "no-amend",
      tool: "bash",
      command: "git",
      when: {
        subcommand: "commit",
        flag: { anyOf: [GIT_CLI_DESCRIPTOR.flags.amend] },
      },
      reason:
        "Don't rewrite history with --amend. Create a new commit instead.",
    },
    {
      name: "pr-create-must-be-draft",
      tool: "bash",
      command: "gh",
      when: {
        subcommand: ["pr", "create"],
        not: {
          flag: { anyOf: [ghFlags.draft] },
        },
      },
      reason:
        "PRs must be created as drafts. Mark ready for review only after human approval.",
    },
  ],
});
