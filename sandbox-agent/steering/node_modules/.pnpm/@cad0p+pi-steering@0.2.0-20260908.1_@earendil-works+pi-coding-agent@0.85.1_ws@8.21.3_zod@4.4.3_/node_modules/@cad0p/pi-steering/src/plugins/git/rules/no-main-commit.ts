// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-main-commit` rule for the git plugin — the generic
 * commit-on-protected-branch guard.
 */

import type { Rule } from "../../../schema.ts";
import { PROTECTED_BRANCH_PATTERN } from "../helpers/patterns.ts";
import { walkerString } from "../predicates/branch.ts";
import { NO_CHECKOUT_IN_CHAIN } from "../trackers/branch-tracker.ts";

/**
 * `no-main-commit` - block direct commits to a protected branch
 * (main / master / mainline / trunk).
 *
 * Fires on:
 *   - `git commit -m "..."` when the current branch is one of the
 *     protected names,
 *   - `git checkout main && git commit ...` (the branch tracker folds
 *     the checkout into the branch state for the commit),
 *   - `sh -c 'git commit ...'` (wrapper expansion),
 *   - `git -C /other commit ...` where the repo at `/other` is on
 *     main (the `branch` predicate queries git at the effective cwd).
 *
 * Does NOT fire on:
 *   - `git commit` while on a feature branch,
 *   - `git log --grep="commit"` (anchored to `git commit`, not
 *     arbitrary git subcommands),
 *   - `echo 'git commit -m "x"'` (extraction anchors to the
 *     basename).
 *
 * Fail-closed on unresolvable branch: if the branch predicate can't
 * determine the current branch (detached HEAD, not a repo, or the
 * tracker collapsed to `unknown` via `git checkout $VAR`), the rule
 * fires by default. Authors who want the allow-through behavior
 * supply the object form explicitly:
 *
 *   `when: { branch: { pattern: /.../, onUnknown: "allow" } }`
 *
 * Reason text is dynamic via {@link ReasonFn}: when the branch
 * tracker has resolved a concrete branch name for the guarded
 * command (statically from a `git checkout <name>` earlier in the
 * chain), the name is injected into the block message so the agent
 * sees "You are on 'main'" instead of a generic reminder. The
 * ReasonFn filters out the tracker's internal sentinels
 * (`NO_CHECKOUT_IN_CHAIN` — no in-chain checkout, exec-fallback
 * path; `"unknown"` — dynamic checkout the walker couldn't
 * resolve) so those strings never leak into the agent-facing
 * message; the static actionable tail still guides the agent to a
 * feature branch in those cases.
 *
 * Pairs with {@link noMainCommitGithub} (specialization for
 * github.com clones, placed BEFORE this rule in the rule array so
 * first-match-wins routes the github-flavored guidance to github
 * users; non-github contexts fall through to this generic rule).
 *
 * Strict (non-overridable) since issue #79: inline
 * `# steering-override:` comments are ignored. The override path
 * defeated this guard exactly when it mattered — agents stacked
 * override comments to force commits onto whatever ref was checked
 * out (an incident landed a commit on local `main`), and the
 * exact-name + fall-through traps made overrides a copy-paste hazard
 * (overriding one rule falls through to its twin). Escape valves
 * live at the config layer instead: disable via `disabledRules`,
 * redeclare a same-name rule in the project layer, or scope a
 * cwd-based exemption — see the plugin README's Customization /
 * Cwd-based exemption sections.
 */
export const noMainCommit = {
  name: "no-main-commit",
  tool: "bash",
  command: "git",
  // Routing is `command: "git"` + `subcommand: "commit"` (the
  // old `GIT_COMMIT_PATTERN` anchor, deleted with bash `pattern:`).
  when: { subcommand: "commit", branch: PROTECTED_BRANCH_PATTERN },
  reason: (ctx) => {
    // Delegate the sentinel classification to `walkerString` — the
    // same three-way discrimination (value / unknown / missing)
    // every other branch-consumer in this plugin uses. Single source
    // of truth for tracker-sentinel semantics; future sentinel
    // additions update one site (the classifier in predicates/branch.ts),
    // not this filter too. Empty-string remains filtered inline as
    // a defensive check against future tracker contracts (detached
    // HEAD or similar); the branch tracker doesn't emit it today.
    const res = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
    const branch =
      res.kind === "value" && res.value !== "" ? res.value : undefined;
    const onClause = branch !== undefined ? ` You are on '${branch}'.` : "";
    return (
      `Don't commit directly to a protected branch ` +
      `(main / master / mainline / trunk).${onClause} ` +
      `Create a feature branch first: \`git checkout -b feat/...\`.`
    );
  },
  // Explicit strict: non-overridable (issue #79) — inline override
  // comments are ignored. Explicit field pins this even against
  // config `defaultNoOverride: false`.
  noOverride: true,
} as const satisfies Rule;
