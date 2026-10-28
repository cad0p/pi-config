// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-force-push` rule for the git plugin — the remote-history-rewrite
 * guard.
 *
 * Moved out of the engine's former default-rule bundle (issue #72): every
 * destructive-command rail now lives in the domain plugin that owns
 * its surface. The reason text is byte-identical to the 0.2.0 default,
 * including the issue #65 sealing (every remote-history-rewrite form
 * blocked). Override-comment eligible.
 */

import type { Rule } from "../../../schema.ts";

/**
 * `no-force-push` - block every remote-history-rewrite push form.
 */
export const noForcePush = {
  name: "no-force-push",
  tool: "bash",
  command: "git",
  // Routing is `command: "git"` (exact basename — `echo 'git push
  // --force'` has basename `echo` and never matches) + `subcommand:
  // "push"` (the descriptor's consuming-flag arity keeps `git -C
  // /path push`, `git -c key=val push`, `git --git-dir=/x push`
  // routed — the old pre-subcommand flag slot). The force signal is
  // the registered `isForcePush` predicate (flag-forms OR
  // leading-`+` refspec-forms composed inside the one named concept,
  // per ADR §13 — the AND-only leaves cannot express the OR, so it
  // gets a name, never an inline `condition:`). Merge-gate pins live
  // in `./no-force-push.test.ts`.
  when: {
    subcommand: "push",
    isForcePush: true,
  },
  reason:
    "Force pushes rewrite remote history and can destroy teammates' work. Create a new commit instead, or ask the user to run one manually.",
} as const satisfies Rule;
