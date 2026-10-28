// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.upstream` predicate handler for the git plugin.
 */

import type { PredicateHandler } from "../../../schema.ts";
import { getUpstream } from "../helpers/git-ops.ts";
import {
  cwdIsWalkerUnknown,
  matchPattern,
  unknownVerdict,
  unwrapPatternArg,
} from "../helpers/pattern-args.ts";

/**
 * `when.upstream` - match the current branch's configured upstream.
 *
 * Accepted arg shapes: same as {@link branch}.
 *
 * Resolves via `git rev-parse --abbrev-ref @{upstream}`. A branch
 * without an upstream set returns a non-zero exit; the predicate then
 * applies `onUnknown`.
 *
 * No tracker today - upstream configuration isn't changed by in-chain
 * git commands at a rate that justifies modelling it (and `git push
 * -u origin main` changes it but only AFTER the push succeeds, which
 * is past the point where a pre-execution guard would act). The
 * per-tool_call exec cache ensures multiple upstream-gated rules share
 * one git call.
 *
 * Runtime-cwd guard: `getUpstream` shells out at `ctx.cwd`. When the
 * walker surfaces `ctx.walkerState.cwd === "unknown"` (dynamic
 * `cd "$VAR/pkg"` the walker couldn't resolve), the exec would run
 * against the pi session cwd — the wrong repo — and a user who opted
 * into `onUnknown: "allow"` would get a silent fail-OPEN. The handler
 * inlines a {@link cwdIsWalkerUnknown} check at the top and surfaces
 * trinary `"unknown"`; the engine's leaf-level (outer) or block-level
 * (inside `not:`) `onUnknown:` policy then projects to the right
 * boolean (default `"block"` = fail-CLOSED).
 *
 * @see walkerUnknownCwdReason — compose the agent-facing reason text
 *      for the walker-unknown-cwd fail-closed branch in your rule's
 *      ReasonFn.
 */
export const upstream: PredicateHandler = async (value, ctx) => {
  if (cwdIsWalkerUnknown(ctx)) return "unknown";
  const arg = unwrapPatternArg(value);
  if (arg === null) return false;

  const out = await getUpstream(ctx);
  if (out === null) return unknownVerdict(arg.onUnknown);
  return arg.patterns.some((p) => matchPattern(p, out));
};
