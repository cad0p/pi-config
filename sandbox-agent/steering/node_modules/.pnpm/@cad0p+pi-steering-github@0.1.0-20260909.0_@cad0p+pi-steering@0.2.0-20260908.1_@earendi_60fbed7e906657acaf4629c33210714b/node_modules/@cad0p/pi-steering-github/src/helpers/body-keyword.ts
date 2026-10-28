// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `bodyHasClosingKeyword` — does the command's body carry a
 * closing-keyword reference? Backs `pr-create-needs-issue-link`.
 *
 * - substitution form: runs the pinned perl one-liner via `ctx.exec`
 *   and tests its OUTPUT — the canonical input is exactly what gh
 *   uploads (frontmatter and the leading H1 stripped, so a keyword
 *   that only appears in the frontmatter or the H1 does not count).
 * - direct path / inline `--body`: raw content fallbacks for
 *   configs that disable the body-file rules (documented README
 *   combo).
 *
 * Anything unreadable / exec failure / non-zero exit = false
 * (fail-closed).
 */

import { readFileSync } from "node:fs";
import {
  expandTildeIfLeading,
  type PredicateContext,
} from "@cad0p/pi-steering";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
import { BODY_STRIP } from "./body-strip.ts";
import {
  findBodyFileRawValue,
  parseBodyFileArg,
  resolveAgainstCwd,
  tildeEnv,
} from "./pattern-args.ts";
import { ISSUE_REF } from "./patterns.ts";

/** Table-owned gh flag entries, referenced by variable (never re-spelled). */
const { flags: ghFlags } = GH_CLI_DESCRIPTOR;

export async function bodyHasClosingKeyword(
  ctx: PredicateContext,
): Promise<boolean> {
  const refRe = new RegExp(ISSUE_REF, "i");
  // Raw (still-quoted) word: the direct fallback must see the
  // quotes so a quoted leading `~` resolves literally, as the shell
  // leaves it. Substitution parsing is identical either way (an
  // outer-quoted substitution unwraps to the same form).
  const value = findBodyFileRawValue(ctx);
  if (value !== "") {
    const parsed = parseBodyFileArg(value);
    if (parsed === null) return false; // unparsable value → fail-closed
    if (parsed.kind === "substitution") {
      // The pinned one-liner IS the definition of the canonical body.
      // `ctx.exec` bypasses the shell, so replicate what the shell
      // would hand perl: an unquoted leading `~` expands to HOME
      // (tracked env at the command ref, process env fallback),
      // a quoted one stays literal (bash-exact — perl then fails to
      // open it, fail-closed). HOME unknown → fail-closed.
      const expanded = parsed.quoted
        ? parsed.path
        : expandTildeIfLeading(parsed.path, tildeEnv(ctx));
      if (expanded === undefined) return false;
      try {
        const res = await ctx.exec("perl", [
          "-0777",
          "-pe",
          BODY_STRIP,
          expanded,
        ]);
        if (res.exitCode !== 0) return false;
        return refRe.test(res.stdout ?? "");
      } catch {
        return false;
      }
    }
    // Direct-path fallback (disabled body-file rules): raw content.
    // The carried flag keeps a quoted direct `"~/…"` literal —
    // expanding it would read the wrong file.
    const abs = resolveAgainstCwd(ctx, parsed.path, parsed.quoted);
    if (abs === null) return false;
    try {
      return refRe.test(readFileSync(abs, "utf8"));
    } catch {
      return false;
    }
  }
  // Inline fallback (disabled body-file rules): last-wins across the
  // --body/-b aliases via the bound facade — the same gh/cobra
  // semantics the merge rule's requiresFlagValue leaf enforces (the
  // old first-occurrence scan is retired).
  const inline = ctx.command.getFlagValue(ghFlags.body);
  if (inline !== null) return refRe.test(inline);
  return false;
}
