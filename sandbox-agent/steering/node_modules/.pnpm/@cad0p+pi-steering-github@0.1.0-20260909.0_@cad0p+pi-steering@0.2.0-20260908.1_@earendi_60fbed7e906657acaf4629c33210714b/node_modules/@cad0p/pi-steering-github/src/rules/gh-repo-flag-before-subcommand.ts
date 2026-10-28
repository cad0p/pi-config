// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `gh-repo-flag-before-subcommand` — a gated `pr|issue …` mutation
 * carrying `-R/--repo` targets a FOREIGN repo and must be redirected
 * to the foreign repo's own config: run a foreign subagent
 * maintainer loop until good, then cd into the foreign repo and
 * target it from there. This is the ENTRY step of the foreign flow —
 * FIRST in the roster: its `subcommand:` set OVERLAPS the pr/issue
 * body/create/merge sets (every gated subcommand routes here in ANY
 * flag position — both `-R` positions since #39, unbounded leading
 * pairs since #41, now structural via the descriptor's consuming-flag
 * arity instead of the retired `LEADING_FLAG_PAIRS` shape router),
 * so correctness rests on the evaluator's first-firing-rule-wins
 * ordering plus RELEASE FALL-THROUGH — the `foreignRepoTarget`
 * predicate releases every command without a foreign target and the
 * per-subcommand rules evaluate normally — not on subcommand
 * disjointness.
 *
 * Fires on `pr create|new|edit|merge` and `issue create|edit` only
 * (`repo create|new` is excluded by design — nothing to cd into, the
 * target is the positional argument; that exclusion is about THIS
 * foreign gate only and is NOT a policy bypass: the seed rule gates
 * repo-create forms. Read-only forms stay allowed).
 * Repo-targeting is decided by PRESENCE of `-R/--repo` (#39): absent
 * → release (fall-through); present-but-unparsable → fail-closed
 * block; slashless `-R upstream` → release (fork remote-name form).
 *
 * Fully declarative gate — zero condition code (issue #36). The
 * `subcommand:` leaf routes, two leaves compose as an AND of
 * independent registered predicates:
 *
 * - `not.infoOnly({ extraFlags: ["-h"] })` exempts read-only
 *   introspection: the flags plugin's `--help`/`--version` defaults
 *   PLUS GitHub's additive `-h` (token-level, quote-aware — quoted
 *   values can't falsely exempt). Accepted exposure: a gated
 *   invocation carrying `--version` (bare or attached) is now
 *   ALLOWED — gh errors on it for pr/issue subcommands, so nothing
 *   real can happen; `-v` is NOT in the default set and stays
 *   gated.
 * - `foreignRepoTarget: true` — this package's registered
 *   predicate: blocks when the effective `-R`/`--repo` target is a
 *   FOREIGN repo. The basename compare is hardcoded policy (#19):
 *   basename equality allows the fork→upstream contribution flow
 *   (`gh -R upstream/foo pr create` from the `me/foo` clone); cost
 *   accepted: `-R <own-repo> pr merge` from inside the repo is
 *   indistinguishable and slips through — heuristic discipline, not
 *   security. Fail-closed: unknown cwd / unresolvable repo /
 *   unparsable target → block.
 *
 * AND-of-leaves order-independence (confirmed during #23):
 * help/version invocations short-circuit ALLOW via the not-leaf
 * without consulting the predicate — byte-equivalent to the old
 * early-return ordering. A `--help` inside a QUOTED VALUE
 * (`--subject "see --help"`) does NOT exempt a real gated command
 * (token-level walker argv underneath both leaves).
 *
 * Reason is a `ReasonFn` — the plugin's first dynamic reason: the
 * redirect text renders from the RESOLVED `-R/--repo` target (the
 * single source of truth shared with the predicate; unparsable
 * targets get an honest fallback phrase — as-typed echo fidelity
 * was deliberately dropped with the mirror scan it required).
 *
 * Strict — no override (schema default).
 */

import type { PredicateContext, Rule } from "@cad0p/pi-steering";
import { effectiveRepoTarget } from "../predicates/foreign-repo-target.ts";

export const ghRepoFlagBeforeSubcommand = {
  name: "gh-repo-flag-before-subcommand",
  tool: "bash",
  command: "gh",
  when: {
    subcommand: {
      anyOf: [
        ["pr", "create"],
        ["pr", "new"],
        ["pr", "edit"],
        ["pr", "merge"],
        ["issue", "create"],
        ["issue", "edit"],
      ],
      onUnknown: "allow",
    },
    not: { infoOnly: { extraFlags: ["-h"] } },
    foreignRepoTarget: true,
  },
  reason: (ctx: PredicateContext) => foreignRepoReason(ctx),
} as const satisfies Rule;

/**
 * The dynamic block reason for `gh-repo-flag-before-subcommand`:
 * renders the EFFECTIVE `-R`/`--repo` target via the SAME
 * `effectiveRepoTarget` call the predicate's verdict used — single source
 * of truth, so the redirect always names where to cd (LAST-wins across the
 * aliases, glue-aware, OTHER-consumed values skipped). As-typed flag-echo
 * fidelity is dropped deliberately (#39): a blocked command is never re-run
 * verbatim; the reader needs WHERE to cd, and an unparsable target
 * renders the honest fallback phrase instead of echoing a flag
 * spelling. Never throws — the helper is total over argv.
 */
export function foreignRepoReason(ctx: PredicateContext): string {
  const target = effectiveRepoTarget(ctx);
  const via =
    target !== null && target !== ""
      ? `via ${target}`
      : "via an unresolvable -R/--repo";
  // The subcommand is the FIRST `pr`/`issue` positional. The facade's
  // positional view already skips declared consuming-flag values, so
  // a single-word `--title pr` value can no longer mislabel the noun
  // (the old argv scan's accepted display-only limitation, narrowed
  // to undeclared-flag values only).
  const sub =
    ctx.command.positionals().find((w) => w === "pr" || w === "issue") ?? "";
  const what = sub === "pr" ? "PR" : "issue";
  return (
    `The ${what} you're targeting ${via} belongs to a foreign repo.\n` +
    `REQUIREMENT: run a foreign subagent maintainer loop until good,\n` +
    `then cd into the foreign repo and target it from there.`
  );
}
