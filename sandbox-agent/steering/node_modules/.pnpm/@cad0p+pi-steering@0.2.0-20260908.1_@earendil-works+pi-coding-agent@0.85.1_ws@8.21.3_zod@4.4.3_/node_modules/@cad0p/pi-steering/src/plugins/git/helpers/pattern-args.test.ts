// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's shared pattern-arg helpers
 * (`./pattern-args.ts`).
 *
 * The helpers (`unwrapPatternArg`, `matchPattern`, `unknownVerdict`,
 * `cwdIsWalkerUnknown`) are exercised end-to-end through the
 * pattern-valued predicate handlers' test files (`branch.test.ts`,
 * `upstream.test.ts`, `remote.test.ts`) and the cross-predicate
 * walker-unknown-cwd matrix in `../predicates/shared.test.ts` — the
 * original `predicates.test.ts` had no direct-shape tests for these
 * helpers beyond those handler-level paths, so this file carries no
 * standalone cases.
 */
