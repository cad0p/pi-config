# pi-steering-github

GitHub workflow rules for [pi-steering](https://github.com/cad0p/pi-steering): every PR closes at least one issue; PR/issue bodies come from napkin vault body files.

## What it ships

One `Plugin` (`name: "github"`) with six rules and four predicates. Every rule routes on `command: "gh"` plus `when.subcommand` sequences (structural — core #117 command-first, no regex anchors); the plugin owns the `gh` CLI descriptor (`Plugin.cliDescriptors`) that backs subcommand extraction, the `flag:` leaf, and the bound `ctx.command` facade:

| Rule | Fires on | Blocks when |
| --- | --- | --- |
| `gh-repo-flag-before-subcommand` | gated `pr create \| new \| edit \| merge \| issue create \| edit` invocations carrying `-R/--repo` — in any flag position (leading or subcommand-line) | the `-R`/`--repo` target is a FOREIGN repo (basename differs from the cwd repo) — redirect: run a foreign subagent maintainer loop until good, then cd into the foreign repo and target it from there |
| `pr-body-from-vault-file` | `gh pr create \| new \| edit` | the body doesn't come from `--body-file <(perl -0777 -pe '<BODY_STRIP>' <file>)` — a process substitution running the pinned perl one-liner (direct paths and inline `--body` are blocked) |
| `pr-create-needs-issue-link` | `gh pr create \| new` | the `--title` value or the body lacks a closing keyword + `#N` |
| `pr-merge-needs-closing-keywords` | `gh pr merge` | the `--subject` value lacks a closing keyword + `#N` |
| `issue-body-from-vault-file` | `gh issue create \| edit` | the body doesn't come from `--body-file` pointing at a `<repo>/issues/` napkin-vault file |
| `gh-repo-create-needs-seed` | `gh repo create \| new` | no seed flag present (`--add-readme`, `--gitignore\|-g`, `--license\|-l`, `--template\|-p`) — a bare create births an EMPTY repo |

| Predicate | Purpose |
| --- | --- |
| `missingVaultBodyFile` | true when `--body-file` is absent, not the pinned `<(perl -0777 -pe '<BODY_STRIP>' <file>)` substitution form, or the path fails the vault check (nonexistent, outside a napkin vault, not under `<repo>/<section>/`) — except an `edit` carrying no body-affecting flag (`--body`/`-b`, `--body-file`/`-F`), which passes (#44) |
| `foreignRepoTarget` | three states over the invocation's `-R/--repo`: ABSENT → released (falls through to the per-subcommand rules); PRESENT-unparsable → fail-closed; PRESENT-parsable → true when the effective target's basename differs from the cwd repo's basename (foreign). Fail-closed on unknown cwd / unresolvable repo too |
| `infoOnly` | true when the command IS an info-only invocation (`--help` / `--version` + additive `extraFlags`) — from `@cad0p/pi-steering-flags` (see [Usage](#usage)) |
| `requiresFlagValue` | true when the last-wins value of a flag alias set is absent, valueless, or fails `matches` — from `@cad0p/pi-steering-flags` (see [Usage](#usage)) |

All rules are **strict** — no `noOverride: false`, so there is no agent-side override escape hatch. The policy is unconditional.

## Source layout

The package mirrors the canonical `examples/work-item-plugin` layout — one file per rule / predicate / helper concern:

```
src/
├── index.ts                        # plugin assembly + roster + cliDescriptors + declare global + re-exports
├── index.test.ts                   # roster-order pin + reason-string byte-identity pins
├── integration.test.ts             # end-to-end pipeline tests
├── descriptors.ts                  # the owned gh CLI descriptor (GH_CLI_DESCRIPTOR, table-owned flag entries)
├── descriptors.test.ts             # descriptor value pin (#61 acceptance)
├── helpers/
│   ├── body-strip.ts                # the pinned perl body-strip one-liner (leaf)
│   ├── body-strip.test.ts           # perl behavior pins (fixture matrix)
│   ├── pattern-args.ts             # argText, unquote, findFlagValue, findBodyFileValue, parseBodyFileArg, resolveAgainstCwd
│   ├── pattern-args.test.ts
│   ├── body-keyword.ts             # bodyHasClosingKeyword
│   ├── body-keyword.test.ts
│   ├── patterns.ts                 # the keyword content-pattern constants (routing is structural now)
│   ├── patterns.test.ts            # content-pattern pins
│   └── repo-name.ts                # repoName
├── predicates/
│   ├── missing-vault-body-file.ts  # the vault body-file predicate handler
│   ├── missing-vault-body-file.test.ts
│   ├── foreign-repo-target.ts      # the -R foreign-target gate handler
│   ├── foreign-repo-target.test.ts
└── rules/
    ├── gh-repo-flag-before-subcommand.ts + .test.ts
    ├── pr-body-from-vault-file.ts
    ├── pr-create-needs-issue-link.ts
    ├── pr-merge-needs-closing-keywords.ts + .test.ts
    ├── issue-body-from-vault-file.ts
    └── gh-repo-create-needs-seed.ts + .test.ts
```

## Install

```bash
pnpm add @cad0p/pi-steering-github
```

`@cad0p/pi-steering-github` declares `@cad0p/pi-steering` as a `peerDependency` and pulls `@cad0p/pi-napkin` as a **runtime dependency** (the vault rules use its `./steering` subpath for napkin-vault detection — compiled JS since 0.7.0-20260814.0). Non-napkin users can disable the two vault body-file rules (see [Disabling](#disabling)) — the `@cad0p/pi-napkin` dep stays but is inert.

## Usage

```ts
// .pi/steering/index.ts
import { defineConfig } from "@cad0p/pi-steering";
import githubPlugin from "@cad0p/pi-steering-github";

export default defineConfig({
  plugins: [githubPlugin],
});
```

The `infoOnly` + `requiresFlagValue` leaves the rules compose come
from `@cad0p/pi-steering-flags` (runtime dep, single source of truth —
re-exported through this plugin under the same `when` key names, so no
`flagsPlugin` needed in the config). Rule `when`-clauses and user
configs are untouched either way (the keys don't change, only the
provider).

Listing the plugins feeds their rule/predicate names into `defineConfig`'s type unions, so `disabledRules` typos fail at compile time.

## Rules

### `gh-repo-flag-before-subcommand`

`gh -R x/y pr create|new|edit|merge`, `gh pr merge --repo=cad0p/x …`, and every other gated `pr|issue …` mutation that **carries** `-R/--repo` targeting a foreign repo is blocked with a redirect: run a foreign subagent maintainer loop until good, then cd into the foreign repo and target it from there. This is the ENTRY step of the foreign flow — the rule sits FIRST in the roster so the redirect is the first thing the agent meets. Its `subcommand:` set OVERLAPS the other rules' sequences (it routes gated subcommands in any flag position — both `-R` positions since #39, unbounded leading pairs since #41, now structural via the descriptor's consuming-flag arity instead of regex), so correctness rests on the evaluator's first-firing-rule-wins ordering plus RELEASE FALL-THROUGH: the `foreignRepoTarget` predicate releases every command without a foreign target and the per-subcommand rules evaluate normally.

The gate keys on `-R/--repo` **PRESENCE, not position**: covered are `-R x/y`, `--repo x/y`, `--repo=x/y`, `-Rx/y` in ANY flag position (`gh --hostname h -R x/y pr merge` routes — the descriptor's consuming-flag arity keeps extraction exact) OR anywhere on the gated subcommand line. A command carrying NO `-R/--repo` anywhere is released untouched — and the per-subcommand sequences match flag-first forms too, so a released command LANDS on its vault-body/keyword policy instead of bypassing the stack (pre-#41 a released one-pair form escaped every policy). Non-repo leading flags (`-v`, `--hostname`) route but release on absence — landing on those same policies; note that a real repo flag after them blocks at the gate (`-v … --repo=<foreign>` escaped the gate before #39). The gate is **fully declarative** — zero condition code, a `subcommand:` router plus an AND of two registered-predicate leaves:

- `foreignRepoTarget: true` — this package's registered predicate: blocks when the EFFECTIVE `-R`/`--repo` target is a foreign repo (reads through the bound `ctx.command` facade; glue for `R` derives from the owned descriptor — no call-site arity).
- `not.infoOnly({ extraFlags: ["-h"] })` — the read-only carve-out, below (flags leaf, same key).

Target resolution is **last-wins across the `-R`/`--repo` aliases**, matching gh/cobra (repeated spellings of one logical flag collapse to their final value): when both aliases occur, the LAST occurrence is the effective target, and a trailing valueless alias or an empty attached value as the last occurrence fails closed instead of falling back to the overridden earlier alias. The reason renders the EFFECTIVE target from the same resolution call the verdict used — `via cad0p/x` — so the redirect names where to cd; an unparsable target renders the honest fallback phrase instead of echoing a flag spelling:

```
The PR you're targeting via cad0p/x belongs to a foreign repo.
REQUIREMENT: run a foreign subagent maintainer loop until good,
then cd into the foreign repo and target it from there.
```

- **Fork→upstream flow is allowed**: when the `-R` target's basename equals the cwd repo's basename (origin URL basename, cwd-folder fallback — the existing `repoName` helper), the command passes — `gh -R upstream/foo pr create` from inside the `me/foo` clone is the most common legit `-R` use. This basename equality IS the policy (#19), hardcoded in the predicate — no config knob. Cost accepted: `-R <own-repo> pr merge` from inside the repo is indistinguishable and slips through — these gates are heuristic discipline, not security. For fork workflows, `gh repo set-default upstream` makes gh target upstream by default (no `-R` needed).
- **Fail-closed**: unknown cwd / unresolvable repo / unparsable target / a valueless-or-empty last alias occurrence → blocked.
- **Read-only `--help`/`-h` never blocks** — declaratively, via the `not.infoOnly({ extraFlags: ["-h"] })` leaf: `--help`/`--version` defaults PLUS GitHub's additive `-h`. Accepted exposure: a gated invocation carrying `--version` (bare or attached, e.g. `gh -R owner/x pr create --version`) is now ALLOWED too — gh errors on it for pr/issue subcommands, so nothing real can happen; `-v` is deliberately NOT in the info-only set and stays gated. Both leaves are token-level over walker argv (a help token inside a quoted value can't falsely exempt).
- **Glued short form `-Rcad0p/x`**: resolved via table-derived glue (`R` is a consuming short in the owned descriptor) — own-repo basename matches are ALLOWED, foreign owner/repo targets block on basename mismatch. Accepted limitation: any word shaped `-R<rest>` decomposes, so an `-R`-prefixed VALUE (e.g. a body value `-Rfoo/bar ref`) can hijack resolution → fail-closed over-block; slashless lookalikes (`"-Rebased onto main"`) release.
- **`repo create|new` is excluded by design**: nothing to cd into — the target is the positional argument (`gh repo create owner/name` works from any cwd, and the seed rule gates the actual create form).
- **Slashless values** (`-R upstream`, a remote-name form) route but are **released** by `foreignRepoTarget` (no `/` → not a foreign owner/repo redirect; the fork→upstream flow passes through unchanged).

### `pr-body-from-vault-file`

`gh pr create|new|edit` must take the body from `--body-file <(perl -0777 -pe '<BODY_STRIP>' <file>)` — a process substitution running the pinned perl one-liner, which strips the note's YAML frontmatter before `gh` uploads it. Direct paths upload the file **verbatim** (frontmatter renders on GitHub) and are blocked, like inline `--body`.

FORM + vault-path check — the substitution must be the pinned form AND the file argument must resolve to a real file inside a napkin vault, under a `<repo>/<section>/` directory (`<repo>` = origin URL basename, cwd-folder fallback). Fail-closed: anything unverifiable (missing flag, unparsable form, walker-unknown cwd, nonexistent path, outside a vault, wrong section/repo) counts as missing. The `<repo>/<section>/` convention is both taught by the rule's reason and enforced here. The closing-keyword content check belongs to `pr-create-needs-issue-link` (responsibility separation). Why vault body files: they are reviewable, persistent, and kb-discoverable — the body is written and reviewed *before* the command runs, so the PR description is a deliberate artifact rather than an inline afterthought. Flag-first forms (`gh --hostname h pr create …`) route structurally, so a command released by the foreign gate lands here instead of bypassing the policy.

Edit scoping (#44): a `pr edit` carrying no body-affecting flag (`--body`/`-b`, `--body-file`/`-F`) skips this rule — `gh pr edit 46 --title "…"` and label/state edits pass without the substitution. Only edits that WRITE the body are gated (inline `--body` stays blocked — bodies must come from the vault).

Since #43 a deviating inner command carries a byte-diff diagnostic: a mutated strip program reports the divergent core spans with the byte offset (`substitution program diverges from the pinned strip at byte 129: - expected: *)? / + got: ?)*`), anything else (`cat`, `sed`, extra/missing tokens) shows the two full command lines — always followed by the canonical recipe, so the block message stays actionable.

### `pr-create-needs-issue-link`

`gh pr create|new` must carry a closing keyword (`close`/`closes`/`closed`, `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`) + `#N` in **both** the inline `--title` value and the body. The body normally comes from the vault body file, so the check reads the file content (falling back to inline `--body` text).

- **Title keyword** — the squash-merge subject inherits the PR title, so even a web-UI merge with a Title-Only commit policy auto-closes the issue from the commit subject.
- **Body keyword** — drives the GitHub "linked issues" sidebar link and the description-channel auto-close on merge.
- **Multiple issues** — repeat the keyword per issue (`"Closes #A, closes #B"`); `"Closes #A #B"` honors only the first number. A bare `#N` mention never counts; colons and case variants are accepted.
- Draft PRs are gated like any other PR (a tracking issue is the allowed pattern while a draft is open).

Flag-first creates (`gh -v -R x/y pr create --title t`) route structurally, so gate-released creates get the full issue-link policy. The `--title` read is last-wins across the `--title`/`-t` aliases, matching gh/cobra.

### `pr-merge-needs-closing-keywords`

`gh pr merge` must carry a closing keyword + `#N` in the `--subject` value (commit subject) — short `-t` form, `--flag=value` forms. GitHub scans the whole squash commit message for closing keywords, so the commit subject alone closes the issues; the commit body is optional at merge. Flag-first merges (`gh -v --hostname h pr merge --squash`) route structurally and still block without a keyword, so gate-released merges land on this policy. The gate is **fully declarative** — zero condition code: `when.not.infoOnly(["-h"])` exempts read-only `--help`, `--version`, and GitHub's additive `-h` (attached forms `--help=value`, `--version=1`, `-h=value` included; `-v` stays gated), and `when.requiresFlagValue({ flags: ["--subject", "-t"], matches: ISSUE_REF })` enforces the subject check with gh/cobra last-flag-wins semantics across the two aliases — absent, valueless, or non-matching values block. Both leaves are `@cad0p/pi-steering-flags` predicates (same keys, see [Usage](#usage)) over walker-parsed argv, so quoted values such as `--subject "see --help"` can't falsely exempt. An exact quoted value equal to an info token (for example `--subject "--help"`) is indistinguishable from a bare flag after quote removal and is an accepted limitation.

### `issue-body-from-vault-file`

`gh issue create|edit` must take the body from the same pinned perl substitution form (`--body-file <(perl -0777 -pe '<BODY_STRIP>' <file>)`). No keyword requirement — issues close nothing. Flag-first invocations route structurally, so gate-released forms land here. Shares the pr rule's dynamic byte-diff block reason (same `explainBodyFileArg` tag + `renderBodyFileDiff` helper — the two rules' diagnostics can never drift).

Edit scoping (#44): an `issue edit` carrying no body-affecting flag skips this rule — `gh issue edit 8845 --add-label bug` (the live over-block that motivated the fix) passes without the substitution.

### The pinned frontmatter-strip one-liner

Vault notes carry YAML frontmatter; the pinned perl one-liner removes exactly that block before `gh` uploads the content (the H1 is **kept** — it is the note's title):

```bash
perl -0777 -pe 's/^(?:\xEF\xBB\xBF)?---\r?\n(?:.*?\r?\n)?(?:---|\.\.\.)\r?\n(?:\r?\n)*//s' <file>
```

The program is **byte-pinned** by the rule (the tokenizer compares the unquoted program token against the constant; quoting style is free) and its **behavior is pinned by the test suite**, which runs it against the full fixture matrix on every CI platform. Perl is one interpreter everywhere (Linux, macOS, Git Bash), so the behavior is identical on all platforms. The one-liner strips a leading `---` block (after an optional BOM) closed by the next `---` / `...` line, CRLF-tolerant, plus any immediately following blank lines; unterminated or absent frontmatter → the file passes through byte-identical. Mid-document `---` and `##` headings are never touched. Vault files are **never modified** — the one-liner only reads, so notes stay byte-identical.

The substitution is the ONLY accepted form for both PR and issue bodies, on create and edit:

```bash
gh pr create --title "..." --body-file <(perl -0777 -pe '<BODY_STRIP>' <vault>/**/<repo>/prs/2026-08-14-pr1-slug.md)
gh pr edit 46 --body-file <(perl -0777 -pe '<BODY_STRIP>' <vault>/**/<repo>/prs/2026-08-14-pr1-slug.md)
gh issue create --title "..." --body-file <(perl -0777 -pe '<BODY_STRIP>' <vault>/**/<repo>/issues/2026-08-14-issue1-slug.md)
gh issue edit 29 --body-file <(perl -0777 -pe '<BODY_STRIP>' <vault>/**/<repo>/issues/2026-08-14-issue1-slug.md)
```

The glued form `--body-file=<(...)` and the short `-F <(...)` form are accepted too. The inner command is strict — only `perl -0777 -pe '<BODY_STRIP>' <path>` parses (any other tool, program, or token arrangement fails closed).

`<( )` process substitution needs bash ≥ 4 (or zsh): the pi `bash` tool qualifies, as do Git Bash and WSL on Windows. Plain `sh` and Windows `cmd` do not.

### `gh-repo-create-needs-seed`

`gh repo create|new` must carry a seed flag — `--add-readme`, `--gitignore|-g <tpl>`, `--license|-l <kw>`, or `--template|-p <repo>` (long or short form, space or `=` value form). A bare create births an **EMPTY repo** (zero branches, zero commits): `main` can only be born by pushing past the `no-main-commit` gates — the steering-override dance, and the first content lands UNREVIEWED. The seeded flow sends the whole bootstrap through the normal pipeline:

```bash
gh repo create cad0p/<name> --add-readme
# then: git fetch → git checkout -b feat/bootstrap origin/main → commit → push → PR → squash merge
```

The seed commit is the PR's base — the PR diff replaces it, so the first content is reviewed.

Non-seed flags (`--source`, `--push`, `--clone`, `--description`, `--public|--private`, `--remote`, `--team`, …) do **not** exempt: `gh repo create x --source . --push` is blocked too — only a seed flag lets the command through. The rule is a form check (like the body-file rules); gh's own flag validation governs seed/`--source` combos at runtime. Routing is structural (`gh -v --hostname h repo create foo` is gated; `gh -g repo create foo` passes — seed flags count anywhere in the command), and the exemption is the declarative `not.flag` leaf over the descriptor's seed entries — token-level and quote-aware, which fixes the old accepted false-exemption: a seed-looking token inside a QUOTED value (`--description "see --license mit"`) no longer exempts. Glued lookalikes without a leading dash (`foo--add-readme`) still never match; `-local` / `-public` now read as `-l` / `-p` via pflag-faithful table glue (gh rejects both lines at runtime on the junk seed values, so nothing real executes — accepted, pinned by the tests).

## Predicates

### `missingVaultBodyFile`

`when.missingVaultBodyFile` takes `{ section: "prs" | "issues" }` and returns `true` (rule blocks) when the command's `--body-file` value is missing, not the pinned `<(perl -0777 -pe '<BODY_STRIP>' <path>)` substitution form (direct paths, inline `--body`, wrong inner commands, extra or missing tokens), or the path fails the vault check: it must resolve to a real file inside a napkin vault (`.napkin/` / `.obsidian/.napkin/` walk-up), under a `<repo>/<section>/` directory (`<repo>` = origin URL basename, cwd-folder fallback). Fail-closed: anything unverifiable (incl. walker-unknown cwd) counts as missing. Edit scoping (#44): an `edit` with no body-affecting flag (`--body`/`-b`, `--body-file`/`-F`) returns `false` — the policy applies to an edit only when the command writes the body. The `section` argument selects the required `<repo>/<section>/` directory — the convention is taught by the rule reasons AND enforced here.

### `foreignRepoTarget`

`when.foreignRepoTarget` is a boolean leaf (core `BooleanLeafArgs`: `true` / `{ value: true }` enable the gate, `false` never fires — deliberately not inverted) and takes no arguments on purpose — the basename policy IS the semantics (#19), there is no `matchBy`/`flags` knob. Flag access reads through the bound `ctx.command` facade (glue + consumption from the owned gh descriptor). It collapses every routed command into one of three states: ABSENT (no `-R`/`--repo` anywhere — space, attached, or glued forms) → release (fall-through to the per-subcommand rules); PRESENT-unparsable (valueless or empty-valued LAST alias occurrence) → fail-closed block; PRESENT-parsable → slashless remote-name release, then basename compare against the cwd repo. Fail-closed rails remain: walker-unknown cwd, unresolvable repo.

### `infoOnly` / `requiresFlagValue` (from `@cad0p/pi-steering-flags`)

Same `when` key names and arg shapes as `@cad0p/pi-steering-flags` (`infoOnly: true | { extraFlags }`, `requiresFlagValue: { flags, matches }`), re-exported through this plugin (single source of truth — see [Usage](#usage)). Both read through the bound `ctx.command` facade: value resolution consumes + glues via the owned descriptor (spellings with no table row never consume — the remedy is a table row), and the info-only check stays bundle-blind like the flags original. Keys, shapes, and verdicts for table-listed spellings are unchanged.

## Disabling

Strict rules are still individually disableable at the config level:

```ts
export default defineConfig({
  plugins: [githubPlugin],
  // Keep the issue-link policy but allow inline --body anywhere.
  disabledRules: ["pr-body-from-vault-file", "issue-body-from-vault-file"],
});
```

**Non-napkin users** (no obsidian vault) should disable the two vault body-file rules and keep the keyword rules — `pr-create-needs-issue-link` then falls back to inline `--body` text, and `pr-merge-needs-closing-keywords` is self-contained:

```ts
disabledRules: ["pr-body-from-vault-file", "issue-body-from-vault-file"],
```

## Helpers (escape-hatch)

When the built-in predicate isn't enough, reach for the exported helpers inside `when.condition`:

- `findFlagValue(ctx, flags)` — value of the first occurrence of a flag (space or `=` form), unquoted.
- `findBodyFileValue(ctx)` — value of the first `--body-file` / `-F` occurrence (`""` when absent); handles the walker-split glued form `--body-file=<(...)`.
- `explainBodyFileArg(word)` — classify a body-file value word into five tags: `missing` \| `direct` \| `form` \| `ok` \| `diff` (the single source of truth behind the predicate verdict AND the rules' dynamic byte-diff reason).
- `parseBodyFileArg(word)` — the pinned-substitution pin: `{ kind: "substitution", vaultPath }` \| `{ kind: "direct", path }` \| `null`.
- `renderBodyFileDiff(word)` — the byte-diff diagnostic for the two body-file rules: byte pair when a diverging program token is close to the pinned strip, the two full command lines otherwise (always followed by the canonical static recipe).
- `resolveAgainstCwd(ctx, path)` — resolve a path against the command's effective cwd (`null` on walker-unknown cwd).
- `bodyHasClosingKeyword(ctx)` — does the body (stripped vault body-file content, or inline `--body`) carry a closing-keyword ref?
- `unquote(text)` / `argText(ctx)` — low-level walker-word utilities.
- `ctx.command` (core facade) — `hasFlag` / `getFlagValue` / `getAllFlagValues` / `positionals()` / `isInfoOnly`, bound through the owned gh descriptor; prefer it over hand-rolled argv scans.

The gh descriptor (`GH_CLI_DESCRIPTOR` — the flag table owns every entry, read via `GH_CLI_DESCRIPTOR.flags.<key>`) and the content-pattern constants (`CLOSING_KEYWORD`, `ISSUE_REF`) are exported too — the content patterns are pinned by the unit tests. (The `^gh\s+` anchor family is retired — routing is structural now, closes #55.) The rule objects (`ghRepoFlagBeforeSubcommand`, …), the predicate handlers (`missingVaultBodyFile`, `foreignRepoTarget`, `infoOnly`, `requiresFlagValue`), the `foreignRepoReason` ReasonFn (module-exported from `src/rules/gh-repo-flag-before-subcommand.ts`), and the `repoName` helper (from `src/helpers/repo-name.ts`) are re-exported as well.

## Known limitations

- **Inline `--body` is blocked** by the vault body-file rules by design — the file is the source of truth. If you need inline bodies, disable those rules.
- **`--body-file` content is checked at eval time** by `pr-create-needs-issue-link` (and the merge gate no longer inspects the body at all — the `--subject` channel is sufficient): the file must already contain the closing keyword when the command runs. `pr-merge-needs-closing-keywords` checks only the explicit `--subject` value.
- **Exact quoted info tokens**: the info-only check intentionally removes shell quotes before checking exact argv tokens. Consequently, `--subject "--help"` and `--subject "--version"` are indistinguishable from bare info-only flags and are released; surrounding text such as `"see --help"` and `"see --version"` remains blocked.
- **Value-region truncation is gone**: keyword checks now read whole flag values through the bound facade (last-wins, quote-aware) — a closing-keyword ref after a literal ` - ` can no longer be missed by truncation. The `--body-file` substitution pins were never region-based (exact word classification).
- **Quoted-value seed lookalikes now block (improvement)**: a seed-looking token inside a QUOTED flag value (`--description "see --license mit"`) used to falsely exempt; the token-level `not.flag` leaf reads the quoted value as one non-flag word → absent → blocked. The documented hole is closed structurally.
- **Pflag-faithful glue exempts `-local` / `-public` (accepted)**: bundle matching derives from the descriptor table, so `-local` reads as `-l` (license) and `-public` as `-p` (template) — gh parses both the same way, then rejects the junk seed values at runtime, so nothing real executes. Glued lookalikes without a leading dash (`foo--add-readme`) still never match.
- **Case-exact routing**: `command: "gh"` is basename-exact — uppercase `GH` (runtime command-not-found) no longer routes. The old `/i` anchors covered it; accepted delta, pinned by the tests.
- **Slashless `-R <remote>`** (remote-name form, no `/`) routes to the rule but is released by the `foreignRepoTarget` predicate (no `/` → not a foreign owner/repo redirect). The released command then lands on its per-subcommand policy (`gh -R upstream pr create --title t` is caught by the vault-body rule); the fork→upstream flow itself is unaffected when those policies are satisfied.
- **`-R x/y repo create` stays ungated** by the redirect (the repo doesn't exist yet — nothing to cd into). That exclusion is about the foreign gate only: the seed rule gates bare creates in any leading-flag position.
- **`-R`-prefixed VALUE words** (the glue trade-off): table-derived glue for `R` decomposes ANY `-R<rest>` word at any position — a quoted body value like `-m "-Rfoo/bar ref"` can hijack target resolution → fail-closed over-block; slashless lookalikes (`"-Rebased onto main"`) resolve to slashless targets and release via the fork-flow step.

## License

MIT
