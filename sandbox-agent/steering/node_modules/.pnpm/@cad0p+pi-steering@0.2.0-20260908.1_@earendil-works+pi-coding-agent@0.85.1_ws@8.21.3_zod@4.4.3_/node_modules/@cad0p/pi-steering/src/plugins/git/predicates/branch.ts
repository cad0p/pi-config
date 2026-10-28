// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `when.branch` predicate handler for the git plugin.
 *
 * Also hosts the {@link WalkerStringResult} / {@link walkerString}
 * helpers — they exist for the branch-tracker-consumption contract
 * shared by this handler and the shipped rules' ReasonFns, so they
 * live next to their primary consumer. Re-exported from the plugin
 * index for plugin authors.
 */

import type { PredicateContext, PredicateHandler } from "../../../schema.ts";
import {
  matchPattern,
  unknownVerdict,
  unwrapPatternArg,
} from "../helpers/pattern-args.ts";
import { NO_CHECKOUT_IN_CHAIN } from "../trackers/branch-tracker.ts";

// ---------------------------------------------------------------------------
// WalkerStringResult / walkerString (branch-tracker consumption helpers)
// ---------------------------------------------------------------------------

/**
 * Resolved outcome of reading a string tracker value from
 * `ctx.walkerState[key]`. Callers MUST distinguish the three cases:
 *
 *   - `value`   - the tracker resolved the value statically for this
 *                  command ref. Use it directly.
 *   - `unknown` - the tracker observed a write it couldn't resolve
 *                  statically (e.g. `git checkout $VAR`). The walker
 *                  deliberately surfaces this to signal "a change
 *                  occurred but I can't name the new value". Falling
 *                  through to `exec` would return the PRE-write
 *                  value and silently defeat the walker's static
 *                  tracking - exactly the case it exists for.
 *                  Callers must apply their `onUnknown` policy.
 *   - `missing` - no tracker modifier fired for this dimension in
 *                  this ref's scope (the walker threaded the
 *                  tracker's initial sentinel, or `walkerState` has
 *                  no key for this tracker at all). `exec` fallback
 *                  is correct here: the shell's current state is the
 *                  value the predicate wants.
 *
 * The three-way split requires cooperation from the tracker: its
 * `initial` value must be distinct from its `unknown` sentinel, so
 * the predicate can tell "no modifier fired" apart from "modifier
 * fired and couldn't resolve". `branchTracker` does this via
 * {@link NO_CHECKOUT_IN_CHAIN}. A tracker that reuses `"unknown"`
 * for both initial and unknown would collapse these two cases -
 * preserved here as `missing` for backward compatibility (the
 * predicate then behaves as it did pre-U1, shelling out on any
 * unknown).
 */
export type WalkerStringResult =
  | { kind: "value"; value: string }
  | { kind: "unknown" }
  | { kind: "missing" };

/**
 * Resolve a string tracker value from `ctx.walkerState[key]` into a
 * three-state discriminated result. See {@link WalkerStringResult}
 * for why callers must not conflate `unknown` with `missing`.
 *
 * `initialSentinel` is the tracker's initial value (distinct from
 * its `unknown` sentinel). When `walkerState[key]` equals this
 * sentinel, the result is `missing` - no modifier fired for this
 * dimension in this ref's scope.
 */
export function walkerString(
  ctx: PredicateContext,
  key: string,
  initialSentinel: string,
): WalkerStringResult {
  // Guard against a tracker that reuses `"unknown"` as its initial
  // sentinel. Accepting such a value here would silently collapse the
  // three-way discrimination back into the pre-U1 two-step: the
  // `missing` branch would swallow genuine dynamic-checkout signals
  // and the predicate would exec-fallback onto the PRE-checkout
  // branch — exactly the bug U1 exists to prevent. The JSDoc on
  // WalkerStringResult documents this; the assertion makes the
  // contract un-foot-shootable for new tracker authors.
  if (initialSentinel === "unknown") {
    throw new Error(
      `[pi-steering/git] walkerString: tracker initialSentinel cannot be ` +
        `"unknown" — it's reserved for the unresolvable-dynamic-value ` +
        `signal. Use a distinct initial value (e.g. "" or a sentinel ` +
        `like NO_CHECKOUT_IN_CHAIN). See WalkerStringResult JSDoc.`,
    );
  }
  const v = ctx.walkerState?.[key];
  if (typeof v !== "string") return { kind: "missing" };
  if (v === initialSentinel) return { kind: "missing" };
  if (v === "unknown") return { kind: "unknown" };
  return { kind: "value", value: v };
}

