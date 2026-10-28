// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * pi-steering-github — GitHub workflow rules for pi-steering.
 *
 * The "every PR must have at least one attached issue" policy for gh
 * CLI workflows, plus the napkin-vault body-file policy for PR and
 * issue bodies. Ported from the live prototype that ran in the global
 * pi-steering config (first live validation 2026-08-14, pi-steering
 * PR #46 session: create gate fired, agent complied in 7s) and shaped
 * after the pi-steering-flags precedent — the first official external
 * plugin:
 *
 *   - Package name: `pi-steering-<domain>` mirroring
 *     `@cad0p/pi-steering` core.
 *   - PeerDep on `@cad0p/pi-steering`; runtime dep on
 *     `@cad0p/pi-napkin` (the `./steering` subpath ships compiled JS
 *     since 0.7.0-20260814.0, so plain-node tests work).
 *   - One predicate exported as a `Plugin`; the rules, the pattern
 *     constants, and the arg helpers re-exported for unit tests and
 *     `when.condition` escape-hatch use.
 *
 * The plugin ships six rules, all STRICT (no `noOverride: false` —
 * the schema defaults fail-closed, so the policy is unconditional):
 *
 *   - `pr-body-from-vault-file`      — PR bodies come from vault
 *                                      body files under `<repo>/prs/`.
 *   - `pr-create-needs-issue-link`   — closing keyword + `#N` in
 *                                      BOTH title and body.
 *   - `pr-merge-needs-closing-keywords` — closing keyword + `#N` in
 *                                      the `--subject` value (`--help`/
 *                                      `--version`/GitHub `-h` read-only
 *                                      introspection never blocks).
 *   - `issue-body-from-vault-file`   — issue bodies come from vault
 *                                      body files under `<repo>/issues/`.
 *   - `gh-repo-create-needs-seed`    — `gh repo create|new` must
 *                                      carry a seed flag; a bare
 *                                      create births an EMPTY repo.
 *
 *   - `gh-repo-flag-before-subcommand` — an invocation carrying
 *                                      `-R x/y` into a gated
 *                                      `pr|issue …` mutation targets
 *                                      a FOREIGN repo — redirect
 *                                      (foreign subagent maintainer
 *                                      loop).
 *
 * See this package's README for usage examples and the per-rule
 * rationale, and the pi-steering README "Writing plugins" section for
 * the design rationale.
 *
 * `declare global` lives here (alongside the plugin definition) so
 * `import "@cad0p/pi-steering-github"` pulls the registry
 * augmentation in transitively — `when: { missingVaultBodyFile: … }`
 * typechecks in user configs without a separate type-only import.
 *
 * Layout mirrors the canonical `examples/work-item-plugin` shape
 * (ADR §15): the per-item rule / predicate / helper files live in
 * `./rules/`, `./predicates/`, `./helpers/`, and THIS module is the
 * single assembly point — it deep-imports the per-item files, builds
 * the `rules` roster (order = first-match-wins, see below) and the
 * plugin object, and re-exports the public surface.
 */

import type { Plugin, PredicateShape, Rule } from "@cad0p/pi-steering";
import {
  type InfoOnlyArgs,
  infoOnly,
  type RequiresFlagValueArgs,
  requiresFlagValue,
} from "@cad0p/pi-steering-flags";
import { GH_CLI_DESCRIPTOR } from "./descriptors.ts";
import { foreignRepoTarget } from "./predicates/foreign-repo-target.ts";
import { missingVaultBodyFile } from "./predicates/missing-vault-body-file.ts";
import { ghRepoCreateNeedsSeed } from "./rules/gh-repo-create-needs-seed.ts";
import { ghRepoFlagBeforeSubcommand } from "./rules/gh-repo-flag-before-subcommand.ts";
import { issueBodyFromVaultFile } from "./rules/issue-body-from-vault-file.ts";
import { prBodyFromVaultFile } from "./rules/pr-body-from-vault-file.ts";
import { prCreateNeedsIssueLink } from "./rules/pr-create-needs-issue-link.ts";
import { prMergeNeedsClosingKeywords } from "./rules/pr-merge-needs-closing-keywords.ts";

declare global {
  interface PiSteeringPredicates {
    /**
     * True when the command's `--body-file` is NOT a valid vault
     * body file for `args.section` (`"prs"` | `"issues"`):
     * absent, unreadable, outside a napkin vault (`.napkin/`
     * walk-up), or not under a `<repo>/<section>/` directory
     * (`<repo>` = origin URL basename, falling back to the cwd
     * folder name when the remote is unresolvable). Fail-closed:
     * anything unverifiable counts as missing.
     */
    missingVaultBodyFile: PredicateShape<{ section: "prs" | "issues" }>;
    /**
     * `when.foreignRepoTarget` — true (rule BLOCKS) when the
     * invocation carries an effective `-R/--repo` targeting a
     * FOREIGN repository (#39: PRESENCE of the flag, not its
     * position): the effective `-R`/`--repo` target's basename
     * differs from the cwd repo's basename. Backs
     * `gh-repo-flag-before-subcommand`. Flag access reads through
     * the bound `ctx.command` facade (glue + consumption from this
     * plugin's OWNED gh descriptor — #61).
     *
     * Fail-closed doctrine: an unparsable target (a valueless or
     * empty-valued LAST alias occurrence), a walker-unknown cwd, or
     * an unresolvable repo all BLOCK. Released without consulting
     * any knob: invocations carrying NO `-R`/`--repo` anywhere (they
     * fall through to the per-subcommand rules), and slashless
     * remote-name forms (`-R upstream`).
     *
     * Basename policy = fork→upstream tolerance (#19), hardcoded —
     * basename EQUALITY allows `gh -R upstream/foo pr create` from
     * inside the `me/foo` clone; there is deliberately no `matchBy`
     * / `flags` arg, the policy is documented, not configurable.
     *
     * Boolean-leaf shape (the `infoOnly` precedent — core
     * `BooleanLeafArgs`): bare `true` (or `{ value: true }`) enables
     * the gate and runs the argv logic; bare `false` NEVER fires
     * (disables the gate — deliberately NOT inverted).
     */
    foreignRepoTarget: PredicateShape<boolean>;
    /**
     * `when.infoOnly` — fires when the command IS an info-only
     * invocation (`--help` / `--version` + additive `extraFlags`).
     * Provided by `@cad0p/pi-steering-flags` (single source of truth
     * — re-exported here so this plugin's rules and existing user
     * configs keep the same key). Carve-out idiom:
     * `not: { infoOnly: … }` ALLOWS info-only invocations.
     */
    infoOnly: PredicateShape<boolean, InfoOnlyArgs>;
    /**
     * `when.requiresFlagValue` — fires when the LAST-wins value of
     * any listed alias is absent, valueless, or fails `matches`.
     * Provided by `@cad0p/pi-steering-flags` (single source of truth
     * — same key, same spread-only shape).
     */
    requiresFlagValue: PredicateShape<RequiresFlagValueArgs>;
  }
}

/**
 * The rules roster, in first-match-wins order (the engine routes on
 * the first matching rule): `gh-repo-flag-before-subcommand` FIRST
 * so the foreign redirect precedes every per-subcommand policy, then
 * `pr-body-from-vault-file` so the agent writes the vault body file
 * before fiddling with keywords, then the issue-link rule, then
 * merge, then the issue body-file rule, then
 * `gh-repo-create-needs-seed` LAST — appended, never reordered. The
 * `subcommand:` sets overlap by design (the foreign gate covers every
 * gated `pr|issue` sequence) — correctness rests on this order plus
 * release fall-through, not on disjointness. The `repo create|new`
 * sequences stay disjoint from the `pr|issue` ones. Reordering for
 * stylistic reasons changes which rule an agent sees when several
 * match; pinned via `src/index.test.ts` (roster order) and asserted
 * end-to-end in `src/integration.test.ts`.
 */
export const rules = [
  ghRepoFlagBeforeSubcommand,
  prBodyFromVaultFile,
  prCreateNeedsIssueLink,
  prMergeNeedsClosingKeywords,
  issueBodyFromVaultFile,
  ghRepoCreateNeedsSeed,
] as const satisfies readonly Rule[];

/**
 * The github plugin. Default export so `import githubPlugin from
 * "@cad0p/pi-steering-github"` gives you the whole thing.
 *
 * `as const satisfies Plugin` (rather than `: Plugin`) preserves the
 * literal `name: "github"` in the inferred type — the input to
 * `defineConfig`'s plugin-name / predicate-name inference (typo
 * checking on `disabledRules` / `disabledPlugins`).
 *
 * Rule order comes from `rules` (first-match-wins): the foreign
 * redirect runs FIRST, then the vault body-file rule so the agent
 * writes the body file before fiddling with keywords, then the
 * issue-link rule, then merge, then the issue body-file rule, then
 * `gh-repo-create-needs-seed` (its `repo create|new` sequences stay
 * disjoint from the `pr|issue` ones). See the `rules` doc comment
 * above for the rationale.
 */
export const githubPlugin = {
  name: "github",
  // Owns the gh CLI descriptor (closes #61): per-binary argv
  // knowledge for every `command: "gh"` rule — subcommand
  // extraction, the `flag:` leaf, and the bound `ctx.command`
  // facade all resolve through this table. Referenced by name
  // (never inlined) so hover rides on the const.
  cliDescriptors: { gh: GH_CLI_DESCRIPTOR },
  // `infoOnly` + `requiresFlagValue` are re-adopted from
  // `@cad0p/pi-steering-flags` (single source of truth — same `when`
  // key names, so rules and user configs are untouched).
  predicates: {
    missingVaultBodyFile,
    foreignRepoTarget,
    infoOnly,
    requiresFlagValue,
  },
  rules,
} as const satisfies Plugin;

export default githubPlugin;

export {
  type InfoOnlyArgs,
  infoOnly,
  type RequiresFlagValueArgs,
  requiresFlagValue,
} from "@cad0p/pi-steering-flags";
export { GH_CLI_DESCRIPTOR } from "./descriptors.ts";
export {
  renderDegradedReason,
  renderDiagnosedReason,
  renderSlottedRecipe,
  renderStaticRecipe,
} from "./helpers/body-file-reason.ts";
export { bodyHasClosingKeyword } from "./helpers/body-keyword.ts";
export {
  argText,
  countSubstitutionTokens,
  EXPECTED_SUBSTITUTION_TOKENS,
  explainBodyFileArg,
  findBodyFileRawValue,
  findBodyFileValue,
  findFlagValue,
  parseBodyFileArg,
  renderBodyFileDiff,
  resolveAgainstCwd,
  unquote,
} from "./helpers/pattern-args.ts";
// Named re-exports for consumers that want to pick pieces: the
// shipped rules (or the `rules` roster itself), the gh descriptor
// (the table owns every flag entry — read via
// `GH_CLI_DESCRIPTOR.flags.<key>`), the content-pattern constants
// (pinned by the unit tests), the predicate handler, and
// the arg helpers (`findBodyFileValue` / `parseBodyFileArg` parse the
// pinned perl substitution form) for `when.condition` escape-hatch
// use.
export {
  CLOSING_KEYWORD,
  ISSUE_REF,
} from "./helpers/patterns.ts";
export { foreignRepoTarget } from "./predicates/foreign-repo-target.ts";
export type {
  BodyFileDiagnosis,
  BodyFileSection,
} from "./predicates/missing-vault-body-file.ts";
export {
  BODY_STRIP,
  diagnose,
  missingVaultBodyFile,
} from "./predicates/missing-vault-body-file.ts";
export { ghRepoCreateNeedsSeed } from "./rules/gh-repo-create-needs-seed.ts";
export { ghRepoFlagBeforeSubcommand } from "./rules/gh-repo-flag-before-subcommand.ts";
export { issueBodyFromVaultFile } from "./rules/issue-body-from-vault-file.ts";
export { prBodyFromVaultFile } from "./rules/pr-body-from-vault-file.ts";
export { prCreateNeedsIssueLink } from "./rules/pr-create-needs-issue-link.ts";
export { prMergeNeedsClosingKeywords } from "./rules/pr-merge-needs-closing-keywords.ts";
