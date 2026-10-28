// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `branch` tracker for the git plugin.
 *
 * Models the effective git branch AT EACH extracted command within a
 * single `tool_call`. The motivating case is the ADR's
 * `git checkout A && git commit` example: a session-level
 * "current branch" query would miss the mid-command checkout and allow
 * the commit on what looks like a non-protected branch. A walker-backed
 * tracker folds the `git checkout` delta into the branch value seen by
 * the subsequent `git commit`, so a rule gated on
 * `when: { branch: /^main$/ }` correctly fires if the chain ends up on
 * `main`.
 *
 * Semantics:
 *   - `git checkout X`  - sequential; branch becomes `X` for the rest
 *     of this scope.
 *   - `git switch X`    - sequential; same as above.
 *   - `git checkout -b NEW` / `git switch -c NEW` - sequential; branch
 *     becomes `NEW`. The `-b` / `-c` token is consumed; the following
 *     argument is the new branch name.
 *   - Anything else under `git` (including `git commit`, `git status`,
 *     `git checkout -- FILE`) leaves the branch unchanged. Returning
 *     `current` (not `undefined`) is important: a `git commit` that
 *     happens to carry a non-static arg (e.g. `-m "$MSG"`) must NOT
 *     collapse branch state to `unknown`.
 *   - Non-static branch names (`git checkout $BR`, `git checkout "$BR"`)
 *     return `undefined`, which the walker translates to the tracker's
 *     `unknown` sentinel. Predicates then apply their `onUnknown`
 *     policy (default `"block"` - see the `branch` predicate handler).
 *
 * Subshells: `isolated` - a `(git checkout X)` inside parens cannot
 * change the enclosing shell's branch (real git semantics - the
 * subshell has no effect on the parent's working tree state for this
 * dimension).
 *
 * The tracker distinguishes two "I don't know the branch" states so
 * predicates can apply the correct policy:
 *
 *   - `initial: NO_CHECKOUT_IN_CHAIN` - no branch-changing modifier
 *     has fired in this ref's scope. The plugin cannot synchronously
 *     know the session's current branch at construction time; the
 *     `branch` predicate handler shells out via `ctx.exec("git",
 *     ["branch", "--show-current"])` to learn it. (A session-start
 *     prefetch is a reasonable future optimization but out of scope
 *     here.)
 *   - `unknown: "unknown"` - a modifier FIRED but couldn't resolve
 *     statically (e.g. `git checkout $VAR`). The predicate must NOT
 *     shell out in this case: `git branch --show-current` would
 *     return the PRE-checkout branch and silently defeat the
 *     walker's tracking. Predicates apply their `onUnknown` policy
 *     instead (default `"block"` -> fail-closed).
 *
 * The `NO_CHECKOUT_IN_CHAIN` sentinel is chosen to be a string that
 * cannot occur as a real git branch name (git refuses refs containing
 * `:`). Exported so tests and plugin authors can reference it; it
 * should never be constructed ad-hoc.
 *
 * ## Note for plugin authors
 *
 * This tracker is a canonical example of the strict Tracker contract -
 * unresolvable modifier targets return `undefined`, NOT `current`. The
 * built-in `cwdTracker.cd` modifier is a documented Phase-1 exception;
 * do not copy its "return current" shortcut in new trackers.
 */

import {
  isStaticallyResolvable,
  type Modifier,
  type Tracker,
} from "@cad0p/unbash-walker";

/**
 * Sentinel value for `branchTracker.initial` - marks "no branch-
 * changing modifier has fired in this ref's scope yet". Distinct
 * from the `"unknown"` sentinel (which marks "a modifier DID fire
 * but couldn't resolve statically"). See the file JSDoc for why the
 * distinction matters to the `branch` predicate's exec fallback
 * decision. The colon is chosen because git rejects it in branch
 * names, so this value cannot collide with a real branch.
 */
export const NO_CHECKOUT_IN_CHAIN = "pi-steering:no-checkout-in-chain";

/** Branch-changing git subcommands. */
const CHECKOUT_SUBCOMMANDS = new Set(["checkout", "switch"]);

/** `git checkout -b NEW` / `git switch -c NEW` - new-branch flags. */
const NEW_BRANCH_FLAGS = new Set(["-b", "-c"]);