// ---------------------------------------------------------------------------
// tryExec (branch predicate's tracker-missing fallback)
// ---------------------------------------------------------------------------

/**
 * Direct one-shot git exec used only by the `branch` predicate's
 * tracker-missing fallback (the predicate's three-way tracker
 * discrimination stays in predicate-land; see the `branch` JSDoc
 * below AND `../helpers/git-ops.ts` file header "Branch caveat" for
 * why `getBranch` is NOT called here).
 * Other predicates delegate to helpers in `../helpers/git-ops.ts` and
 * don't need this.
 *
 * Mirrors the failure-collapse contract of `tryGit` in git-ops:
 * non-zero exit, spawn error, or thrown exception → `null`.
 */
async function tryExec(
  ctx: PredicateContext,
  cmd: string,
  args: readonly string[],
  cwd?: string,
): Promise<string | null> {
  try {
    const res = await ctx.exec(
      cmd,
      [...args],
      cwd !== undefined ? { cwd } : undefined,
    );
    if (res.exitCode !== 0) return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

/**
 * `when.branch` - match the current git branch.
 *
 * Accepted arg shapes:
 *
 *   ```ts
 *   when: { branch: /^main$/ }                                  // single Pattern
 *   when: { branch: "^feat-" }                                   // single Pattern (string)
 *   when: { branch: [/^main$/, /^master$/, /^trunk$/] }          // Pattern[] (any-of)
 *   when: { branch: { pattern: /^main$/, onUnknown: "allow" } }  // object form
 *   when: { branch: { pattern: [/^main$/, /^master$/], onUnknown: "allow" } }
 *   ```
 *
 * Array semantics: OR-of-matches (rule fires when the resolved
 * branch matches ANY of the listed patterns). Empty arrays are
 * invalid (rule skips); arrays containing non-Pattern values are
 * invalid (rule skips).
 *
 * Resolution order:
 *   1. `ctx.walkerState.branch` - set by the branch tracker when the
 *       current bash chain contains `git checkout` / `git switch`.
 *       Three outcomes:
 *         - value resolved statically (e.g. `git checkout main`) ->
 *           match the pattern against it.
 *         - `"unknown"` sentinel (dynamic checkout like `git checkout
 *           $VAR`) -> apply `onUnknown` policy. Do NOT fall through
 *           to exec: a `git branch --show-current` call here would
 *           return the PRE-checkout branch (the walker exists to
 *           track exactly this kind of in-chain change statically).
 *         - missing (no checkout in chain) -> fall through to exec.
 *   2. `git branch --show-current` in `ctx.cwd`. Empty stdout is
 *       treated as "no branch" (detached HEAD) - the predicate falls
 *       back to `onUnknown`.
 *
 * `onUnknown` default is `"block"` (fail-closed): if we can't
 * determine the branch, the predicate reports "match" so
 * branch-gated rules still fire.
 */
export const branch: PredicateHandler = async (value, ctx) => {
  const arg = unwrapPatternArg(value);
  if (arg === null) return false;

  // 1. Walker state (tracker-resolved mid-command).
  const fromWalker = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
  if (fromWalker.kind === "value") {
    return arg.patterns.some((p) => matchPattern(p, fromWalker.value));
  }
  if (fromWalker.kind === "unknown") {
    // Dynamic in-chain checkout. Exec would return the PRE-checkout
    // branch, which is the case the walker exists to catch. Apply
    // the predicate's `onUnknown` policy instead of falling through.
    return unknownVerdict(arg.onUnknown);
  }

  // 2. Shell out (tracker saw no in-chain checkout).
  const out = await tryExec(ctx, "git", ["branch", "--show-current"], ctx.cwd);
  if (out === null || out.length === 0) return unknownVerdict(arg.onUnknown);
  return arg.patterns.some((p) => matchPattern(p, out));
};
