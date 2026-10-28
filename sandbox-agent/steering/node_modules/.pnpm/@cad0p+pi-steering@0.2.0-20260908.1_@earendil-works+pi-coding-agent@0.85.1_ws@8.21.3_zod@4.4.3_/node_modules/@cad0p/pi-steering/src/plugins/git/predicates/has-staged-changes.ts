// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.hasStagedChanges` predicate handler for the git plugin.
 */

import {
  type BooleanLeafArgs,
  unwrapBooleanLeafArg,
} from "../../../helpers/boolean-args.ts";
import type { PredicateHandler } from "../../../schema.ts";
import { getStagedChanges } from "../helpers/git-ops.ts";
import { cwdIsWalkerUnknown } from "../helpers/pattern-args.ts";

/**
 * `when.hasStagedChanges` - match on the presence / absence of staged
 * changes in the repo at `ctx.cwd`.
 *
 *   - `when: { hasStagedChanges: true }`  - fires when there ARE staged
 *     changes.
 *   - `when: { hasStagedChanges: false }` - fires when there are NOT.
 *
 * Uses `git diff --cached --quiet`: exit 0 = no staged changes, exit
 * 1 = staged changes exist. On any other exit / spawn failure, we
 * conservatively report `false` - the caller can AND this with an
 * `upstream` check if fail-closed behavior is needed.
 *
 * Runtime-cwd guard: the underlying `git diff --cached` call runs
 * at `ctx.cwd`. When the walker surfaces `ctx.walkerState.cwd ===
 * "unknown"` (dynamic `cd "$VAR/pkg"` the walker couldn't resolve),
 * `ctx.cwd` falls back to the pre-cd ambient cwd — the PI session
 * cwd, not the intended subpackage. The handler inlines a
 * {@link cwdIsWalkerUnknown} check at the top and surfaces trinary
 * `"unknown"`; the engine's `onUnknown:` policy then projects to the
 * right boolean (default `"block"` = fail-CLOSED).
 *
 * @see walkerUnknownCwdReason — compose the agent-facing reason text
 *      for the walker-unknown-cwd fail-closed branch in your rule's
 *      ReasonFn.
 * @see PiSteeringPredicates.hasStagedChanges — the registry entry
 *      that declares the bare / spreadBase shape this handler
 *      dispatches on.
 */
export const hasStagedChanges: PredicateHandler<BooleanLeafArgs> = async (
  args,
  ctx,
) => {
  if (cwdIsWalkerUnknown(ctx)) return "unknown";
  // SpreadBase auto-detects to `{ value: boolean }` (`onUnknown:` is a framework-applied modifier); unwrap consumes `value:` only.
  // Authors attach modifiers via `{ value: true, onUnknown: "allow" }`;
  // the engine reads any `onUnknown:` sibling via readLeafOnUnknown
  // and projects the handler's `"unknown"` returns under that policy
  // (the handler itself treats `onUnknown:` as an opaque sibling field).
  const expected = unwrapBooleanLeafArg(args);
  if (expected === undefined) return false;
  const state = await getStagedChanges(ctx);
  if (state === null) return false; // unknown — don't fire
  return expected === state;
};
