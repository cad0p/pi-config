// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.hasRecursiveForce` predicate handler for the rm plugin.
 *
 * The `no-rm-rf-slash` rule's core logic (issue #117): recursive AND
 * force AND rooted at `/`. The AND is leaf-inexpressible — a single
 * `flag:` leaf is OR-only over entries, and OR-under-`not:` yields
 * NOR, not the needed NAND — so per ADR §13 it gets a name (via
 * {@link definePredicate}), not an inline `condition:`.
 */

import { definePredicate } from "../../../define-predicate.ts";
import {
  type BooleanLeafArgs,
  unwrapBooleanLeafArg,
} from "../../../helpers/boolean-args.ts";
import { RM_FORCE_FLAG, RM_RECURSIVE_FLAG } from "../descriptors.ts";

/**
 * `when.hasRecursiveForce` - match `rm` refs carrying BOTH the
 * recursive and the force flag AND targeting `/`.
 *
 *   - `when: { hasRecursiveForce: true }`  - fires on `rm -Rf /`
 *     (any flag spelling the table derives: `-r` / `-R` /
 *     `--recursive` × `-f` / `--force`, separated or bundled).
 *   - `when: { hasRecursiveForce: false }` - inverted (rare).
 *
 * Flag presence reads through the bound `ctx.command` facade
 * (`hasFlag` — the table-derived variant agreeing with the `flag:`
 * leaf, issue #123): table glue handles bundles like `-Rf`.
 * `ctx.input.args` values for a word whose resolved value is exactly
 * `"/"` (quote-aware — `'/'` still counts; `/tmp` never does).
 * Non-bash tools carry no `args` → `false` (never unknown: absence
 * here is definite, not a resolution failure).
 *
 * @see PiSteeringPredicates.hasRecursiveForce — the registry entry
 *      that declares the bare / spreadBase shape this handler
 *      dispatches on.
 */
export const hasRecursiveForce = definePredicate<BooleanLeafArgs>(
  (args, ctx) => {
    // Shared boolean-leaf unwrap (see `src/helpers/boolean-args.ts`); malformed → false (fail-closed).
    const expected = unwrapBooleanLeafArg(args);
    if (expected === undefined) return false;
    const input = ctx.input;
    if (input?.tool !== "bash") return false;
    const cmd = ctx.command;
    if (!cmd.hasFlag(RM_RECURSIVE_FLAG)) return false;
    if (!cmd.hasFlag(RM_FORCE_FLAG)) return false;
    const words = input.args;
    if (!Array.isArray(words)) return false;
    const rooted = words.some((w) => (w?.value ?? "") === "/");
    return rooted === expected;
  },
);
