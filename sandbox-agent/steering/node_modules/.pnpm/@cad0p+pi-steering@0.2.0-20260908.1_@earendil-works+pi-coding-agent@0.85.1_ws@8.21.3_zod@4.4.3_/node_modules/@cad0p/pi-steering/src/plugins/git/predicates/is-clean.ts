// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.isClean` predicate handler for the git plugin.
 */

import {
  type BooleanLeafArgs,
  unwrapBooleanLeafArg,
} from "../../../helpers/boolean-args.ts";
import type { PredicateHandler } from "../../../schema.ts";
import { getWorkingTreeClean } from "../helpers/git-ops.ts";
import { cwdIsWalkerUnknown } from "../helpers/pattern-args.ts";

/**
 * `when.isClean` - match on the working tree's cleanliness at
 * `ctx.cwd`.
 *
 *   - `when: { isClean: true }`  - fires when the working tree is
 *     clean (no unstaged, no untracked, no staged changes).
 *   - `when: { isClean: false }` - fires when the working tree is
 *     dirty.
 *
 * Uses `git status --porcelain`: empty stdout = clean. Non-zero exit
 * returns `false` (unknown); pair with an `upstream` check for
 * fail-closed behavior.
 *
 * Runtime-cwd guard: same rationale as {@link hasStagedChanges} — the
 * handler inlines a {@link cwdIsWalkerUnknown} check at the top and
 * surfaces trinary `"unknown"` when the walker couldn't statically
 * resolve the command's effective cwd, rather than silently running
 * `git status` at the pi session cwd.
 *
 * @see walkerUnknownCwdReason — compose the agent-facing reason text
 *      for the walker-unknown-cwd fail-closed branch in your rule's
 *      ReasonFn.
 * @see PiSteeringPredicates.isClean — the registry entry that
 *      declares the bare / spreadBase shape this handler dispatches
 *      on.
 */
export const isClean: PredicateHandler<BooleanLeafArgs> = async (args, ctx) => {
  if (cwdIsWalkerUnknown(ctx)) return "unknown";
  // SpreadBase auto-detects to `{ value: boolean }` (`onUnknown:` is a framework-applied modifier); unwrap consumes `value:` only.
  // Authors attach modifiers via `{ value: true, onUnknown: "allow" }`;
  // the engine reads any `onUnknown:` sibling via readLeafOnUnknown
  // and projects the handler's `"unknown"` returns under that policy
  // (the handler itself treats `onUnknown:` as an opaque sibling field).
  const expected = unwrapBooleanLeafArg(args);
  if (expected === undefined) return false;
  const clean = await getWorkingTreeClean(ctx);
  if (clean === null) return false;
  return expected === clean;
};
