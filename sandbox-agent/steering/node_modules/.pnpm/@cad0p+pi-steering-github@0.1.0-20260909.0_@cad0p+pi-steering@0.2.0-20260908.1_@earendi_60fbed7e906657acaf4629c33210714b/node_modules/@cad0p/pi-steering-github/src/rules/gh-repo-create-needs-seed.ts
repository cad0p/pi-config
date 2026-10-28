// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `gh-repo-create-needs-seed` — `gh repo create|new` must carry a
 * seed flag (`--add-readme`, `--gitignore|-g`, `--license|-l`,
 * `--template|-p`, long or short form, ` ` or `=` value form). A
 * bare create births an EMPTY repo (zero branches, zero commits):
 * `main` can only be born by pushing past the `no-main-commit`
 * gates — the steering-override dance and UNREVIEWED first content.
 * The seeded flow sends the whole bootstrap through the normal
 * pipeline (fetch → feature branch → commit → push → PR → squash
 * merge); the seed commit is the PR's base, so the PR diff replaces
 * it and the first content is reviewed.
 *
 * Command-first edition (core #117): `command: "gh"` routes, the
 * `subcommand:` sequences scope to `repo create|new` in ANY
 * leading-flag position (the descriptor's consuming-flag arity keeps
 * `gh -v --hostname h repo create foo` gated), and the seed
 * exemption is the declarative `not.flag` leaf over the descriptor's
 * seed entries — the old front negative-lookahead
 * (`REPO_CREATE_PATTERN`) is gone. The leaf is token-level and
 * quote-aware, which FIXES the old accepted false-exemption: a
 * seed-looking token inside a QUOTED flag value (e.g.
 * `--description "see --license mit"`) no longer exempts — the value
 * is one non-flag word, not a flag. Glued lookalikes
 * (`foo--add-readme`) still never match (no leading dash).
 * Accepted twin delta (pflag-faithful glue, see the descriptor
 * header): `-local` / `-public` now read as `-l` / `-p` and exempt —
 * gh rejects both lines at runtime (junk seed values), so nothing
 * real executes.
 *
 * The rule is a form check (like the body-file rules); gh's own flag
 * validation governs seed/`--source` combos at runtime.
 *
 * Strict — no override (schema default).
 */

import type { Rule } from "@cad0p/pi-steering";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";

export const ghRepoCreateNeedsSeed = {
  name: "gh-repo-create-needs-seed",
  tool: "bash",
  command: "gh",
  when: {
    subcommand: {
      anyOf: [
        ["repo", "create"],
        ["repo", "new"],
      ],
      onUnknown: "allow",
    },
    not: {
      flag: {
        // Seed entries referenced BY VARIABLE from the owning table
        // (core git-descriptor shape — never a hand-built literal in
        // the rule; a duplicated literal can skew from the table into
        // silent fail-open).
        anyOf: [
          GH_CLI_DESCRIPTOR.flags.addReadme,
          GH_CLI_DESCRIPTOR.flags.gitignore,
          GH_CLI_DESCRIPTOR.flags.license,
          GH_CLI_DESCRIPTOR.flags.template,
        ],
      },
    },
  },
  reason:
    "gh repo create must seed the repo — a bare create births an EMPTY repo (no branches, no commits), " +
    "forcing UNREVIEWED first content. Use seed flags and seek explicit user approval for PR merge.\n" +
    "  gh repo create cad0p/<name> --add-readme\n" +
    "- Seed flags: --add-readme (recommended), --license <x>, --gitignore <x>, --template <repo>.\n" +
    "- The seed commit is the PR's base — the PR diff replaces the README.",
} as const satisfies Rule;
