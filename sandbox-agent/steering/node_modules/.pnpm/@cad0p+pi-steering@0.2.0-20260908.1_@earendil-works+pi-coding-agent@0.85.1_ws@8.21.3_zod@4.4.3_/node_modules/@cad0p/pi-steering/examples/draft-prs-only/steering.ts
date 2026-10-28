// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: draft-prs-only rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * v0.1.0 canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * What it enforces: `gh pr create` must include `--draft`. Useful on
 * teams that require a human review step before flipping a PR from
 * draft to ready.
 *
 * Scope note: the rule is additive. Since issue #72 nothing is
 * engine-injected — the rm declaration below restores the classic
 * filesystem rail; drop it if you want THIS PACK ONLY. The git plugin
 * isn't declared here, so its rules stay inert.
 *
 * gh facts: the real `gh` CLI table is owned by pi-steering-github#61
 * (not landed). Until then this pack declares a minimal synthetic
 * `gh` table (`draft`, plus `repo` so `gh -R <repo> pr create` keeps
 * its subcommand routed) — both entries are real `gh` flags. Swap in
 * the owning plugin when it lands.
 */

import { defineConfig, type Plugin } from "@cad0p/pi-steering";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";

/**
 * Minimal synthetic `gh` facts (placeholder for pi-steering-github#61).
 *
 * One declaration, two uses: the `ghFlags` table feeds
 * `cliDescriptors` below AND the `flag:` leaf references its entry by
 * variable (never hand-built literals in rules).
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
  plugins: [rmPlugin, ghFacts],
  rules: [
    {
      name: "pr-create-must-be-draft",
      tool: "bash",
      command: "gh",
      // `subcommand: ["pr", "create"]` routes
      // the two-token subcommand; `not: { flag: ... }` inverts the
      // `--draft` presence check ("block UNLESS --draft is present").
      // The old `unless: "--draft\\b"` string hack migrates to this
      // `not: { flag: }` form (the `requires:` / `unless:` Pattern
      // restriction follows the gh table; see the README).
      when: {
        subcommand: ["pr", "create"],
        not: {
          flag: { anyOf: [ghFlags.draft] },
        },
      },
      reason:
        "PRs must be created as drafts. Mark the PR ready for review only after a human has reviewed the diff. Use `gh pr ready <number>` to flip from draft to ready.",
    },
  ],
});
