// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * `when.requiresFlagValue` — fires (rule BLOCKS) when the LAST-wins
 * value of any listed flag alias is absent, valueless, or does not
 * satisfy `matches`.
 *
 * Last-wins rationale: gh / cobra / pflag CLIs keep only the LAST
 * occurrence of a repeated flag
 * (`gh pr merge -t "see #13" --subject "closes #12"` merges with the
 * subject "closes #12"), so gating on such commands must evaluate the
 * winning value — not the first one. The alias set
 * (`["-t", "--subject"]`) names ONE logical flag; aliases are OR'd at
 * every scanned position and whichever occurrence comes last wins.
 *
 * Fail-closed on runtime state: an ABSENT flag counts as unmet, as do
 * a trailing valueless flag (`cmd --subject`), a non-matching value,
 * and `ctx.input.args` being undefined. A rule that requires a
 * matching value must block when it can't verify one.
 *
 * Malformed args are the deliberate exception — fail-open, same
 * precedent as `requiresFlag`'s empty-object behavior: a rule
 * author's config bug shouldn't block every matching command.
 *
 * Carve-out composition idiom — pair with the info-only negation so
 * help invocations still pass:
 *
 *   when: {
 *     not: { infoOnly: { extraFlags: ["-h"] } },
 *     requiresFlagValue: {
 *       flags: ["--subject", "-t"],
 *       matches: /\b(closes?|fixe?s?|resolves?)\s+#\d+\b|(^|\s)#\d+/i,
 *     },
 *   }
 */

import { type CLIFlag, definePredicate } from "@cad0p/pi-steering";
import type { RequiresFlagValueArgs } from "../types.ts";

export const requiresFlagValue = definePredicate<RequiresFlagValueArgs>(
  (args, ctx) => {
    // Malformed arg — fail-open, same precedent as requiresFlag's
    // empty-object behavior (author bug shouldn't block everything).
    if (
      args === null ||
      typeof args !== "object" ||
      !Array.isArray(args.flags) ||
      args.flags.length === 0 ||
      !args.flags.every((f) => typeof f === "string") ||
      !(args.matches instanceof RegExp)
    ) {
      return false;
    }

    // Runtime state — fail-closed: absent / valueless / non-matching
    // all fire. Reset lastIndex first: a config regex carrying /g or
    // /y is stateful across evaluations and would intermittently
    // flip verdicts.
    args.matches.lastIndex = 0;
    const entries: CLIFlag[] = args.flags.map((f) => ({
      aliases: [f],
      takesValue: true,
    }));
    const value = ctx.command.getFlagValue(entries);
    return value === null || !args.matches.test(value);
  },
);
