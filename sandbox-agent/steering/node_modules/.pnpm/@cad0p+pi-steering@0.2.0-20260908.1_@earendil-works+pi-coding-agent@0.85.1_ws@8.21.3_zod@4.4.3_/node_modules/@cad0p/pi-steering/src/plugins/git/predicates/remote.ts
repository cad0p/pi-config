// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.remote` predicate handler for the git plugin.
 */

import type { PredicateHandler } from "../../../schema.ts";
import { getRemoteUrl } from "../helpers/git-ops.ts";
import {
  cwdIsWalkerUnknown,
  matchPattern,
  unknownVerdict,
  unwrapPatternArg,
} from "../helpers/pattern-args.ts";

/**
 * `when.remote` - match the repo's `origin` remote URL.
 *
 * Accepted arg shapes: same as {@link branch}. Useful for rules that
 * should only fire in specific repos ("never force-push to
 * github.com/org/prod").
 *
 * Resolves via `git config --get remote.origin.url`. Non-zero exit
 * (no origin configured) falls back to `onUnknown`.
 *
 * Runtime-cwd guard: the handler inlines a {@link cwdIsWalkerUnknown}
 * check at the top and surfaces trinary `"unknown"` when the walker
 * couldn't statically resolve the command's effective cwd — querying
 * the wrong repo's remote would silently mis-route a repo-gated rule.
 * Same rationale as {@link hasStagedChanges}.
 *
 * @see walkerUnknownCwdReason — compose the agent-facing reason text
 *      for the walker-unknown-cwd fail-closed branch in your rule's
 *      ReasonFn.
 */
export const remote: PredicateHandler = async (value, ctx) => {
  if (cwdIsWalkerUnknown(ctx)) return "unknown";
  const arg = unwrapPatternArg(value);
  if (arg === null) return false;

  const out = await getRemoteUrl(ctx);
  if (out === null) return unknownVerdict(arg.onUnknown);
  return arg.patterns.some((p) => matchPattern(p, out));
};
