// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared argument-unwrapping helpers for the git plugin's
 * pattern-valued predicates (`branch`, `upstream`, `remote`).
 *
 * Extracted verbatim from the rules bulk file during the per-item layout
 * refactor — the pattern-normalization contract (shorthand forms,
 * OR-of-matches array semantics, fail-skip on malformed input) is
 * shared by all three handlers and lives here so the per-predicate
 * files stay thin.
 */

import { isPattern } from "../../../internal/pattern-utils.ts";
import type { Pattern, PredicateContext } from "../../../schema.ts";

// ---------------------------------------------------------------------------
// Walker-unknown cwd guard (inline trinary)
// ---------------------------------------------------------------------------

/**
 * Inline trinary guard for runtime-cwd predicates: returns `true` when
 * the walker couldn't statically resolve the command's effective cwd
 * (the cwd-tracker `"unknown"` sentinel is on `ctx.walkerState.cwd`),
 * which signals to the caller that the handler should bail with
 * `"unknown"` instead of querying the wrong repo.
 *
 * Each runtime-cwd handler in this module starts with:
 *
 *   ```ts
 *   if (cwdIsWalkerUnknown(ctx)) return "unknown";
 *   ```
 *
 * Surfacing walker-unknown as trinary `"unknown"` lets the engine
 * apply the leaf-level (or block-level, inside `not:`) `onUnknown:`
 * policy. Default `"block"` is fail-CLOSED (the rule fires); a user
 * with `onUnknown: "allow"` opts into fail-OPEN handling.
 * Self-documenting + composable.
 */
export function cwdIsWalkerUnknown(ctx: PredicateContext): boolean {
  return ctx.walkerState?.cwd === "unknown";
}

/**
 * Normalize the shorthand forms accepted by the pattern-valued
 * predicates (`branch`, `upstream`, `remote`) into a canonical
 * `{ patterns, onUnknown }` shape:
 *
 *   - `Pattern`                                  -> `{ patterns: [pattern], onUnknown: "block" }`
 *   - `Pattern[]`  (non-empty, all-Pattern)      -> `{ patterns, onUnknown: "block" }`
 *   - `{ pattern: Pattern, onUnknown? }`         -> object used as-is,
 *                                                    `pattern` re-wrapped
 *                                                    into a single-element
 *                                                    array; `onUnknown`
 *                                                    defaults to `"block"`.
 *   - `{ pattern: Pattern[], onUnknown? }`       -> array preserved,
 *                                                    same `onUnknown`
 *                                                    handling.
 *
 * Array semantics are OR-of-matches: the rule fires when the input
 * matches ANY of the listed patterns. Array form requires at least
 * one pattern (empty arrays are invalid).
 *
 * Returning `null` means the author supplied something that isn't a
 * valid value for this predicate (e.g. a bare number, an empty array,
 * or an array containing a non-Pattern value); handlers treat that as
 * a non-match and don't throw - invalid config shouldn't crash the
 * evaluator, but it also shouldn't silently fire.
 */
export function unwrapPatternArg(value: unknown): {
  patterns: Pattern[];
  onUnknown: "allow" | "block";
} | null {
  // Shorthand: single Pattern.
  if (isPattern(value)) {
    return { patterns: [value], onUnknown: "block" };
  }
  // Shorthand: Pattern[] (must be non-empty + all-Pattern).
  if (Array.isArray(value) && value.every(isPattern)) {
    if (value.length === 0) return null;
    return { patterns: value, onUnknown: "block" };
  }
  // Object form: { pattern: Pattern | Pattern[]; onUnknown? }.
  if (
    value !== null &&
    typeof value === "object" &&
    "pattern" in (value as Record<string, unknown>)
  ) {
    const obj = value as {
      pattern?: unknown;
      onUnknown?: "allow" | "block";
    };
    const onUnknown = obj.onUnknown === "allow" ? "allow" : "block";
    if (isPattern(obj.pattern)) {
      return { patterns: [obj.pattern], onUnknown };
    }
    if (Array.isArray(obj.pattern) && obj.pattern.every(isPattern)) {
      if (obj.pattern.length === 0) return null;
      return { patterns: obj.pattern, onUnknown };
    }
  }
  return null;
}

/** Test a Pattern against a concrete string. */
export function matchPattern(pattern: Pattern, target: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(target);
  return new RegExp(pattern).test(target);
}

/**
 * Apply the predicate's `onUnknown` policy to a shell failure or
 * tracker-unknown case. "block" means the predicate reports "match"
 * (rule fires); "allow" means the predicate reports "no match" (rule
 * skips). Fail-closed default.
 */
export function unknownVerdict(onUnknown: "allow" | "block"): boolean {
  return onUnknown === "block";
}
