// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `cwd` tracker extensions for the git plugin.
 *
 * The built-in `cwdTracker` (in unbash-walker) handles `git -C DIR
 * subcmd`. Two narrower git flags - `--git-dir=/path` and
 * `--work-tree=/path` - express the same "run this command as if the
 * working directory were /path" intent, but weren't modelled in the
 * walker's core to keep its git knowledge minimal. Parsing them lives
 * in the git plugin as a tracker extension: registered under
 * `trackerExtensions.cwd.git`, the modifier layers on top of the core
 * cwd tracker's own `git` per-command modifier.
 *
 * Scope is `per-command` - consistent with `-C` and git's own runtime
 * behavior: these flags affect only the command they're attached to.
 *
 * Composition with `-C`:
 *
 *   `git -C /a --git-dir=/b status`
 *
 * The plugin-merger appends this extension's modifier AFTER the core
 * `-C` modifier under the same basename. The walker then runs BOTH
 * modifiers left-to-right against the same arg list, each layering
 * its own contribution on top of the running recorded value:
 *
 *   1. Core `-C /a` modifier (scans pre-subcommand flags only):
 *        running cwd "/initial" -> "/a"
 *   2. This `--git-dir=/b` modifier (scans all args for the two
 *      specific flag forms):
 *        running cwd "/a"        -> "/b"
 *
 * The LATER modifier wins on absolute paths; for relative paths it
 * joins against the running value from the previous step. Test
 * expectation for `git -C /a --git-dir=b status` is `/a/b`.
 *
 * Order in the source matters too:
 *
 *   - `git --git-dir=/b -C /a status` -> `/b` (core `-C` runs on
 *     the pre-sequential value `/initial`, producing `/a`; then
 *     this modifier runs against the same args, overriding to
 *     `/b`).
 *   - `git -C /a --git-dir=/b status` -> `/b` (same left-to-right
 *     modifier order; the core scanner produces `/a`, this one
 *     overrides to `/b`).
 *
 * In both cases the `--git-dir=` / `--work-tree=` flags win, matching
 * git's documented precedence.
 *
 * Known limitations:
 *
 *   - `--git-dir` without an `=` (space-separated form:
 *     `git --git-dir /path ...`) is NOT handled. Both git and shell
 *     tokenize this as two words; walker modifiers today only see the
 *     single `--git-dir` token. Wiring a two-token form is possible
 *     but agents overwhelmingly emit the `=` form; follow-up.
 *   - Non-static targets (`--git-dir=$VAR`) return `undefined`,
 *     collapsing the per-command cwd to `"unknown"`. Predicates then
 *     apply `onUnknown`.
 *   - `--work-tree` without `--git-dir` is semantically incomplete in
 *     real git (the gitdir still points at the default), but for cwd
 *     tracking purposes we treat them identically - they both mean
 *     "the command's effective cwd is this path". If a rule author
 *     needs the distinction (e.g. a repo-path vs tree-path
 *     predicate), they can split it in their own plugin.
 *
 * Known accepted false-positives:
 *
 *   - `git log --git-dir=/repo` -> cwd recorded as /repo. Real git
 *     treats post-subcommand `--git-dir=` as a pathspec, not a
 *     global flag. Over-match rate is low in practice (agents emit
 *     `git --git-dir=/x log`, not the inverse), and stopping the
 *     scan at the first non-flag token would break composition with
 *     the core `-C` modifier which iterates the same args list.
 *     Accepted as a Phase-4 corner.
 *   - `git diff -- --git-dir=/x` -> cwd recorded as /x. Arguments
 *     after `--` are always pathspecs in real git. Same mitigation
 *     rationale as above; stopping the scan at `--` would still
 *     need to run after the core `-C` scanner has finished, not
 *     before, to avoid the composition breakage.
 */

import * as path from "node:path";
import { isStaticallyResolvable, type Modifier } from "@cad0p/unbash-walker";
import type { Word } from "unbash";

/** Regex matched against each `git`-command argument token. */
const GIT_DIR_RE = /^--git-dir=(.+)$/;
const WORK_TREE_RE = /^--work-tree=(.+)$/;

/**
 * Read a word's static value. Falls back to `text` when `value`
 * isn't materialised (pure literal fast path in unbash).
 */
function wordValue(w: Word | undefined): string | undefined {
  return w?.value ?? w?.text;
}

/**
 * Scan git's pre-subcommand flags for `--git-dir=DIR` / `--work-tree=DIR`
 * and layer the target on top of the current cwd.
 *
 * Stops at the first non-flag token (the subcommand) - identical shape
 * to the core `-C` scanner. Multiple occurrences compose left-to-right
 * (an absolute path replaces, a relative path joins to the running
 * cwd). If we encounter a target we can't statically resolve, we bail
 * returning `undefined`; the walker translates that to the cwd
 * tracker's `"unknown"` sentinel.
 */
const gitCwdExtension: Modifier<string> = {
  scope: "per-command",
  apply: (args, current) => {
    let cwd = current;
    // Scan ALL args (not just pre-subcommand): we match only the two
    // specific flag forms `--git-dir=X` / `--work-tree=X`, so there's
    // no ambiguity with subcommand arguments. `git log
    // --grep="--git-dir=foo"` is safe because the quoted string is a
    // SINGLE argument whose text starts with `--grep`, not
    // `--git-dir`, so the regex doesn't match.
    //
    // A stop-at-non-flag scan (mirroring the core `-C` modifier)
    // would break composition with `-C`: the walker runs this
    // modifier AGAINST THE SAME args the core `-C` modifier saw, not
    // a reduced arg list. On `git -C /a --git-dir=/b status`, the
    // args are still `[-C, /a, --git-dir=/b, status]`; a stop-at-
    // non-flag scan would terminate at `/a` (the value of `-C`,
    // which doesn't start with `-`) and miss the `--git-dir=` flag.
    for (const w of args) {
      const tok = wordValue(w);
      if (tok === undefined) continue;

      const gitDirMatch = tok.match(GIT_DIR_RE);
      const workTreeMatch = tok.match(WORK_TREE_RE);
      const match = gitDirMatch ?? workTreeMatch;
      if (!match) continue;

      // `--git-dir=$VAR` / `--work-tree=$(...)` - the captured
      // piece is there in the raw text, but the overall Word is
      // non-static. Refuse to invent a value.
      if (!isStaticallyResolvable(w)) return undefined;

      const target = match[1];
      if (target === undefined || target.length === 0) continue;
      cwd = path.isAbsolute(target) ? target : path.join(cwd, target);
    }
    return cwd;
  },
};

/**
 * Modifiers the git plugin registers under `cwd.git`. Exposed as an
 * array so the plugin merger sees each entry distinctly; the runtime
 * could today also accept a single modifier, but the array form
 * leaves room for future git-specific cwd tweaks without changing
 * the plugin manifest.
 */
export const gitCwdExtensions: readonly Modifier<unknown>[] = [
  gitCwdExtension as Modifier<unknown>,
];
