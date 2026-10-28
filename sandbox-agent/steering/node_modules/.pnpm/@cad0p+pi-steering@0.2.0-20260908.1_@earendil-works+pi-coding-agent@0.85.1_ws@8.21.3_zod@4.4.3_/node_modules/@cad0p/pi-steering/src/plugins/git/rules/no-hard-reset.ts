// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-hard-reset` rule for the git plugin — the working-tree-destroying
 * reset guard.
 *
 * Moved out of the engine's former default-rule bundle (issue #72): every
 * destructive-command rail now lives in the domain plugin that owns
 * its surface. The reason text is byte-identical to the 0.2.0 default.
 * Override-comment eligible.
 */

import type { Rule } from "../../../schema.ts";
import { GIT_CLI_DESCRIPTOR } from "../descriptors.ts";

/**
 * `no-hard-reset` - block `git reset --hard` in any form.
 */
export const noHardReset = {
  name: "no-hard-reset",
  tool: "bash",
  command: "git",
  // Routing is `command: "git"` + `subcommand: "reset"` (the
  // descriptor's consuming-flag arity keeps `git -C /other reset
  // --hard` and `git -c key=val reset --hard` routed — the old
  // pre-subcommand flag slot). `--hard` is `--help`-pinned
  // (`git reset -h`: `--hard`: reset HEAD, index and working tree).
  when: {
    subcommand: "reset",
    // `--hard` referenced BY VARIABLE from the owning plugin's table
    // (never a hand-built literal in the rule — a duplicated literal
    // can skew from the table into silent fail-open).
    flag: { anyOf: [GIT_CLI_DESCRIPTOR.flags.hard] },
  },
  reason:
    "Hard reset discards uncommitted changes permanently. Use `git stash` to save work first, or `git reset --soft` to keep changes staged.",
} as const satisfies Rule;
