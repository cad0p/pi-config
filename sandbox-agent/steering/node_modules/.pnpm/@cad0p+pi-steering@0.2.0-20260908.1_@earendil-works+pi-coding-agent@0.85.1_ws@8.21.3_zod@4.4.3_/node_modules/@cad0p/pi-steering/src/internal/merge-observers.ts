// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared observer-merge helper used by both the evaluator's reverse
 * index (`when.missing` with `in: "tool_call"`) and the observer-dispatcher's
 * fire list.
 *
 * Both callers need the same answer to the question "what observers
 * does this config have, after resolving plugins and applying user
 * overrides?" Keeping a single implementation here prevents silent
 * drift — if the dispatcher drops a plugin observer because a user
 * observer shadows it by name, the evaluator's reverse-index must do
 * the same, or tool_call-scope speculative allow can grant on a watch
 * pattern that will never actually fire.
 *
 * Merge semantics (must match `buildObserverDispatcher`):
 *   1. User observers come first (user-wins on name collision).
 *   2. Plugin observers fill in any names not already seen.
 *
 * The order mirrors the rule-list "user overrides plugin by declaring
 * their own" pattern documented on `buildObserverDispatcher`.
 */

import type { Observer } from "../schema.ts";

/**
 * Merge user-level and plugin-level observers into a single list with
 * first-registered dedup by `name`. User observers always precede
 * plugin observers of the same name.
 *
 * Returns a fresh array; neither input is mutated.
 */
export function mergeObserversUserFirst(
  userObservers: readonly Observer[],
  pluginObservers: readonly Observer[],
): Observer[] {
  const merged: Observer[] = [];
  const seen = new Set<string>();
  for (const o of userObservers) {
    if (seen.has(o.name)) continue;
    seen.add(o.name);
    merged.push(o);
  }
  for (const o of pluginObservers) {
    if (seen.has(o.name)) continue;
    seen.add(o.name);
    merged.push(o);
  }
  return merged;
}
