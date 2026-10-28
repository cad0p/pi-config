// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Git plugin-owned CLI descriptor (issue #106; #110 flag table, Fig-seeded).
 *
 * Per-binary argv knowledge for the `git` basename. Declared via the
 * git plugin's own `cliDescriptors` slot — the exemplar every
 * external plugin copies. Core seeds nothing; the merger fills absent
 * basenames from its (empty) fallback map, so disabling this plugin
 * drops `git` facts and bare `subcommand: "push"` on
 * `git -C /x …` throws `MissingDescriptorError` (loud block naming
 * the missing facts — declare them or go explicit-strict).
 */

// source: @withfig/autocomplete@2.692.3 src/git.ts, retrieved 2026-09-07,
// reviewed vs `git --help` (git version 2.43.0) on 2026-09-07.
// Per-entry takesValue reviewed against --help arity text; Fig `args` presence
// was the draft signal, --help was the verdict. #111 diffs against this baseline.
//
// Review trace (Fig draft → --help verdict):
// - `-C <path>`, `-c <name>=<value>`: Fig args + --help required-value agree → takesValue:true.
// - `--git-dir=<path>`, `--work-tree=<path>`, `--namespace=<name>`: Fig args + --help agree → takesValue:true.
// - `--exec-path`: Fig args {isOptional:true}, --help `[=<path>]` (attached-optional)
//   → verdict takesValue:false (attached `--exec-path=x` always applies; separate never
//   consumes — strict, never over-skips).
// - `--html-path`, `--man-path`, `--info-path`, `-p/--paginate`, `--no-pager`,
//   `--no-replace-objects`, `--no-optional-locks`, `--bare`, `--version`, `--help`:
//   Fig no-args + --help no-arity agree → takesValue:false.
// - Fig gaps filled by --help (Fig stale, missing): `-v` alias of `--version`,
//   `-h` alias of `--help`, `-P` alias of `--no-pager`, `--config-env=<name>=<envvar>`
//   (takesValue:true per --help arity text).
// - No Fig-`args` entries rejected outright in globals; `--exec-path` downgraded
//   to bool (above). Subcommand flags out of scope (globals table only;
//   unlisted-flag strict-always: subcommand flags never consume here, by design).

import type { CLIDescriptor } from "../../schema.ts";

/**
 * Git descriptor: policy mirrors the walker's
 * `DEFAULT_POSITION_POLICIES["git"]`; `-C`/`-c` handling matches
 * `./trackers/branch-tracker.ts`.
 *
 * Subcommand-scoped entries (issue #117 — all `--help`-pinned, see
 * each entry): the flags table is per-binary (flat), so push / reset /
 * commit entries share one map; the RULES scope them with `subcommand:`
 * (AND-composition keeps `git push --hard` out of `no-hard-reset`).
 *   - push: `force` (`-f` / `--force`), `forceWithLease`,
 *     `forceIfIncludes`, `mirror` — `git push -h`.
 *   - reset: `hard` — `git reset -h` (`--hard`: reset HEAD, index
 *     and working tree).
 *   - commit: `amend`, `message` (`-m` / `--message`, the table's only
 *     takesValue:true — `git commit -h`: `-m, --message <message>`).
 * `--force-with-lease[=<ref:expect>]` and `--force-if-includes` take
 * attached-optional values only → takesValue:false (the `--exec-path`
 * precedent).
 *
 * Referenced by name (never inlined) in the plugin literal so hover
 * rides on this const.
 */
export const GIT_CLI_DESCRIPTOR = {
  positionPolicy: "globals-before-only",
  flags: {
    version: { aliases: ["-v", "--version"], takesValue: false },
    help: { aliases: ["-h", "--help"], takesValue: false },
    C: { aliases: ["-C"], takesValue: true },
    config: { aliases: ["-c"], takesValue: true },
    execPath: { aliases: ["--exec-path"], takesValue: false },
    htmlPath: { aliases: ["--html-path"], takesValue: false },
    manPath: { aliases: ["--man-path"], takesValue: false },
    infoPath: { aliases: ["--info-path"], takesValue: false },
    paginate: { aliases: ["-p", "--paginate"], takesValue: false },
    noPager: { aliases: ["-P", "--no-pager"], takesValue: false },
    noReplaceObjects: { aliases: ["--no-replace-objects"], takesValue: false },
    noOptionalLocks: { aliases: ["--no-optional-locks"], takesValue: false },
    bare: { aliases: ["--bare"], takesValue: false },
    gitDir: { aliases: ["--git-dir"], takesValue: true },
    workTree: { aliases: ["--work-tree"], takesValue: true },
    namespace: { aliases: ["--namespace"], takesValue: true },
    configEnv: { aliases: ["--config-env"], takesValue: true },
    // Push force surface (issue #117; `git push -h`).
    force: { aliases: ["--force"], takesValue: false },
    forceShort: { aliases: ["-f"], takesValue: false },
    forceWithLease: { aliases: ["--force-with-lease"], takesValue: false },
    forceIfIncludes: {
      aliases: ["--force-if-includes"],
      takesValue: false,
    },
    mirror: { aliases: ["--mirror"], takesValue: false },
    // Reset surface (issue #117; `git reset -h`).
    hard: { aliases: ["--hard"], takesValue: false },
    // Commit surface (issue #117; `git commit -h`).
    amend: { aliases: ["--amend"], takesValue: false },
    message: { aliases: ["-m", "--message"], takesValue: true },
  },
} as const satisfies CLIDescriptor;
