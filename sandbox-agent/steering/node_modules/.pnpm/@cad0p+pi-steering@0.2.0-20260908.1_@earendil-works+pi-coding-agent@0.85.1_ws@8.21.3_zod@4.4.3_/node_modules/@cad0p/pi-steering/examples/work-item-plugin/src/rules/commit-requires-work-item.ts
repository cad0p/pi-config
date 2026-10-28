// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `commit-requires-work-item` — example rule.
 *
 * Demonstrates:
 *   - A plugin-registered predicate (`workItemFormat`) in use from a
 *     rule's `when.*` slot.
 *   - `when.not` for inversion — the predicate reports "the commit
 *     message MATCHES `[PROJ-N]`" (positive), so we wrap it in `not`
 *     to get "the message does NOT match" (the firing condition).
 *   - The typed-arg authoring pattern — `{ pattern: /\[PROJ-\d+\]/ }`.
 *   - Routing on `command: "git"` + `subcommand: "commit"` plus the
 *     `-m` flag entry, so `git log --grep "commit"` doesn't
 *     spuriously match.
 *
 * Semantics:
 *   - Fires on `git commit [...] -m <msg>` where `<msg>` does NOT
 *     contain a `[PROJ-N]` token.
 *   - The predicate's fallback path keeps us safe: if someone writes
 *     a commit with no `-m` reachable (e.g. `git commit
 *     --file /tmp/msg.txt`), the predicate falls back to
 *     pattern-matching the whole command — which will miss, so
 *     `not` makes this rule FIRE. That's the conservative default
 *     for a plugin whose whole purpose is "require a ticket".
 *
 * Override: allowed (workflow rule, not inherent-destructive). The
 * engine's default is `noOverride: true`; rule authors opt out
 * explicitly.
 */

import type { Rule } from "@cad0p/pi-steering";
import { GIT_CLI_DESCRIPTOR } from "@cad0p/pi-steering/plugins/git";

export const commitRequiresWorkItem = {
  name: "commit-requires-work-item",
  tool: "bash",
  command: "git",
  // Routed on `git` + `commit` with the `-m` / `--message` flag
  // entry (the old `/^git\\s+commit\\b.*-m\\s/` anchor — the
  // pre-subcommand flag slot like `git -C /other commit …` rides
  // the descriptor's consuming-flag arity). The git plugin's
  // `no-main-commit` rule in the package shows the production form.
  when: {
    subcommand: "commit",
    // `-m` / `--message` referenced BY VARIABLE from the owning
    // plugin's table (never a hand-built literal in the rule).
    flag: { anyOf: [GIT_CLI_DESCRIPTOR.flags.message] },
    // Invert the predicate: fire when the work-item tag is MISSING.
    not: {
      // The plugin-registered `workItemFormat` predicate — see
      // ../predicates/work-item-format.ts. `[PROJ-N]` is the
      // placeholder — a real adopter replaces with e.g.
      // `[PROJECT-\d+]` / `[JIRA-\d+]`.
      workItemFormat: { pattern: /\[PROJ-\d+\]/ },
    },
  },
  reason:
    "Commit messages must reference a work item ticket, e.g., [PROJ-123].",
  noOverride: false,
} as const satisfies Rule;
