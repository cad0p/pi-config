// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * `when.infoOnly` — fires (rule BLOCKS) when the command IS an
 * info-only invocation (`--help` / `--version`, plus any additive
 * `extraFlags`).
 *
 * This is the token-level replacement for the removed `INFO_ONLY`
 * regex. Unlike a regex over the normalized string, a help token
 * inside a quoted VALUE (`gh pr merge --subject "see --help"`) does
 * NOT count, so the command is NOT classified info-only and
 * guardrails still apply to real operations that merely mention help
 * text.
 *
 * Bare shorthand `infoOnly: true` checks the default set
 * (`--help` / `--version` only — `-h` / `-v` are deliberately
 * excluded; they are real operations in commands like
 * `docker run -v /data:/data` or `curl -v`). The spread form only
 * ADDS flags:
 *
 *   `when: { infoOnly: { extraFlags: ["-h"] } }`
 *
 * Nothing can remove the safe core; a plugin author adding `-h` for
 * their own CLI owns that security tradeoff. `infoOnly: false`
 * never fires (the rule is effectively disabled).
 *
 * Carve-out idiom — combine with `when.not`:
 *
 *   `when: { not: { infoOnly: true } }`
 *
 * The `when` clause is an AND: a naive `when: { infoOnly: true }`
 * would BLOCK on help (the clause requires the command to BE
 * info-only), which is the opposite of a carve-out. Negate it with
 * `not:` to ALLOW info-only invocations while everything else still
 * evaluates the clause.
 */

import { definePredicate } from "@cad0p/pi-steering";
import type { InfoOnlyArgs } from "../types.ts";

export const infoOnly = definePredicate<boolean | InfoOnlyArgs>((args, ctx) => {
  if (args === false) return false; // explicitly disabled — never fires
  const extraFlags =
    args !== null && typeof args === "object" && Array.isArray(args.extraFlags)
      ? args.extraFlags
      : undefined;
  return ctx.command.isInfoOnly(extraFlags);
});
