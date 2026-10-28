// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

// ---------------------------------------------------------------------------
// Content-pattern constants (public export — pinned by the unit tests)
// ---------------------------------------------------------------------------
//
// Command routing is structural now (`command: "gh"` + `when.subcommand`
// sequences on the rules — core #117, closes #55): the `^gh\s+` anchor
// family (`LEADING_FLAG_PAIRS`, `PR_BODY_ANCHOR`, `PR_CREATE_ANCHOR`,
// `PR_MERGE_ANCHOR`, `ISSUE_BODY_ANCHOR`, `REPO_CREATE_ANCHOR`,
// `REPO_FLAG_ANCHOR`, `REPO_CREATE_PATTERN`, `REPO_CREATE_SEED_FLAG`)
// is retired. What remains here are the VALUE-content patterns the
// keyword rules test flag values against.
//
// The flag+value-region builders (`TITLE_WITH_REF`, `SUBJECT_WITH_REF`,
// `BODY_WITH_REF` — flag spellings smuggled as string literals) are
// retired too: keyword checks extract the value through the bound
// facade (`ctx.command.getFlagValue(ghFlags.<key>)`) and test
// `ISSUE_REF` against the extracted value — whole-value, last-wins,
// quote-aware, no truncation. This module stays CONTENT-ONLY.

/**
 * Closing-keyword family GitHub recognizes (docs: "Linking a pull
 * request to an issue"). Covers close/closes/closed, fix/fixes/fixed,
 * resolve/resolves/resolved.
 */
export const CLOSING_KEYWORD =
  "(?:close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)";

/**
 * A closing-keyword issue reference: `Closes #10`, `Closes: #10`,
 * `CLOSES #10` (colon optional, case-insensitive at use).
 */
export const ISSUE_REF = `${CLOSING_KEYWORD}\\s*:?\\s*#\\d+`;