/**
 * Sequential modifier that applies to every `git`-basename command.
 *
 * Returns the new branch for `checkout` / `switch` invocations;
 * returns `current` unchanged for every other git subcommand (so
 * `git commit -m "x"` does NOT collapse the branch to `unknown`);
 * returns `undefined` when the target branch name can't be resolved
 * statically.
 *
 * Pre-subcommand flags are skipped before we look at the subcommand
 * token. Git accepts `git -C PATH`, `git -c KEY=VAL`, `git --no-pager`,
 * `git --git-dir=/x`, `git --work-tree=/y`, `git --paginate`, etc.
 * before the subcommand. Without this skip, `git -C /other checkout
 * feat` would look at the `-C` flag as the subcommand, miss the
 * checkout, and silently bypass `no-main-commit`. This mirrors the
 * `applyGitCwd` flag scanner in `unbash-walker/src/trackers/cwd.ts`:
 * only `-C <path>` and `-c <key=value>` consume an additional token;
 * every other flag form (short cluster, long with or without attached
 * value) is a single token.
 */
const gitBranchModifier: Modifier<string> = {
  scope: "sequential",
  apply: (args, current) => {
    // Scan past pre-subcommand flags to find the real subcommand.
    // Known value-consuming flags: `-C <path>`, `-c <key=val>`.
    // Others (`--no-pager`, `--git-dir=/x`, `--work-tree=/y`,
    // `--paginate`, `-p`, etc.) are single tokens.
    let i = 0;
    while (i < args.length) {
      const tokWord = args[i];
      const tok = tokWord?.value ?? tokWord?.text ?? "";
      if (!tok.startsWith("-")) break; // found the subcommand
      if (tok === "-C" || tok === "-c") {
        i += 2;
        continue;
      }
      i++; // --long-flag, --long=value, or -shortcluster
    }

    // No subcommand - e.g. bare `git` or `git --help`. Branch unchanged.
    const subcmdWord = args[i];
    if (!subcmdWord) return current;
    const subcmd = subcmdWord.value ?? subcmdWord.text;
    if (!subcmd || !CHECKOUT_SUBCOMMANDS.has(subcmd)) return current;

    // `git checkout` / `git switch` with no further args: also a
    // help / error case. Leave branch alone.
    const firstArgWord = args[i + 1];
    if (!firstArgWord) return current;
    const firstArg = firstArgWord.value ?? firstArgWord.text;
    if (firstArg === undefined) return current;

    // `git checkout --help` / `git checkout -h` - help request, not a
    // branch change. Every other unrecognised flag form (e.g. `--`, `.`,
    // `--force`) still flows through the default branch-name path and
    // is accepted as a documented false-positive (see test cases).
    if (firstArg === "--help" || firstArg === "-h") return current;

    // `git checkout -b NEW` / `git switch -c NEW` - the branch
    // argument is at position i + 2.
    if (NEW_BRANCH_FLAGS.has(firstArg)) {
      const newBranchWord = args[i + 2];
      if (!newBranchWord) return current;
      if (!isStaticallyResolvable(newBranchWord)) return undefined;
      const newBranch = newBranchWord.value ?? newBranchWord.text;
      return newBranch === undefined ? current : newBranch;
    }

    // Plain `git checkout X` / `git switch X`. Note: `git checkout --
    // FILE` (restore path) is NOT a branch change, but the first arg
    // `--` happens to be statically resolvable AND `!= undefined`.
    // That's a false-positive corner we accept for Phase 4 - agents
    // rarely emit the `--` separator form, and the alternative
    // (hard-coding a `--` check) brittles against other pathspec
    // conventions. Follow-up if it bites.
    if (!isStaticallyResolvable(firstArgWord)) return undefined;
    return firstArg;
  },
};

/**
 * The branch tracker.
 *
 * Registered by the git plugin under `trackers.branch`. Walker-merged
 * with any future plugin wanting to extend branch semantics (though
 * the tracker name `branch` is expected to stay owned by the git
 * plugin - name collisions are a hard error per the plugin-merger).
 */
export const branchTracker: Tracker<string> = {
  initial: NO_CHECKOUT_IN_CHAIN,
  unknown: "unknown",
  modifiers: {
    git: gitBranchModifier,
  },
  subshellSemantics: "isolated",
};
