// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * `when.requiresFlag` \u2014 block unless a specified flag (or one of its
 * env-var equivalents) is present in the evaluated command.
 *
 * Shorthand form accepts a bare flag string:
 *   `when: { requiresFlag: "--profile" }`
 *
 * Object form accepts a mix of alternatives:
 *   `when: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } }`
 *
 * Fires (rule BLOCKS) when NONE of the listed equivalents appear.
 */

import { type CLIFlag, definePredicate } from "@cad0p/pi-steering";
import type { RequiresFlagArgs } from "../types.ts";

export const requiresFlag = definePredicate<RequiresFlagArgs | string>(
  (args, ctx) => {
    const norm: RequiresFlagArgs =
      typeof args === "string" ? { flag: args } : (args ?? {});

    const flags: string[] = [];
    if (typeof norm.flag === "string") flags.push(norm.flag);
    if (Array.isArray(norm.flags)) {
      for (const f of norm.flags) {
        if (typeof f === "string") flags.push(f);
      }
    }

    const envs: string[] = [];
    if (typeof norm.env === "string") envs.push(norm.env);
    if (Array.isArray(norm.envs)) {
      for (const e of norm.envs) {
        if (typeof e === "string") envs.push(e);
      }
    }

    // Malformed arg (no flags AND no envs) \u2014 nothing to check, don't
    // fire. Rule author's bug, but failing closed would turn every
    // evaluation of this rule into a block, which is worse.
    if (flags.length === 0 && envs.length === 0) return false;

    const entries: CLIFlag[] = flags.map((f) => ({
      aliases: [f],
      takesValue: false,
    }));
    if (entries.length > 0 && ctx.command.hasFlag(entries)) return false; // satisfied
    for (const env of envs) {
      if (ctx.command.hasEnvAssignment(env)) return false; // satisfied
    }

    // None of the equivalents present \u2014 fire.
    return true;
  },
);
