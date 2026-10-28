// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * rm plugin for `@cad0p/pi-steering`.
 *
 * Subpath import: `pi-steering/plugins/rm`.
 *
 * Registers (in the terms of `Plugin`):
 *
 *   - `predicates`         - `hasRecursiveForce`, the
 *                             recursive-AND-force-AND-rooted-at-`/`
 *                             core of `no-rm-rf-slash`. See the
 *                             per-item file under `./predicates/`.
 *   - `rules` - `no-rm-rf-slash`, the recursive-force-delete-from-root
 *     guard. Non-overridable (`noOverride: true`) — inherent
 *     destructiveness, no inline override escape hatch; users opt out
 *     via `disabledRules: ["no-rm-rf-slash"]` or by not declaring the
 *     plugin.
 *
 * Opt-in: registered ONLY when the user declares it:
 *
 * ```ts
 * import rmPlugin from "@cad0p/pi-steering/plugins/rm";
 * export default defineConfig({ plugins: [rmPlugin] });
 * ```
 *
 * Declaring it explicitly also feeds its rule name into
 * `defineConfig`'s type unions (typo-checking on `disabledRules`);
 * relying on an undeclared plugin would silently widen the union and
 * let typos through.
 *
 * ## Note for plugin authors
 *
 * Layout mirrors the canonical git plugin: one file per concern, a
 * terse default export assembling them. Copy-adapt liberally.
 */

import type {
  AnyPredicateHandler,
  Plugin,
  PredicateShape,
  Rule,
} from "../../schema.ts";
import { RM_CLI_DESCRIPTOR } from "./descriptors.ts";
import { hasRecursiveForce } from "./predicates/has-recursive-force.ts";
import { noRmRfSlash } from "./rules/no-rm-rf-slash.ts";

declare global {
  /**
   * rmPlugin's typed-predicate registry. Each entry declares the
   * predicate's `bare` value type and (optionally) an explicit
   * `spreadBase` (see `PredicateShape` in `schema.ts`).
   *
   * @see PredicateShape, DefaultSpreadBase, PredicateModifiers in
   *      `schema.ts` for the full registry contract.
   */
  interface PiSteeringPredicates {
    /**
     * `when.hasRecursiveForce` — match `rm` refs carrying BOTH the
     * recursive and the force flag AND targeting `/`. Boolean leaf;
     * spreadBase auto-detects to `{ value: boolean }`.
     */
    hasRecursiveForce: PredicateShape<boolean>;
  }
}

/**
 * Predicate handlers the rm plugin registers under
 * `Plugin.predicates`. Keys become the `when.<key>` slots rule authors
 * see.
 *
 * Typed as `Record<string, AnyPredicateHandler>` to match
 * {@link Plugin.predicates} at the registry boundary — each handler's
 * concrete argument shape is preserved in its own module.
 */
export const predicates: Record<string, AnyPredicateHandler> = {
  hasRecursiveForce,
};

/**
 * Rules shipped by the rm plugin.
 */
export const rules = [noRmRfSlash] as const satisfies readonly Rule[];

/**
 * The rm plugin. Default export so `import rmPlugin from
 * "pi-steering/plugins/rm"` gives you the whole thing.
 *
 * `as const satisfies Plugin` (rather than `: Plugin`) preserves the
 * literal `name: "rm"` in the inferred type — the input to
 * `defineConfig`'s rule / plugin name unions, which need the literal
 * (not `name: string`) to offer typo detection on e.g.
 * `disabledRules`.
 */
const rmPlugin = {
  name: "rm",
  cliDescriptors: { rm: RM_CLI_DESCRIPTOR },
  predicates,
  rules,
} as const satisfies Plugin;

/**
 * Type-level regression sentinel: if the plugin literal ever loses
 * the `name: "rm"` narrowing (for example, someone reintroducing
 * `: Plugin` annotation), the inferred type of `RM_PLUGIN_NAME`
 * widens to `string` and any downstream literal-name inference
 * breaks. Keep this export in place to fail compilation loudly when
 * that happens.
 */
export const RM_PLUGIN_NAME: "rm" = rmPlugin.name;

export default rmPlugin;

export {
  RM_CLI_DESCRIPTOR,
  RM_FORCE_FLAG,
  RM_RECURSIVE_FLAG,
} from "./descriptors.ts";
export { hasRecursiveForce } from "./predicates/has-recursive-force.ts";
export { noRmRfSlash };
