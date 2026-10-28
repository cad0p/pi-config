// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-main-commit-github` rule for the git plugin — the github.com
 * specialization of {@link noMainCommit} emitting PR-flow guidance.
 */

import type { Rule } from "../../../schema.ts";
import { PROTECTED_BRANCH_PATTERN } from "../helpers/patterns.ts";
import { walkerString } from "../predicates/branch.ts";
import { NO_CHECKOUT_IN_CHAIN } from "../trackers/branch-tracker.ts";

/**
 * `no-main-commit-github` — block direct commits to a protected
 * branch (main / master / mainline / trunk) on github.com clones.
 * Specialization of {@link noMainCommit} that emits PR-flow guidance
 * instead of the generic feature-branch reminder.
 *
 * Pairs with {@link noMainCommit}: this rule is more specific (adds
 * `remote:` check), placed BEFORE `noMainCommit` in the plugin's
 * rule array so first-match-wins routing surfaces the github-
 * flavored reason on github clones. Non-github contexts (Brazil
 * packages, vault paths, /tmp scratch repos with non-github remotes)
 * fall through to the generic `noMainCommit`.
 *
 * Strict (non-overridable, issue #79): inline `# steering-override:`
 * comments are ignored. User can:
 *   - Disable: `disabledRules: ["no-main-commit-github"]`
 *   - Customize: see gitPlugin's README "Customization" section
 *
 * @remarks Both `https://github.com/...` and `git@github.com:...`
 *          clone URLs are matched (the `remote:` regex's `[/:]`
 *          character class accepts both the HTTPS path separator
 *          and the SSH user-host separator).
 *
 * @remarks `remote:` is configured as `{ pattern, onUnknown: "allow" }`.
 *          The `onUnknown: "allow"` argument governs the case where
 *          the walker resolved cwd but the inner exec couldn't
 *          determine the remote URL — i.e. a known-cwd repo with no
 *          `origin` remote configured (fresh-init, repo with
 *          `upstream` but no `origin`, or other exec failure). In that
 *          case the predicate skips and the engine falls through to
 *          the generic `noMainCommit` (correct generic message).
 *          The branch predicate stays at default `onUnknown: "block"`
 *          (fail-closed) so protected-branch detection isn't weakened.
 *
 * Walker-unknown cwd: the `remote:` leaf surfaces trinary
 * `"unknown"` (via the inline walker-unknown-cwd guard at the top of
 * the handler) before the inner exec runs whenever
 * `walkerState.cwd === "unknown"`. The engine's leaf-level
 * `onUnknown:` policy reads the `"allow"` set on the leaf, projects
 * `"unknown" → false`, and the github rule SKIPS. The engine then
 * falls through to the generic {@link noMainCommit} (only `branch:`
 * leaf), which fires fail-CLOSED and emits the generic
 * protected-branch reason. The github-specific rule deliberately
 * does NOT fire under walker-unknown cwd — a github-flavored reason
 * would overstate what the engine has confirmed.
 *
 * Walker-unknown branch state: when `walkerState.cwd` is known but
 * the branch tracker collapses to its `"unknown"` sentinel (dynamic
 * checkout the walker couldn't resolve), the reason fn routes to a
 * "could not verify the current branch" message rather than
 * asserting a specific protected branch the engine hasn't
 * confirmed.
 *
 * Routing is shared with {@link noMainCommit} via the same
 * `command: "git"` + `subcommand: "commit"` pair, so the two rules'
 * bash-command applicability stays byte-equal as the family evolves.
 *
 * @see {@link noMainCommit}
 */
export const noMainCommitGithub = {
  name: "no-main-commit-github",
  tool: "bash",
  command: "git",
  // Routing is `command: "git"` + `subcommand: "commit"` (the
  // old `GIT_COMMIT_PATTERN` anchor, deleted with bash `pattern:`).
  when: {
    subcommand: "commit",
    branch: PROTECTED_BRANCH_PATTERN,
    // Intentional fail-OPEN — falls through to the generic
    // `noMainCommit` rule when origin can't be resolved.
    //
    // `onUnknown: "allow"` posture: a github-specialized rule
    // should only fire when github context is confirmed. The
    // `"allow"` covers two opt-out paths:
    //   1. Known-cwd no-`origin` case (fresh-init repo, repo with
    //      `upstream` but no `origin`, or other exec failure):
    //      handler returns `false`, leaf projects to false, github
    //      rule skips. Generic `noMainCommit` fires next — user
    //      gets the correct generic message rather than PR-flow
    //      guidance for a repo where there's no PR to open.
    //   2. Walker-unknown cwd (`cd "$VAR" && git commit`): the
    //      handler's inline guard surfaces trinary `"unknown"`,
    //      the leaf-level `"allow"` projects to false, github rule
    //      skips. Generic `noMainCommit` fires fail-CLOSED via the
    //      branch predicate's default `onUnknown: "block"`.
    // Both paths land on the same generic protected-branch reason,
    // avoiding overstated github-specific claims when context is
    // unverified.
    remote: { pattern: /github\.com[/:]/, onUnknown: "allow" },
  },
  reason: (ctx) => {
    // Walker-unknown branch: protected-branch unverified. Don't
    // make a positive claim about which protected branch is
    // involved.
    //
    // (CWD is always known in this rule's reason fn — `remote:`'s
    //  `onUnknown: "allow"` projects walker-unknown CWD to false at
    //  the leaf level, so the rule skips to the generic
    //  `noMainCommit` before this reason fn runs.)
    const branchRes = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
    if (branchRes.kind === "unknown") {
      return (
        `Could not verify the current branch — your command used a ` +
        `dynamic checkout target (\`git checkout $VAR\`) that ` +
        `couldn't be statically resolved. If you're on a protected ` +
        `branch (main / master / mainline / trunk) on a github ` +
        `clone, open a PR for review instead of committing directly.` +
        `\n\n` +
        `Safety: NEVER merge a PR or mark it ready-for-review unless ` +
        `the user explicitly asks. Wait for explicit user instruction.`
      );
    }
    // Reuse the same walkerString-based branch interpolation idiom
    // noMainCommit's reason fn uses (single source of truth for
    // tracker-sentinel semantics).
    const branch =
      branchRes.kind === "value" && branchRes.value !== ""
        ? branchRes.value
        : undefined;
    const onClause = branch !== undefined ? ` You are on '${branch}'.` : "";
    // Prose says "protected branch" rather than "main branch":
    // the `when:` clause matches all four protected branch names
    // (main / master / mainline / trunk). Mirrors
    // `noMainCommit`'s wording, which lists them.
    return (
      `You're on a github clone's protected branch.${onClause} Open ` +
      `a PR for review; \`gh pr merge\` lands the change after ` +
      `approval. Direct commits to a protected branch bypass review ` +
      `and break PR discipline.` +
      `\n\n` +
      `Safety: NEVER merge a PR or mark it ready-for-review unless ` +
      `the user explicitly asks. Wait for explicit user instruction.`
    );
  },
  // Explicit strict: non-overridable (issue #79) — mirrors
  // `noMainCommit`. Explicit field pins this even against config
  // `defaultNoOverride: false`.
  noOverride: true,
} as const satisfies Rule;
