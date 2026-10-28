// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.commitsAhead` predicate handler for the git plugin.
 */

import type { PredicateHandler } from "../../../schema.ts";
import { getCommitsAhead } from "../helpers/git-ops.ts";
import { cwdIsWalkerUnknown } from "../helpers/pattern-args.ts";

/**
 * Argument shape for {@link commitsAhead}.
 *
 * ```ts
 * when: { commitsAhead: { eq: 1 } }                    // exactly one ahead
 * when: { commitsAhead: { gt: 0 } }                    // at least one
 * when: { commitsAhead: { lt: 5 } }                    // fewer than five
 * when: { commitsAhead: { gt: 0, lt: 5 } }             // 1..4
 * when: { commitsAhead: { wrt: "origin/main", eq: 1 } }
 * ```
 *
 * At least one of `eq` / `gt` / `lt` MUST be specified. All provided
 * comparisons must pass (AND). `wrt` is the git revision expression
 * to count commits behind (`git rev-list --count WRT..HEAD`); it
 * defaults to `@{upstream}`.
 */
export interface CommitsAheadArgs {
  /** Git revision to count commits ahead of. Defaults to `@{upstream}`. */
  wrt?: string;
  /** Exact equality: `count === eq`. */
  eq?: number;
  /** Strict greater-than: `count > gt`. */
  gt?: number;
  /** Strict less-than: `count < lt`. */
  lt?: number;
}

/**
 * `when.commitsAhead` - match when commits-ahead-of-WRT satisfy every
 * supplied comparator.
 *
 * Returns `false` (rule doesn't fire) when:
 *   - the arg shape isn't an object with at least one of `eq` / `gt`
 *     / `lt`,
 *   - the `git rev-list` call fails,
 *   - the comparator chain doesn't match.
 *
 * No `onUnknown` here: commits-ahead is a numeric comparator, not a
 * pattern match, and "I couldn't learn the answer" arguably shouldn't
 * fire a rule that's gated on a specific count. Authors who want the
 * fail-closed behavior can layer `{ upstream: "..." }` first in the
 * same `when` (AND semantics via the ADR's plugin predicates) - that
 * handles the "no upstream" case with explicit `onUnknown`.
 *
 * Runtime-cwd guard: `getCommitsAhead` shells out at `ctx.cwd`. When
 * the walker surfaces `ctx.walkerState.cwd === "unknown"`, the exec
 * would run against the pi session cwd — wrong repo — and the
 * `count === null` failure path returns `false`, silently skipping
 * the rule (fail-OPEN). The handler inlines a
 * {@link cwdIsWalkerUnknown} check at the top and surfaces trinary
 * `"unknown"`; the engine's `onUnknown:` policy then projects to the
 * right boolean (default `"block"` = fail-CLOSED, matching the policy
 * used by the other runtime-cwd predicates in this plugin).
 *
 * @see walkerUnknownCwdReason — compose the agent-facing reason text
 *      for the walker-unknown-cwd fail-closed branch in your rule's
 *      ReasonFn.
 * @see PiSteeringPredicates.commitsAhead — the registry entry that
 *      declares the bare / spreadBase shape this handler dispatches
 *      on.
 */
export const commitsAhead: PredicateHandler<number | CommitsAheadArgs> = async (
  args,
  ctx,
) => {
  if (cwdIsWalkerUnknown(ctx)) return "unknown";
  // Schema advertises `PredicateShape<number, { eq?, gt?, lt?, wrt? }>`
  // — bare-number `commitsAhead: N` is sugar for `{ eq: N }`.
  let eq: number | undefined;
  let gt: number | undefined;
  let lt: number | undefined;
  let wrt: string = "@{upstream}";
  if (typeof args === "number") {
    eq = args;
  } else if (args !== null && typeof args === "object") {
    const shape = args as CommitsAheadArgs;
    eq = shape.eq;
    gt = shape.gt;
    lt = shape.lt;
    wrt = shape.wrt ?? "@{upstream}";
  } else {
    return false;
  }
  if (eq === undefined && gt === undefined && lt === undefined) {
    return false;
  }

  const count = await getCommitsAhead(ctx, wrt);
  if (count === null) return false;

  if (eq !== undefined && count !== eq) return false;
  if (gt !== undefined && !(count > gt)) return false;
  if (lt !== undefined && !(count < lt)) return false;
  return true;
};
