// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-rm-rf-slash` rule for the rm plugin — the recursive-force-delete-
 * from-root guard.
 *
 * Moved out of the engine's former default-rule bundle (issue #72): every
 * destructive-command rail now lives in the domain plugin that owns
 * its surface. The reason text is byte-identical to the 0.2.0 default,
 * including the `noOverride: true` seal.
 */

import type { Rule } from "../../../schema.ts";

/**
 * `no-rm-rf-slash` - block recursive force-deletes rooted at `/`.
 */
export const noRmRfSlash = {
  name: "no-rm-rf-slash",
  tool: "bash",
  command: "rm",
  // Routing is `command: "rm"` (exact basename — `echo 'rm -rf /'`
  // has basename `echo` and never matches). The recursive-AND-force
  // AND rooted-at-`/` core lives in the named `hasRecursiveForce`
  // plugin predicate (leaf-inexpressible — a single `flag:` leaf is
  // OR-only — so per ADR §13 it gets a name, not an inline
  // `condition:`): separated flags (`-r -f`), long forms
  // (`--recursive --force`), mixed case (`-Rf`), and reversed order
  // (`-fr`) are all caught via the bound facade's table glue.
  when: { hasRecursiveForce: true },
  reason:
    "Recursive force-delete from root is catastrophic and irreversible. Specify a safe path (e.g. a subdirectory of the project or a temp dir).",
  // HARD block — inherent destructiveness, no override possible.
  // Explicit `noOverride: true` guarantees this even when a layer
  // sets `defaultNoOverride: false`.
  noOverride: true,
} as const satisfies Rule;
