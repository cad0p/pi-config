// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Shared helper for seeding walker trackers from `process.env`.
 *
 * Both `cwdTracker` (via its `resolveHome` fallback when the env
 * tracker isn't registered) and `envTracker` (as its initial state)
 * read HOME, USER, and PWD from `process.env` at initialization.
 * Keeping the read in one helper ensures the two paths can't drift
 * on which variables count as "seed" data.
 *
 * Scope: HOME / USER / PWD only. These are the shell-ubiquitous
 * variables whose absence would break the most common agent chains
 * (`cd ~`, `cd "$HOME/..."`, `cd "$PWD/..."`). Expanding the seed
 * set further would make ordinary process.env pollution
 * statically visible to rules — intentionally out of scope.
 *
 * Per-call cost: O(3) map entries; ~100 ns warm. Safe to call on
 * every walk, which is the pattern {@link cwdTracker}'s
 * process-env fallback uses so tests that mutate process.env
 * between walks see the current values.
 */
export type SeededEnv = ReadonlyMap<string, string>;

/**
 * Build a fresh env-map snapshot from `process.env.{HOME, USER,
 * PWD}`. Returns a new Map each call — callers may wrap in
 * `ReadonlyMap` when exposing to predicates but must not mutate
 * the returned instance if they intend to reuse it.
 */
export function seedProcessEnv(): Map<string, string> {
  const out = new Map<string, string>();
  const { HOME, USER, PWD } = process.env;
  if (HOME !== undefined) out.set("HOME", HOME);
  if (USER !== undefined) out.set("USER", USER);
  if (PWD !== undefined) out.set("PWD", PWD);
  return out;
}
