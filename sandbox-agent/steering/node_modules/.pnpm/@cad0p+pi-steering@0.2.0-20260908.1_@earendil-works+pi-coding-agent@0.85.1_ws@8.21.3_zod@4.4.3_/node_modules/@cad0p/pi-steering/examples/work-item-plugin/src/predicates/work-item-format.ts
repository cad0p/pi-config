// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `workItemFormat` — example plugin predicate.
 *
 * Demonstrates two things at once:
 *
 *   1. How to use `definePredicate<T>` for a typed arg shape.
 *   2. How to read structured args via `input.args` (ADR §9).
 *
 * Accepted arg shape:
 *
 *   ```ts
 *   when: { workItemFormat: { pattern: /\[PROJ-\d+\]/ } }
 *   ```
 *
 * Semantics:
 *
 *   - Extracts the commit message from a `-m` flag in `input.args`.
 *     This is the preferred path because `input.args` preserves
 *     quoting via `Word.value` — `-m "feat: [PROJ-42]"` lands as a
 *     single Word with `value === "feat: [PROJ-42]"`.
 *   - If `-m` can't be found in `input.args` (the user authored a
 *     rule for a non-commit command, or args is absent for some
 *     reason), falls back to testing `input.command` directly. The
 *     fallback is conservative: it just checks if the pattern
 *     appears anywhere in the flattened command string.
 *
 * Fail-closed: if the predicate can't determine a message at all,
 * returns `false` (rule does NOT fire) so authoring typos don't
 * spuriously block every commit.
 */

import type { Word } from "@cad0p/pi-steering";
import { definePredicate } from "@cad0p/pi-steering";

/** Argument shape the `when.workItemFormat` slot accepts. */
export interface WorkItemFormatArgs {
  /** Required regex the commit message must match. */
  pattern: RegExp;
}

/**
 * Walk `args` looking for a `-m` / `--message` flag and return the
 * message value (the Word that FOLLOWS the flag). Returns `null` if
 * no `-m`-like flag is present.
 *
 * Notes:
 *   - `.value` is the quote-unwrapped lexical value (`feat: x`),
 *     `.text` is the raw source (`"feat: x"`). Rules care about
 *     lexical content.
 *   - The combined form `-m"msg"` is not parsed as a single Word by
 *     unbash (shell doesn't either — the quotes end the flag token
 *     prematurely). We treat `-m` and `--message` as space-separated
 *     only, which matches 99% of human usage.
 */
function extractMessage(args: readonly Word[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === undefined) continue;
    if (w.value === "-m" || w.value === "--message") {
      const next = args[i + 1];
      if (next !== undefined) {
        return next.value;
      }
    }
  }
  return null;
}

/**
 * The predicate handler itself. See module doc for the arg shape and
 * fallback policy.
 */
export const workItemFormat = definePredicate<WorkItemFormatArgs>(
  (args, ctx) => {
    if (!(args?.pattern instanceof RegExp)) return false;

    // Preferred: structured args with quote-awareness.
    if (ctx.input.args !== undefined) {
      const msg = extractMessage(ctx.input.args);
      if (msg !== null) {
        return args.pattern.test(msg);
      }
    }

    // Fallback: match anywhere in the flattened command string.
    // Conservative — a rule whose `pattern` already anchored on
    // `git commit -m` has narrowed the scope, so arbitrary
    // command content shouldn't match the ticket regex by
    // accident.
    if (ctx.input.command !== undefined) {
      return args.pattern.test(ctx.input.command);
    }

    return false;
  },
);
