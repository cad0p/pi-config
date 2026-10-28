// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `.envrc`-style env loader — demonstrated as a
 * `trackerExtensions.env` modifier on the SHARED built-in `env`
 * tracker (issue #54 parity example).
 *
 * The pi-steering engine resolves bash commands against a walker
 * registry (rules BEFORE the call, observer watch matching AFTER the
 * call). Plugins can influence that resolution either by REPLACING a
 * tracker (`trackers: { env }`) or — as shown here — by COMPOSING a
 * modifier onto the built-in tracker via `trackerExtensions.env`
 * (`env` is a known built-in: `EVALUATOR_BUILTIN_TRACKERS`). The
 * merger keeps the extension, and the engine's `buildWalkRegistry`
 * layers it onto the built-in env tracker.
 *
 * Because both surfaces derive their registry from the same
 * `buildWalkRegistry(resolved)`, a variable injected by this loader
 * is visible to rules AND to observer watch matching — the parity
 * contract this example pins (before the fix, observers rewound the
 * command with the built-in env tracker only and matched raw `$VAR`
 * forms while rules saw resolved ones).
 *
 * The modifier triggers on the `source-env` basename (a stand-in for
 * an actual `.envrc`/`direnv` hook) and injects a probe variable into
 * the walker's env state, leaving the rest intact.
 */

import type { Modifier } from "@cad0p/unbash-walker";

/** Variable this loader injects into the walker env state. */
export const LOADED_VAR = "WORK_ITEM_LOADED_VAR" as const;
/** Value the loader injects. */
export const LOADED_VALUE = "env-loaded" as const;

/**
 * Sequential env-loader modifier: when the walker visits a command
 * whose basename is `source-env`, it extends the current env state
 * with {@link LOADED_VALUE}. Sequential scope means later refs in the
 * same scope (e.g. the `echo` chained after `source-env && …`) see
 * the injected variable — mirroring how a real `.envrc` export would
 * behave.
 */
export function sourceEnvLoader(): Modifier<unknown> {
  return {
    scope: "sequential",
    apply: (_args, current) => {
      // Env-tracker state is a ReadonlyMap<string,string>; widen to a
      // mutable copy so we never mutate the tracker's seeded map.
      const base = current instanceof Map ? new Map(current) : new Map();
      base.set(LOADED_VAR, LOADED_VALUE);
      return base;
    },
  };
}
