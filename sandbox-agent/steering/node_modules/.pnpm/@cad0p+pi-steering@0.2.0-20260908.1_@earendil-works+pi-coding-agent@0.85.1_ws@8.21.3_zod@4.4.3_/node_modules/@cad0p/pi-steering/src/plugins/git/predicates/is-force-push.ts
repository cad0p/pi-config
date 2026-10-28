// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.isForcePush` predicate handler for the git plugin.
 *
 * The `no-force-push` rule's core logic (issue #117): EVERY
 * remote-history-rewrite push form — the reason text is byte-identical
 * to the 0.2.0 default, including the issue #65 sealing. The AND is
 * leaf-inexpressible — a single `flag:` leaf is OR-only over entries,
 * and the leading-`+` refspec signal is positional, not flag-shaped —
 * so per ADR §13 it gets a name (via {@link definePredicate}), not an
 * inline `condition:`.
 */

import { definePredicate } from "../../../define-predicate.ts";
import {
  type BooleanLeafArgs,
  unwrapBooleanLeafArg,
} from "../../../helpers/boolean-args.ts";
import type { PredicateWord } from "../../../schema.ts";
import { GIT_CLI_DESCRIPTOR } from "../descriptors.ts";

/** Push force entries, referenced by variable from the owning table. */
const { flags: gitFlags } = GIT_CLI_DESCRIPTOR;

/**
 * Leading-`+` refspec scan (`git push origin +main`, `+src:dst`).
 *
 * `+main` is not flag-shaped — it's a positional — so no `flag:`
 * entry can express it. Only LEADING-`+` forms are force markers: a
 * `+` mid-token (branch names like `c++-port`) has no leading `+`
 * and is not matched. A bare `"+"` alone is not a refspec either.
 */
function hasLeadingPlusRefspec(words: readonly PredicateWord[]): boolean {
  return words.some((w) => {
    const v = w?.value ?? "";
    return v.length > 1 && v[0] === "+" && v[1] !== ":";
  });
}

/**
 * `when.isForcePush` - match `git push` refs carrying ANY force
 * signal: `--force` / `-f` / `--force-with-lease` /
 * `--force-if-includes` / `--mirror` (token-exact entries, bundled
 * shorts included via the derived `hasFlag`), or a leading-`+`
 * refspec (`git push origin +main`).
 *
 *   - `when: { isForcePush: true }`  - fires on every
 *     remote-history-rewrite push form (issue #65 sealing).
 *   - `when: { isForcePush: false }` - inverted (rare).
 *
 * Flag presence reads through the bound `ctx.command` facade
 * (`hasFlag` — the table-derived variant agreeing with the `flag:`
 * leaf, issue #123). Non-bash tools carry no `args` → `false`
 * (never unknown: absence here is definite, not a resolution
 * failure).
 *
 * @see PiSteeringPredicates.isForcePush — the registry entry
 *      that declares the bare / spreadBase shape this handler
 *      dispatches on.
 */
export const isForcePush = definePredicate<BooleanLeafArgs>((args, ctx) => {
  // Shared boolean-leaf unwrap (see `src/helpers/boolean-args.ts`); malformed → false (fail-closed).
  const expected = unwrapBooleanLeafArg(args);
  if (expected === undefined) return false;
  const input = ctx.input;
  if (input?.tool !== "bash") return false;
  const words = input.args;
  if (!Array.isArray(words)) return false;
  const signal =
    ctx.command.hasFlag([
      gitFlags.force,
      gitFlags.forceShort,
      gitFlags.forceWithLease,
      gitFlags.forceIfIncludes,
      gitFlags.mirror,
    ]) || hasLeadingPlusRefspec(words);
  return signal === expected;
});
