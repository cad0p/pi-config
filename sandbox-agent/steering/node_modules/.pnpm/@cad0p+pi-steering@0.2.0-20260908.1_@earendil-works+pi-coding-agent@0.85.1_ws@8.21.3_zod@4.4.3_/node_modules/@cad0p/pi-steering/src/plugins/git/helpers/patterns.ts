// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared protected-branch pattern for the git plugin's commit-on-main rules.
 *
 * `PROTECTED_BRANCH_PATTERN` is shared by `no-main-commit` and
 * `no-main-commit-github` so the protected-branch list stays uniform
 * across the rule family — adding an alias here (e.g. a vendor-specific
 * default-branch name) automatically propagates to both rules.
 *
 * `RegExp` (object) constant rather than a string source: that gives
 * true shared-reference pinning at the test layer
 * (`noMainCommit.when.branch === PROTECTED_BRANCH_PATTERN`), which
 * also catches a future inline of the SAME bytes at a rule's
 * definition site.
 */
export const PROTECTED_BRANCH_PATTERN = /^(main|master|mainline|trunk)$/;
