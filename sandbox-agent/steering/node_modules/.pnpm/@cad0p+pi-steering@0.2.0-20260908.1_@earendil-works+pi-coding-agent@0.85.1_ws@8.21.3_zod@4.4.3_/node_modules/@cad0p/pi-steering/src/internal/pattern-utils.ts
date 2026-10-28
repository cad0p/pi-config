// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared pattern utilities reused across the engine and the gitPlugin's
 * predicate handlers. Lives in `internal/` because both the engine
 * (`evaluator-internals/predicates.ts`) and the gitPlugin
 * (`plugins/git/predicates.ts`) need the same `Pattern` narrowing
 * helper, and the engine cannot import from a plugin without inverting
 * the dependency graph.
 *
 * The two normalization sites stay independent (the engine's
 * `evaluateCwd` keeps its inline fast-path optimization for the
 * single-pattern shorthand; the gitPlugin's `unwrapPatternArg`
 * normalizes once and shares the result across `branch` / `upstream`
 * / `remote`); only the type predicate is shared.
 */

import type { Pattern } from "../schema.ts";

/**
 * Type predicate for {@link Pattern} (`string | RegExp`). Used by the
 * pattern-valued predicates (`cwd`, `branch`, `upstream`, `remote`) to
 * narrow `unknown[]` array elements to `Pattern[]` for safe iteration:
 *
 *     if (Array.isArray(value) && value.every(isPattern)) {
 *         // value is Pattern[] here
 *         return value.some(p => matchesPattern(p, target));
 *     }
 *
 * Without the `v is Pattern` type predicate, the same expression
 * (`value.every(v => typeof v === "string" || v instanceof RegExp)`)
 * does NOT narrow `value` from `unknown[]` to `Pattern[]` — TypeScript
 * needs the explicit type-predicate signature for the narrowing to
 * propagate through `Array.isArray` + `.every`.
 */
export const isPattern = (v: unknown): v is Pattern =>
  typeof v === "string" || v instanceof RegExp;
