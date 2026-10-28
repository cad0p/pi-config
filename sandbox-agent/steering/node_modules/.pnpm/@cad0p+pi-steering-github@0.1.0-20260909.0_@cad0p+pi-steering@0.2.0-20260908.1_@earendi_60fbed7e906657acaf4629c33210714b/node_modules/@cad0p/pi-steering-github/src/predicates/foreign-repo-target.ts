// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `when.foreignRepoTarget` — the `-R`/`--repo` foreign-target gate
 * backing `gh-repo-flag-before-subcommand`. True (rule fires →
 * BLOCK) when the invocation carries an effective `-R/--repo`
 * targeting a FOREIGN repository; false releases the command.
 *
 * Command-first edition (core #117): the router is now
 * `command: "gh"` + `when.subcommand` — this gate keys on whether
 * the invocation CARRIES `-R/--repo`, collapsing every routed
 * command into one of three states (unchanged since #39):
 *
 *   1. ABSENT (`ctx.command.hasFlag` sees no `-R`/`--repo` anywhere
 *      — space, attached `=`, or glued forms included) → not
 *      repo-targeting → release. The command falls through to the
 *      per-subcommand policies (vault bodies, closing keywords).
 *   2. PRESENT-UNPARSABLE (`getFlagValue` → null / "") → BLOCK
 *      (fail-closed). Only trailing-valueless aliases and empty
 *      attached values remain unparsable now that glued forms
 *      resolve.
 *   3. PRESENT-PARSABLE: slashless remote-name forms (`-R upstream`)
 *      release (no `/` cannot be a foreign-owner/repo redirect);
 *      otherwise basename compare against the cwd repo (`repoName` —
 *      origin URL basename, cwd-folder fallback): basename EQUALITY
 *      is allowed (fork→upstream tolerance, issue #19 — hardcoded
 *      THE policy, no config knob), anything else BLOCKS.
 *      Fail-closed: walker-unknown cwd / unresolvable repo
 *      ("unknown" sentinel or null) → BLOCK.
 *
 * Flag access reads through the bound `ctx.command` facade
 * (`ghFlags.repo` entry, glue + consumption from this plugin's OWNED
 * gh descriptor — #61): LAST-wins across the `-R`/`--repo` alias set
 * (gh/cobra collapse repeated spellings of one logical flag to the
 * final value — issue #34), bare `-R`, attached `--repo=`/`-R=`, AND
 * glued short forms like `-Rcad0p/x`. A trailing valueless alias or
 * an empty attached value as the last occurrence wins and lands in
 * state 2. The `{ gluedShorts: ["R"] }` opt-in is gone — the table
 * derives glue for `R`, so no call-site arity remains.
 *
 * Boolean-leaf shape (the `infoOnly` precedent, core
 * `BooleanLeafArgs` + `unwrapBooleanLeafArg`): bare `true` enables
 * the gate, spread `{ value: true }` likewise. Bare `false` NEVER
 * fires — deliberately NOT the `isForcePush` inversion (`signal ===
 * expected` would fire on every NON-foreign command under `false`,
 * turning a disable into a block-everything): `false` disables the
 * gate, the shipped contract since extraction (#36). Malformed →
 * `false` (house precedent).
 *
 * The help/version carve-out does NOT live here: composition with
 * `not: { infoOnly: { extraFlags: ["-h"] } }` in the rule handles
 * read-only introspection declaratively via the flags plugin's
 * registered predicate, so this handler stays single-concern.
 */

import {
  type BooleanLeafArgs,
  definePredicate,
  unwrapBooleanLeafArg,
} from "@cad0p/pi-steering";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
import { repoName } from "../helpers/repo-name.ts";

/** Table-owned gh flag entries, referenced by variable (never re-spelled). */
const { flags: ghFlags } = GH_CLI_DESCRIPTOR;

/**
 * OTHER consuming spellings (every takesValue:true alias except the repo
 * pair itself): values following these exact tokens are consumed positions
 * (same BY-POSITION contract as `positionals()` + `flagPresenceScan`),
 * so a later `-R`-shaped word there is a VALUE, never a repo flag.
 *
 * Local workaround for the known engine limit (flat per-binary table +
 * non-skipping scalar `getFlagValue`): the facade's `hasFlag` already
 * skips these positions (so the ABSENT case flips correctly with the
 * completed tail), but the scalar still reads hijack values as glued `-R`
 * (the two PRESENT-position flips below need this skip). CORE-ALARM:
 * per-subcommand arity / value-skipping scalar belongs in core; this
 * helper goes away when it lands.
 */
const OTHER_CONSUMING = new Set<string>(
  [
    ...Object.values(GH_CLI_DESCRIPTOR.flags).flatMap((e) =>
      e.takesValue ? [...e.aliases] : [],
    ),
  ].filter((a) => a !== "-R" && a !== "--repo"),
);

function wordVal(w: { value?: string; text?: string } | undefined): string {
  if (w === undefined) return "";
  return w.value ?? w.text ?? "";
}

/**
 * Effective `-R`/`--repo` target with OTHER-consumed values skipped
 * (last-wins across `-R`/`--repo`, attached `=` + glued `-R<rest>`
 * included, trailing valueless/empty → null). Single source of truth
 * shared with the block reason — the redirect always names where to cd.
 */
export function effectiveRepoTarget(
  ctx: Parameters<Parameters<typeof definePredicate>[0]>[1],
): string | null {
  const args = (ctx.input?.args ?? []) as readonly {
    value?: string;
    text?: string;
  }[];
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const tok = wordVal(args[i]);
    if (tok === "--") {
      for (let j = i + 1; j < args.length; j++) consumed.add(j);
      break;
    }
    if (OTHER_CONSUMING.has(tok)) {
      if (i + 1 < args.length) consumed.add(i + 1);
      i += 1;
    }
  }
  const flagSet = ["-R", "--repo"];
  for (let i = args.length - 1; i >= 0; i--) {
    if (consumed.has(i)) continue;
    const t = wordVal(args[i]);
    for (const alias of flagSet) {
      if (t === alias) {
        const nxt = args[i + 1];
        if (nxt === undefined || consumed.has(i + 1)) return null;
        const v = wordVal(nxt);
        return v === "" ? null : v;
      }
    }
    for (const alias of flagSet) {
      const prefix = `${alias}=`;
      if (t.startsWith(prefix)) return t.slice(prefix.length);
    }
    if (t.length > 2 && t[0] === "-" && t[1] !== "-") {
      if (t[1] === "R") return t.slice(2);
    }
  }
  return null;
}

/**
 * `foreignRepoTarget` — true (BLOCK) when the effective `-R`/`--repo`
 * target is a foreign repository; false releases repo-flag-ABSENT,
 * slashless, and fork→upstream commands. Fail-closed: unparsable
 * target, walker-unknown cwd, unresolvable repo → true.
 */
export const foreignRepoTarget = definePredicate<BooleanLeafArgs>(
  async (args, ctx) => {
    // Bare-false (or { value: false }, or malformed) disables the
    // gate WITHOUT running the argv logic — `foreignRepoTarget:
    // false` must stay inert (NOT inverted: inversion would fire on
    // every non-foreign command).
    if (unwrapBooleanLeafArg(args) !== true) return false;
    if (ctx.input?.tool !== "bash") return false;

    // Step 1 — PRESENCE gate (#39) via the bound facade. Absent →
    // not repo-targeting → release; evaluation falls through to the
    // per-subcommand rules.
    if (!ctx.command.hasFlag(ghFlags.repo)) return false;

    // Step 2 — the effective target (last-wins across the aliases,
    // glue-aware via the owned descriptor, OTHER-consumed values skipped
    // via `effectiveRepoTarget` — see its engine-limit note). A trailing
    // valueless alias or an empty attached value as the last occurrence
    // wins and fail-closes (null / "" → block below).
    const target = effectiveRepoTarget(ctx);
    // Step 3 — fail-closed on an unparsable target.
    if (target === null || target === "") return true;
    // Step 4 — slashless remote-name forms (`-R upstream`) are the
    // fork→upstream flow — release. A `/`-containing target is
    // required to be a foreign-owner/repo redirect.
    if (!target.includes("/")) return false;
    // Step 5 — basename compare vs the cwd repo. Fail-closed rails:
    const cwd = ctx.cwd;
    if (typeof cwd !== "string" || cwd === "unknown") return true;
    const repo = await repoName(ctx, cwd);
    // `repoName` falls back to the cwd folder name, which for the
    // walker-unknown sentinel is the literal string "unknown" (NOT
    // null) — treat it as no-match (block), like an unresolvable
    // repo.
    if (repo === null || repo === "unknown") return true;
    // Fork→upstream tolerance (#19), HARDCODED — the basename
    // equality allowance is the policy, not a knob: `gh -R
    // upstream/foo pr create` from inside the `me/foo` clone is the
    // most common LEGIT `-R` use. Cost accepted: `-R <own-repo> pr
    // merge` from inside the repo is indistinguishable and slips
    // through — heuristic discipline, not security.
    const targetBase = target.slice(target.lastIndexOf("/") + 1);
    return targetBase !== repo;
  },
);
