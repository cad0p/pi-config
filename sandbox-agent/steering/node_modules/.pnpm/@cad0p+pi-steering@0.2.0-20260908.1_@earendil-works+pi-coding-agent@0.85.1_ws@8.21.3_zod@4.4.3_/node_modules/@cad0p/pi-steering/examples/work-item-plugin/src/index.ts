// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Work-item example plugin — canonical reference for pi-steering
 * plugin authors (ADR §15).
 *
 * What this plugin demonstrates, file-by-file:
 *
 *   - `predicates/work-item-format.ts`
 *       - `definePredicate<T>` for typed predicate-arg variance.
 *       - Structured arg access via `input.args` (quote-aware).
 *   - `observers/npm-test-tracker.ts`
 *       - ADR §14 encapsulation convention: file exports the
 *         `<EVENT>_EVENT` constant AND a `mark<Event>(ctx)` helper;
 *         observer uses the helper.
 *       - `writes` declaration threading through for
 *         `defineConfig`'s compile-time type checking.
 *   - `observers/retest-required-tracker.ts`
 *       - Invalidation-sentinel pattern: observer writes
 *         `RETEST_REQUIRED_EVENT` on `git pull`, which stale-s
 *         prior `TEST_PASSED_EVENT` entries via `missing.since`.
 *   - `rules/commit-requires-work-item.ts`
 *       - Plugin-registered predicate consumption via `when.<key>`.
 *       - `not:` inversion in a {@link TopLevelWhenClause}.
 *   - `rules/push-requires-tests.ts`
 *       - `when.missing: { in: "agent_loop" }` gating.
 *       - Observer → rule coupling via the shared EVENT constants.
 *       - Temporal invalidation via `missing.since`.
 *       - Chain-aware speculative allow for `npm test && git push`.
 *   - `rules/commit-description-check.ts`
 *       - Self-marking rules with `onFire`.
 *       - Constant + helper co-located with the rule when no
 *         observer corresponds (ADR §14).
 *   - `trackers/env-loader.ts`
 *       - `.envrc`-style env loader as a `trackerExtensions.env`
 *         modifier on the SHARED built-in env tracker — an issue-54
 *         parity example: the injected variable is visible to rules
 *         AND observer watch matching via the same walk registry.
 *
 * Copy-adapt this layout. A real plugin likely ships more rules and
 * possibly a tracker too — see `src/plugins/git/`
 * for the tracker + tracker-extension pattern.
 *
 * ## Consuming this plugin
 *
 * ```ts
 * import { defineConfig } from "@cad0p/pi-steering";
 * import workItemPlugin from "@examples/work-item-plugin";
 *
 * export default defineConfig({
 *   plugins: [workItemPlugin],
 * });
 * ```
 */

import type { Plugin, PredicateShape } from "@cad0p/pi-steering";
import {
  npmTestTracker,
  TEST_PASSED_EVENT,
} from "./observers/npm-test-tracker.ts";
import {
  RETEST_REQUIRED_EVENT,
  retestRequiredTracker,
} from "./observers/retest-required-tracker.ts";
import type { WorkItemFormatArgs } from "./predicates/work-item-format.ts";
import { workItemFormat } from "./predicates/work-item-format.ts";
import {
  commitDescriptionCheck,
  DESCRIPTION_REVIEWED_EVENT,
} from "./rules/commit-description-check.ts";
import { commitRequiresWorkItem } from "./rules/commit-requires-work-item.ts";
import { pushRequiresTests } from "./rules/push-requires-tests.ts";
import {
  LOADED_VALUE,
  LOADED_VAR,
  sourceEnvLoader,
} from "./trackers/env-loader.ts";

declare global {
  /**
   * Plugin author registers `workItemFormat:` so the engine's mapped
   * type ({@link TopLevelWhenClause}) accepts it as a leaf-level key
   * with a typed argument shape. Without this augmentation, rules in
   * this plugin (or any consumer's rules) referencing `workItemFormat:`
   * would fail typecheck against the strict registry-driven type.
   *
   * @see PredicateShape, PiSteeringPredicates in pi-steering's schema.
   */
  interface PiSteeringPredicates {
    workItemFormat: PredicateShape<WorkItemFormatArgs>;
  }
}

// Re-export the type constants so consumers (e.g. another plugin or
// a user's custom rule) can gate on the same events without
// rediscovering the literal strings.
export { DESCRIPTION_REVIEWED_EVENT, RETEST_REQUIRED_EVENT, TEST_PASSED_EVENT };

/**
 * The plugin. `as const satisfies Plugin` preserves the literal
 * `name: "work-item"` and the `writes` tuples from rules/observers
 * so `defineConfig` can cross-reference `when.missing.event` usages
 * against this plugin's declared writes. See the ADR §7 footgun
 * about bare `: Plugin` annotations.
 */
const workItemPlugin = {
  name: "work-item",
  predicates: { workItemFormat },
  rules: [commitRequiresWorkItem, pushRequiresTests, commitDescriptionCheck],
  observers: [npmTestTracker, retestRequiredTracker],
  // `.envrc`-style env loader composed onto the shared built-in `env`
  // tracker (see `trackers/env-loader.ts`). Demonstrates the issue-54
  // parity contract: rules and observer watch matching resolve the
  // injected var through the SAME walk registry.
  trackerExtensions: {
    env: { "source-env": sourceEnvLoader() },
  },
} as const satisfies Plugin;

export default workItemPlugin;

export {
  markTestPassed,
  npmTestTracker,
} from "./observers/npm-test-tracker.ts";
export {
  markRetestRequired,
  retestRequiredTracker,
} from "./observers/retest-required-tracker.ts";
// Named re-exports — pick-your-piece imports for authors who want
// just one rule or the predicate.
export { workItemFormat } from "./predicates/work-item-format.ts";
export {
  commitDescriptionCheck,
  markDescriptionReviewed,
} from "./rules/commit-description-check.ts";
export { commitRequiresWorkItem } from "./rules/commit-requires-work-item.ts";
export { pushRequiresTests } from "./rules/push-requires-tests.ts";
export {
  LOADED_VALUE,
  LOADED_VAR,
  sourceEnvLoader,
} from "./trackers/env-loader.ts";
