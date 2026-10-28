// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared boolean-leaf argument unwrapping for boolean-predicate
 * authors (`isClean`, `hasStagedChanges`, `isForcePush`,
 * `hasRecursiveForce`, and any external boolean predicate).
 *
 * Promoted here from the git plugin during the issue #117 command-
 * filter work — four boolean handlers accept the same bare / spread
 * shapes and share this single unwrap implementation.
 */

import type { PredicateModifiers, PredicateShape } from "../schema.ts";

/**
 * Canonical argument shape for boolean-leaf predicates.
 *
 * DERIVED from the registry machinery — not hand-spelled: bare plus
 * the auto-detected `{ value }` spread plus the framework-applied
 * `onUnknown` modifier, i.e. exactly the outer-leaf composition
 * (`OuterValue`) for `PredicateShape<boolean>`:
 * `DefaultSpreadBase<boolean>` → `{ value: boolean }`, intersected
 * with {@link PredicateModifiers} at the outer leaf level. The handler
 * treats `onUnknown:` as opaque (engine's `readLeafOnUnknown` owns
 * projection).
 */
export type BooleanLeafArgs =
  | PredicateShape<boolean>["bare"]
  | (PredicateShape<boolean>["spreadBase"] & PredicateModifiers);

/**
 * Unwrap the boolean payload from a {@link PredicateShape}<boolean>
 * argument. Plugin-author API for boolean predicates: accepts the
 * bare form (`true` / `false`) and the spread form
 * (`{ value: true, onUnknown? }` / `{ value: false, onUnknown? }`).
 *
 * Malformed input returns `undefined` — the caller decides what to
 * do with that (typically `return false`, mirroring the existing
 * pattern-unwrap fail-closed contract).
 *
 * `onUnknown:` is an opaque sibling owned by the engine's
 * `readLeafOnUnknown` projection — the handler never reads it and
 * only consumes `value:`.
 *
 * Used by {@link isClean}, {@link hasStagedChanges},
 * {@link isForcePush}, and {@link hasRecursiveForce}; all ship
 * with `PredicateShape<boolean>` in the registry so the bare/spread
 * shape is identical at the type level too.
 */
export function unwrapBooleanLeafArg(args: unknown): boolean | undefined {
  if (typeof args === "boolean") return args;
  if (
    args !== null &&
    typeof args === "object" &&
    typeof (args as { value?: unknown }).value === "boolean"
  ) {
    return (args as { value: boolean }).value;
  }
  return undefined;
}

/**
 * Test alias of {@link unwrapBooleanLeafArg}. Direct unit tests pin
 * malformed-input branches that are hard to drive via the engine
 * end-to-end.
 *
 * @internal
 */
export const _unwrapBooleanLeafArg = unwrapBooleanLeafArg;
