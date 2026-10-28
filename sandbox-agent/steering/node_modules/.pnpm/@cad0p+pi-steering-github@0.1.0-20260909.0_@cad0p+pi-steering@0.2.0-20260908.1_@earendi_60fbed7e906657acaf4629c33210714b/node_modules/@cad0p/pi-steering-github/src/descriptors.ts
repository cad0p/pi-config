// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * GitHub plugin-owned CLI descriptor (closes #61; exemplar:
 * pi-steering's `src/plugins/git/descriptors.ts`).
 *
 * Per-binary argv knowledge for the `gh` basename, declared via this
 * plugin's own `cliDescriptors` slot and referenced by name (never
 * inlined) in the plugin literal so hover rides on the const. Core
 * seeds nothing (`CORE_CLI_DESCRIPTORS` is empty); without this entry
 * every `command: "gh"` rule throws `MissingDescriptorError` (loud
 * block naming the missing facts).
 *
 * source: @withfig/autocomplete@2.692.3 src/gh.ts, retrieved 2026-09-07
 * (via the pi-steering#110 draft, owned here per owner decision —
 * pi-steering#110 removed its draft instead of shipping it);
 * refetched master 2026-09-09 (`curl
 * https://raw.githubusercontent.com/withfig/autocomplete/master/src/gh.ts`):
 * byte-identical to the vendored copy, `npm view` latest is 2.692.3 —
 * the seed is current. Reviewed vs real CLI output (gh version 2.96.0)
 * via read-only `gh help <sub> <verb>` forms only (avoids local
 * steering interception; NEVER bare `gh pr create|edit` — help forms
 * only). `gh --help` FLAGS names only `--help` / `--version` (both
 * boolean). Per-entry takesValue reviewed against `--help` arity text;
 * Fig `args` presence was the draft signal, `--help` was the verdict.
 * Covered subcommands (the rules' `subcommand:` sets): `pr
 * create|new|edit|merge`, `issue create|new|edit`, `repo create|new`
 * (+ globals). Consumption completeness, not query completeness:
 * EVERY value-taking spelling for covered subcommands is tabled below
 * whether or not any rule queries it — an incomplete tail
 * under-extracts flag-first forms the way the pre-#41 anchors
 * under-blocked them; an over-long tail over-consumes the other way
 * (#61).
 *
 * Review trace (Fig draft → `--help` verdict, gh 2.96.0):
 * - `-R/--repo [HOST/]OWNER/REPO`: Fig args + inherited FLAGS agree →
 *   takesValue:true. The global repo selector — the foreign-target gate
 *   and every flag-first extraction rest on it.
 * - `--hostname`: NOT in any `gh help` (legacy/compat) — kept from the
 *   deleted core minimum (`valueConsumingFlags: ["-R", "--repo",
 *   "--hostname"]`, see #61) so `gh --hostname h pr …` keeps extracting
 *   instead of reading `h` as the subcommand. Carrying it errors at
 *   runtime; the row only affects such invalid lines.
 * - `--help`/`--version`: Fig no-args + `gh --help` agree →
 *   takesValue:false. `-h` rides on the help entry (gh/github
 *   convention; the rules' `infoOnly` carve-out names the same `-h` —
 *   see the `-h` COLLISION ALARM below).
 * - Rule-queried values (existing): `-F/--body-file`, `-b/--body`,
 *   `-t/--title` (`pr|issue create|edit`), `--subject`+`-t` (`pr merge`
 *   subject; `-t` shared — all value, no arity alarm), seed
 *   `--add-readme` (bool) + `--gitignore`/`-g`, `--license`/`-l`,
 *   `--template`/`-p` (`gh repo create --help`).
 * - Fig value-taking spellings, all confirmed value-taking in
 *   `--help` → takesValue:true: `-a/--assignee`, `-B/--base`,
 *   `-H/--head`, `-l/--label`, `-m/--milestone`, `-p/--project`,
 *   `--recover`, `-r/--reviewer`, `--add-assignee`, `--add-label`,
 *   `--add-project`, `--add-reviewer`, `--remove-assignee`,
 *   `--remove-label`, `--remove-project`, `--remove-reviewer`,
 *   `-d/--description`, `-h/--homepage`, `-r/--remote`, `-s/--source`,
 *   `-t/--team` (each Fig `args` + matching `--help` arity line).
 * - Real-only value-taking spellings (absent/stale in Fig, present in
 *   `--help`) → takesValue:true: `--blocked-by`, `--blocking`,
 *   `--parent`, `-T/--template`, `--type` (`issue create`);
 *   `--add-blocked-by`, `--add-blocking`, `--add-sub-issue`,
 *   `--remove-blocked-by`, `--remove-blocking`, `--remove-sub-issue`
 *   (`issue edit`); `-F/--body-file` (`pr create` — Fig omits it, the
 *   existing row covers it); `-A/--author-email`, `--match-head-commit`
 *   (`pr merge`).
 * - Fig value-taking spelling OMITTED with reason: `-recover`
 *   (single-dash, `pr create` Fig typo for `--recover`) — no such
 *   spelling in any `--help`; malformed (`-xy` multi-char) so the
 *   engine would ignore it anyway. The correct `--recover` is tabled.
 * - Fig bool spellings OMITTED (explicit; unlisted bools are neutral
 *   under strict-always — present-but-valueless, attached `--flag=x`
 *   still applies per-token; only value-taking spellings need rows):
 *   `-w/--web` (`issue|pr create`); `-d/--draft`, `-f/--fill`,
 *   `--no-maintainer-edit` (`pr create`); `-d/--delete-branch`,
 *   `-m/--merge`, `-r/--rebase`, `-s/--squash` (`pr merge` — each
 *   collides with a value row, see ALARMS); `--public`, `--private`,
 *   `--internal`, `-c/--clone`, `--disable-issues`, `--disable-wiki`,
 *   `--include-all-branches`, `--push` (`repo create`); `-y/--confirm`
 *   (Fig `ghOptions.confirm` — absent from `gh repo create --help`,
 *   stale, omitted). `pr edit` / `issue edit` Fig lists no bools.
 *   Real-only bools follow the same restraint (omitted): `--dry-run`,
 *   `-e/--editor`, `--fill-first`, `--fill-verbose` (`pr create`);
 *   `--remove-milestone` (`pr|issue edit`); `--admin`, `--auto`,
 *   `--disable-auto` (`pr merge`); `--remove-parent`, `--remove-type`
 *   (`issue edit`).
 *
 * COLLISION ALARMS (owner doctrine: per-subcommand arity collision is a
 * CLI smell — alarm core, don't silently resolve; flat table is
 * per-binary, the known engine limit; each alarm is a CORE-ALARM
 * candidate with Fig/`--help` evidence on both sides; local resolution
 * is fail-closed-documented below and marked for core):
 * - `-m`: value-taking under `pr create|edit` + `issue create|edit`
 *   (`-m/--milestone name` — Fig `args`, `gh help pr create|edit` +
 *   `gh help issue create|edit` each show `-m, --milestone name`) vs
 *   boolean under `pr merge` (`-m/--merge` — Fig no-args, `gh help pr
 *   merge` shows `-m, --merge` with no value). LOCAL: takesValue:true
 *   (milestone row). Why: 4 value contexts vs 1 bool; hiding milestone
 *   values fixes the pinned `-m "-R…"` hijacks (mask-release of foreign
 *   targets + over-block of own targets) and flag-first extraction
 *   (`gh -m x pr …`); bool-context over-consumption (`gh pr merge -m
 *   --repo=…` hiding `--repo`) is narrow/rare — accepted, FOR CORE.
 * - `-r`: value-taking under `pr create` (`-r/--reviewer handle` —
 *   Fig `args`, `gh help pr create`) + `repo create` (`-r/--remote
 *   string` — Fig `args`, `gh help repo create`) vs boolean under `pr
 *   merge` (`-r/--rebase` — Fig no-args, `gh help pr merge`). LOCAL:
 *   takesValue:true (reviewer + remote rows). Why: reviewer/remote
 *   values must hide for the same hijack/extraction reasons; merge
 *   bool over-consumption narrow — accepted, FOR CORE.
 * - `-s`: value-taking under `repo create` (`-s/--source string` —
 *   Fig `args`, `gh help repo create`) vs boolean under `pr merge`
 *   (`-s/--squash` — Fig no-args, `gh help pr merge`). LOCAL:
 *   takesValue:true (source row). Why: source paths (`.`, `/tmp/…`)
 *   must hide or `gh -s . repo create …` under-extracts past the seed
 *   gate (fail-open empty-repo birth); merge over-consumption narrow —
 *   accepted, FOR CORE.
 * - `-d`: value-taking under `repo create` (`-d/--description string`
 *   — Fig `args`, `gh help repo create`) vs boolean under `pr create`
 *   (`-d/--draft` — Fig no-args, `gh help pr create`) + `pr merge`
 *   (`-d/--delete-branch` — Fig no-args, `gh help pr merge`). LOCAL:
 *   takesValue:true (description row). Why: free-text description is
 *   the most hijack-prone value (`--description "-Rfoo/bar"`); hiding
 *   wins over the narrow `… -d --repo=…` bool-context hide — accepted,
 *   FOR CORE.
 * - `-h`: value-taking under `repo create` (`-h/--homepage URL` — Fig
 *   `args`, `gh help repo create`; inherited FLAGS there list only
 *   `--help`, so `-h` is homepage in that context) vs boolean help
 *   (`-h/--help` — gh/github convention, the rules' `infoOnly`
 *   `extraFlags: ["-h"]`). LOCAL: takesValue:true (homepage row; the
 *   help entry keeps `-h` as a bool spelling but consumption derives
 *   true from the homepage row). Why: `gh -h URL repo create …` must
 *   hide the URL or the seed gate under-extracts (fail-open); help
 *   forms (`gh … -h`, `gh … --help`) still exempt via the token-level
 *   `infoOnly` leaf (unaffected — it uses its own bool entries, not
 *   table consumption) and error/allow safely at runtime — accepted,
 *   FOR CORE.
 * - Shared shorts with NO arity collision (all sides value-taking —
 *   no alarm, consuming set dedupes, noted for the record): `-t`
 *   (`--title` + `--subject` + `--team`), `-l` (`--license` +
 *   `--label`), `-p` (`--template` + `--project`), `--template` long
 *   (`-p` repo + `-T` pr/issue).
 *
 * Glue derives from this table (single-char-short aliases of
 * takesValue:true entries): `R F b t g l p a B H m r T A d h s`.
 * Faithful to gh/cobra shorthand parsing — including its sharp edges:
 * `-local` glues `l` and `-public` glues `p`, so those contrived lines
 * now EXEMPT the seed rule where the old token-boundary guard blocked
 * them. gh rejects both lines at runtime (junk seed values), so nothing
 * real executes; accepted and pinned in
 * `rules/gh-repo-create-needs-seed.test.ts`.
 */

import type { CLIDescriptor } from "@cad0p/pi-steering";

/**
 * gh descriptor: `globals-anywhere` (the walker's own documented gh
 * example — `gh -R x/y pr merge` ≡ `gh pr merge -R x/y`) + the flag
 * table below, which OWNS every flag entry (core git-descriptor
 * shape): entries live INLINE here and every consumer reads them via
 * `GH_CLI_DESCRIPTOR.flags.<key>` (or a destructured `ghFlags` alias
 * at use sites) — there are no standalone exported `GH_*_FLAG`
 * consts, so the table and its readers cannot drift.
 *
 * Referenced by name (never inlined) in the plugin literal so hover
 * rides on this const.
 */
export const GH_CLI_DESCRIPTOR = {
  positionPolicy: "globals-anywhere",
  flags: {
    /** `-R` / `--repo` — the global repo selector (takesValue:true). */
    repo: {
      aliases: ["-R", "--repo"],
      takesValue: true,
    },
    /** `--hostname` — legacy/compat spelling (see header). */
    hostname: {
      aliases: ["--hostname"],
      takesValue: true,
    },
    /** `-F` / `--body-file` — the vault-substitution channel. */
    bodyFile: {
      aliases: ["--body-file", "-F"],
      takesValue: true,
    },
    /** `-b` / `--body` — inline body (disabled-rules fallback). */
    body: {
      aliases: ["--body", "-b"],
      takesValue: true,
    },
    /** `-t` / `--title` — `pr create` / `issue create` title. */
    title: {
      aliases: ["--title", "-t"],
      takesValue: true,
    },
    /** `--subject` (+ `-t`) — `pr merge` squash-commit subject. */
    subject: {
      aliases: ["--subject", "-t"],
      takesValue: true,
    },
    /** `--add-readme` — seed flag (bool). */
    addReadme: {
      aliases: ["--add-readme"],
      takesValue: false,
    },
    /** `--gitignore` / `-g` — seed flag (`<lang>`). */
    gitignore: {
      aliases: ["--gitignore", "-g"],
      takesValue: true,
    },
    /** `--license` / `-l` — seed flag (`<keyword>`). */
    license: {
      aliases: ["--license", "-l"],
      takesValue: true,
    },
    /** `--template` / `-p` — seed flag (`<repo>`). */
    template: {
      aliases: ["--template", "-p"],
      takesValue: true,
    },
    /** `-h` / `--help` — bool (rides the infoOnly carve-out; see `-h` ALARM). */
    help: {
      aliases: ["-h", "--help"],
      takesValue: false,
    },
    /** `--version` — bool. */
    version: {
      aliases: ["--version"],
      takesValue: false,
    },
    // consumption-only: hides assignee logins from -R hijack + flag-first extraction.
    assignee: {
      aliases: ["-a", "--assignee"],
      takesValue: true,
    },
    // consumption-only: hides --blocked-by numbers/URLs from -R hijack + extraction.
    blockedBy: {
      aliases: ["--blocked-by"],
      takesValue: true,
    },
    // consumption-only: hides --blocking numbers/URLs from -R hijack + extraction.
    blocking: {
      aliases: ["--blocking"],
      takesValue: true,
    },
    // consumption-only: hides base branches from -R hijack + flag-first extraction.
    base: {
      aliases: ["-B", "--base"],
      takesValue: true,
    },
    // consumption-only: hides head branches from -R hijack + flag-first extraction.
    head: {
      aliases: ["-H", "--head"],
      takesValue: true,
    },
    // consumption-only: hides label names (shares -l with --license, both value) from hijack.
    label: {
      aliases: ["-l", "--label"],
      takesValue: true,
    },
    // consumption-only: hides milestone names from -R hijack (CORE-ALARM -m, see header).
    milestone: {
      aliases: ["-m", "--milestone"],
      takesValue: true,
    },
    // consumption-only: hides project titles (shares -p with --template, both value) from hijack.
    project: {
      aliases: ["-p", "--project"],
      takesValue: true,
    },
    // consumption-only: hides --recover strings from -R hijack + extraction.
    recover: {
      aliases: ["--recover"],
      takesValue: true,
    },
    // consumption-only: hides reviewer handles from -R hijack (CORE-ALARM -r, see header).
    reviewer: {
      aliases: ["-r", "--reviewer"],
      takesValue: true,
    },
    // consumption-only: hides --add-reviewer logins from -R hijack + extraction.
    addReviewer: {
      aliases: ["--add-reviewer"],
      takesValue: true,
    },
    // consumption-only: hides --remove-reviewer logins from -R hijack + extraction.
    removeReviewer: {
      aliases: ["--remove-reviewer"],
      takesValue: true,
    },
    // consumption-only: hides --add-assignee logins from -R hijack + extraction.
    addAssignee: {
      aliases: ["--add-assignee"],
      takesValue: true,
    },
    // consumption-only: hides --remove-assignee logins from -R hijack + extraction.
    removeAssignee: {
      aliases: ["--remove-assignee"],
      takesValue: true,
    },
    // consumption-only: hides --add-label names from -R hijack + extraction.
    addLabel: {
      aliases: ["--add-label"],
      takesValue: true,
    },
    // consumption-only: hides --remove-label names from -R hijack + extraction.
    removeLabel: {
      aliases: ["--remove-label"],
      takesValue: true,
    },
    // consumption-only: hides --add-project titles from -R hijack + extraction.
    addProject: {
      aliases: ["--add-project"],
      takesValue: true,
    },
    // consumption-only: hides --remove-project titles from -R hijack + extraction.
    removeProject: {
      aliases: ["--remove-project"],
      takesValue: true,
    },
    // consumption-only: hides -T template paths (shares --template long, both value) from hijack.
    templateT: {
      aliases: ["-T", "--template"],
      takesValue: true,
    },
    // consumption-only: hides merge author emails from -R hijack + extraction.
    authorEmail: {
      aliases: ["-A", "--author-email"],
      takesValue: true,
    },
    // consumption-only: hides --match-head-commit SHAs from -R hijack + extraction.
    matchHeadCommit: {
      aliases: ["--match-head-commit"],
      takesValue: true,
    },
    // consumption-only: hides free-text descriptions from -R hijack (CORE-ALARM -d, see header).
    description: {
      aliases: ["-d", "--description"],
      takesValue: true,
    },
    // consumption-only: hides homepage URLs from extraction bypass (CORE-ALARM -h, see header).
    homepage: {
      aliases: ["-h", "--homepage"],
      takesValue: true,
    },
    // consumption-only: hides remote names (shares -r, both value) from hijack (CORE-ALARM -r, see header).
    remote: {
      aliases: ["-r", "--remote"],
      takesValue: true,
    },
    // consumption-only: hides source paths (e.g. `.`) from extraction bypass (CORE-ALARM -s, see header).
    source: {
      aliases: ["-s", "--source"],
      takesValue: true,
    },
    // consumption-only: hides team names (shares -t, all value) from -R hijack + extraction.
    team: {
      aliases: ["-t", "--team"],
      takesValue: true,
    },
    // consumption-only: hides --parent numbers/URLs from -R hijack + extraction.
    parent: {
      aliases: ["--parent"],
      takesValue: true,
    },
    // consumption-only: hides --type names from -R hijack + extraction.
    issueType: {
      aliases: ["--type"],
      takesValue: true,
    },
    // consumption-only: hides --add-blocked-by numbers/URLs from hijack + extraction.
    addBlockedBy: {
      aliases: ["--add-blocked-by"],
      takesValue: true,
    },
    // consumption-only: hides --add-blocking numbers/URLs from hijack + extraction.
    addBlocking: {
      aliases: ["--add-blocking"],
      takesValue: true,
    },
    // consumption-only: hides --add-sub-issue numbers/URLs from hijack + extraction.
    addSubIssue: {
      aliases: ["--add-sub-issue"],
      takesValue: true,
    },
    // consumption-only: hides --remove-blocked-by numbers/URLs from hijack + extraction.
    removeBlockedBy: {
      aliases: ["--remove-blocked-by"],
      takesValue: true,
    },
    // consumption-only: hides --remove-blocking numbers/URLs from hijack + extraction.
    removeBlocking: {
      aliases: ["--remove-blocking"],
      takesValue: true,
    },
    // consumption-only: hides --remove-sub-issue numbers/URLs from hijack + extraction.
    removeSubIssue: {
      aliases: ["--remove-sub-issue"],
      takesValue: true,
    },
  },
} as const satisfies CLIDescriptor;
