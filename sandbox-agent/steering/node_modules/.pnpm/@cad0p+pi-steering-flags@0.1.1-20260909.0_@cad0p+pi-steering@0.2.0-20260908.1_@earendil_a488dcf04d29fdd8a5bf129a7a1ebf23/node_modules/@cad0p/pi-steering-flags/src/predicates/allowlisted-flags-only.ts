// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * `when.allowlistedFlagsOnly` \u2014 block when any flag appears outside
 * an allowlist.
 *
 * Default-deny flag gating: every `-`-prefixed token in the command's
 * args must be in the explicit allow set (or match an auto-derived
 * `--flag=` prefix of an allowed flag). Unknown flags fire the rule.
 *
 * Fires (rule BLOCKS) on the first disallowed flag token.
 */

import type { Word } from "@cad0p/pi-steering";
import { definePredicate } from "@cad0p/pi-steering";
import type { AllowlistedFlagsOnlyArgs } from "../types.ts";

function wordValue(w: Word): string {
  return (w.value ?? w.text ?? "").trim();
}

export const allowlistedFlagsOnly = definePredicate<AllowlistedFlagsOnlyArgs>(
  (args, ctx) => {
    if (args === null || typeof args !== "object") return false;
    if (!Array.isArray(args.allow)) return false;

    const allow = new Set(args.allow);
    // Auto-derive `--flag=` prefixes from every bare `--flag` in
    // `allow`. Short flags (`-n`, `-h`) don't get auto-prefix
    // treatment \u2014 they typically use separated values (`-n name`)
    // rather than attached. Explicit prefixes supplement this for
    // the rare short-flag-attached case (e.g. `-ofoo`).
    const derivedPrefixes: string[] = [];
    for (const f of args.allow) {
      if (f.startsWith("--")) derivedPrefixes.push(`${f}=`);
    }
    const explicitPrefixes = args.allowPrefixes ?? [];
    const prefixes = [...derivedPrefixes, ...explicitPrefixes];

    const argsList = ctx.input?.args ?? [];
    for (const w of argsList) {
      const tok = wordValue(w);
      if (tok.length === 0) continue;
      if (!tok.startsWith("-")) continue;
      if (allow.has(tok)) continue;
      if (prefixes.some((p) => tok.startsWith(p))) continue;
      return true; // disallowed flag \u2192 fire
    }
    return false;
  },
);
