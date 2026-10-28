// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `defineConfig` — compile-time-typed config builder.
 *
 * Two supported authoring styles per the accepted ADR ("Design →
 * `defineConfig` and compile-time inference"):
 *
 *   1. **`defineConfig`** — uses `const`-generics on plugins / observers
 *      to infer the union of observer names, then constrains
 *      {@link Rule.observer} string references to that union. Typos in
 *      `observer: "description-read"` (when the plugin registers
 *      `description-reads`) produce a compile error.
 *
 *   2. **`satisfies SteeringConfig`** — plain TypeScript construct users
 *      can fall back to when they don't want the generic inference
 *      complexity. Gets shape validation but no cross-reference name
 *      checking.
 *
 * The function itself does minimal runtime work — it just returns the
 * config unchanged. All the value is in the types.
 *
 * Generics threaded through (ADR §8):
 *   - `AllObserverNames<P, Inline>`  — for `Rule.observer` string refs.
 *   - `AllWrites<P, R, Inline>`      — for `Rule.when.missing.event`.
 *   - `AllRuleNames<P, R>`           — for `config.disabledRules`.
 *   - `AllPluginNames<P>`            — for `config.disabledPlugins`.
 *   - `AllBasenames<P>`              — for bash-rule `command` (issue #117).
 *   - `PluginExemptionsCheck<P, R>`  — for plugin-shipped `exemptions`
 *     targets (cross-checked against the same rule-name universe as
 *     user-written `exemptions` / `disabledRules`).
 *
 * All five helpers are exported from this module but NOT re-exported
 * from the package root; they're internal plumbing, not user-facing
 * API. Stable enough that plugin authors who import them directly can
 * rely on their shape within a single minor version, but the contract
 * is "use via defineConfig".
 */

import type {
  Basename,
  BuiltInWhenLeavesOuter,
  Exemption,
  Observer,
  Plugin,
  Rule,
  SteeringConfig,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Type-level plumbing: project `name` / `writes` literals off tuples of
// rules, observers, or plugins.
// ---------------------------------------------------------------------------

/**
 * Pull a single projection off every element of an array type.
 *
 *   - `K = "name"`   — value is the element's `name` literal
 *                       (`{ name: N }` → `N`).
 *   - `K = "writes"` — value is each element of the element's
 *                       `writes` tuple (`{ writes: readonly [..., S] }`
 *                       → `S`).
 *
 * Elements missing the field (optional `writes`, widened `name`)
 * contribute `never`. Non-tuple `T` inputs short-circuit to `never`.
 */
type ProjectField<
  T,
  K extends "name" | "writes",
> = T extends readonly (infer E)[]
  ? E extends Record<K, infer V>
    ? K extends "writes"
      ? V extends readonly (infer S extends string)[]
        ? S
        : never
      : V extends string
        ? V
        : never
    : never
  : never;

/**
 * Walk a tuple of plugins and union a {@link ProjectField} projection
 * across every plugin's `Source` array (`"rules"` or `"observers"`).
 *
 * Replaces four near-identical recursive walkers that differed only in
 * `(Source, K)` pair — see git blame for the pre-R2 shape.
 */
type FromPluginField<
  P extends readonly Plugin[],
  Source extends "rules" | "observers",
  K extends "name" | "writes",
> = P extends readonly [infer First, ...infer Rest]
  ?
      | (First extends Plugin
          ? First[Source] extends infer X
            ? X extends readonly (Rule | Observer)[]
              ? ProjectField<X, K>
              : never
            : never
          : never)
      | (Rest extends readonly Plugin[]
          ? FromPluginField<Rest, Source, K>
          : never)
  : never;

/**
 * Extract the union of observer names registered across:
 *   - every plugin's `observers: Observer[]` array, AND
 *   - the top-level inline `observers: Observer[]` array.
 *
 * Used to constrain string references in {@link Rule.observer} so typos
 * surface as compile errors in `defineConfig` call sites.
 *
 * Falls back to `never` when no observers are registered (correct:
 * string references should be rejected entirely when there's nothing
 * to reference).
 */
export type AllObserverNames<
  P extends readonly Plugin[],
  Inline extends readonly Observer[],
> = FromPluginField<P, "observers", "name"> | ProjectField<Inline, "name">;

// ---------------------------------------------------------------------------
// AllPluginNames — union of plugin `.name` literals across loaded plugins.
// ---------------------------------------------------------------------------

/**
 * Extract the union of plugin names registered in the `plugins` tuple.
 *
 * Used to constrain {@link SteeringConfig.disabledPlugins} so typos
 * surface as compile errors. There are no engine-injected default
 * plugins (issue #72): a name only enters this union by declaring the
 * shipping plugin in `plugins`, which is exactly the runtime
 * registration contract — type-level visibility and runtime state
 * cannot diverge.
 *
 * Falls back to `never` when no plugins are registered — ANY
 * `disabledPlugins` entry without a declared plugin is a compile
 * error.
 */
export type AllPluginNames<P extends readonly Plugin[]> = ProjectField<
  P,
  "name"
>;

/**
 * Extract the union of CLI basenames declared via `cliDescriptors`
 * keys across the `plugins` tuple (issue #117).
 *
 * Used to constrain {@link Rule} `command` on bash rules so typos
 * surface as compile errors (`command: "gti"` with only `git` / `rm`
 * descriptors in scope is rejected). Plugin-shipped tables and
 * inline-literal plugin `cliDescriptors` keys in the same `plugins:`
 * tuple both contribute; a widened `: Plugin` element contributes
 * `string` ("can't verify" means "skip" — the runtime backstop in
 * `buildEvaluator` throws loud on unknown `command` basenames at
 * build time to cover that path).
 *
 * Falls back to `never` when no plugin declares a descriptor — any
 * `command:` literal without a declared table is then a compile
 * error (correct: nothing routes without facts).
 */
export type AllBasenames<P extends readonly Plugin[]> = Basename<P>;

// ---------------------------------------------------------------------------
// AllRuleNames — union of rule `.name` literals across plugins + user rules.
// ---------------------------------------------------------------------------

/**
 * Extract the union of rule names across:
 *   - every declared plugin's `rules: Rule[]` array, AND
 *   - the top-level inline `rules: Rule[]` array.
 *
 * Used to constrain {@link SteeringConfig.disabledRules} so typos
 * surface as compile errors. There are no engine-shipped default
 * rules (issue #72): a name only enters this union via a declared
 * plugin or an inline rule — disabling `no-force-push` typechecks iff
 * the git plugin (its shipping plugin) is declared.
 *
 * Falls back to `never` when no plugin or user rules are registered —
 * any `disabledRules` entry is then a compile error.
 */
export type AllRuleNames<
  P extends readonly Plugin[],
  R extends readonly Rule[],
> = FromPluginField<P, "rules", "name"> | ProjectField<R, "name">;

// ---------------------------------------------------------------------------
// PluginExemptionsCheck — plugin-shipped exemption targets vs. rule names.
// ---------------------------------------------------------------------------

/**
 * Pull the union of `rule` name literals off ONE plugin's shipped
 * `exemptions` array.
 *
 * Plugins whose `exemptions[].rule` widened to `string` (bare
 * `: Plugin` annotation instead of `as const satisfies Plugin`)
 * contribute `never` — "can't verify" means "skip", never a
 * false-positive. A plugin with no `exemptions` field contributes
 * `never` too.
 */
type PluginExemptionTargetsOf<PL> = PL extends Plugin
  ? PL["exemptions"] extends readonly (infer E)[]
    ? E extends { rule: infer RName extends string }
      ? string extends RName
        ? never // widened → "can't verify" → skip
        : RName
      : never
    : never
  : never;

/**
 * Union every plugin's exemption-target literals across the `plugins`
 * tuple — the plugin-shipped counterpart of the rule-name union
 * user-written `exemptions[].rule` is typo-checked against.
 */
type PluginExemptionTargets<P extends readonly Plugin[]> = P extends readonly [
  infer First,
  ...infer Rest,
]
  ?
      | PluginExemptionTargetsOf<First>
      | (Rest extends readonly Plugin[] ? PluginExemptionTargets<Rest> : never)
  : never;

/**
 * Compile-time check that every plugin-shipped exemption target exists
 * in the config's rule-name universe.
 *
 * A plugin's `exemptions` carve out rules by name — possibly rules
 * shipped by ANOTHER plugin (e.g. a vault plugin exempting the git
 * plugin's `no-main-commit`; that plugin must be listed alongside in
 * `plugins`). If the shipping plugin is missing, the target is an
 * orphan: the config compiles clean but surfaces an `exemption-orphan`
 * ERROR at merge time — plugin-shipped orphans are error-class, so
 * the runtime always throws (regardless of `failOnWarnings`), the CLI
 * exits 1, and `loadHarness` short-circuits. This check makes the
 * failure compile-time instead.
 *
 * Semantics:
 *   - Targets are checked against the SAME universe user-written
 *     `exemptions` / `disabledRules` are checked against: default
 *     rules + listed plugins' rules + inline rules.
 *   - Plugins whose `exemptions[].rule` widened to `string` (bare
 *     `: Plugin` annotation) are skipped — "can't verify", never a
 *     false-positive. The runtime `exemption-orphan` backstop still
 *     covers them at merge time, now as a hard error (error-class).
 *   - The check is per-file: configs split across layers (global vs
 *     project) can false-positive because the runtime merges the
 *     layers' rule universes before the `detectExemptionOrphans`
 *     backstop runs. Keep a plugin and its target's shipping plugin
 *     in the same layer.
 *
 * On failure, the `plugins` slot of the config parameter gains a
 * synthetic per-element property `__steeringExemption` carrying the
 * message — the TS2322 error lands on the offending plugin element's
 * own line in the `plugins` array, naming the missing rule(s) and
 * hinting to install the plugin that ships them.
 *
 * Happy path (no plugin-shipped exemptions, or every target present)
 * resolves to `{}` — the intersection with `defineConfig`'s parameter
 * is a zero change to inference or runtime behavior.
 */
export type PluginExemptionsCheck<
  P extends readonly Plugin[],
  R extends readonly Rule[],
> =
  PluginExemptionTargets<P> extends AllRuleNames<P, R>
    ? // biome-ignore lint/complexity/noBannedTypes: the empty object type is the deliberate "zero change" happy path.
      {} // happy path: zero change
    : {
        plugins?: {
          [K in keyof P]: string extends PluginExemptionTargetsOf<P[K]>
            ? P[K]
            : PluginExemptionTargetsOf<P[K]> extends AllRuleNames<P, R>
              ? P[K]
              : P[K] & {
                  readonly __steeringExemption: `exemption target '${Exclude<PluginExemptionTargetsOf<P[K]>, AllRuleNames<P, R>>}' not found in this config; install the plugin that ships it`;
                };
        };
      };

// ---------------------------------------------------------------------------
// AllWrites — union of `writes[]` literals across rules + observers.
// ---------------------------------------------------------------------------

/**
 * Extract the union of session-entry custom types declared via `writes`
 * arrays across:
 *   - every plugin's `rules: Rule[]` (rule-side writes via `onFire`),
 *   - every plugin's `observers: Observer[]` (observer-side writes),
 *   - the top-level inline `rules`, AND
 *   - the top-level inline `observers`.
 *
 * Used to constrain {@link BuiltInWhenLeavesOuter.missing} `event` so typos
 * (e.g., `missing: { event: "sync-don" }` when the observer writes
 * `"sync-done"`) surface as compile errors.
 *
 * Authors who omit `writes` on a rule/observer don't contribute to the
 * union — the rule's write is undeclared, and any downstream
 * `when.missing.event` referencing it will be rejected. Matches the
 * "declare your writes" discipline that `writes[]` encourages.
 */
export type AllWrites<
  P extends readonly Plugin[],
  R extends readonly Rule[],
  Inline extends readonly Observer[] = readonly [],
> =
  | FromPluginField<P, "rules", "writes">
  | FromPluginField<P, "observers", "writes">
  | ProjectField<R, "writes">
  | ProjectField<Inline, "writes">;

// ---------------------------------------------------------------------------
// DefineConfigInput
// ---------------------------------------------------------------------------

/**
 * Config author surface — the shape `defineConfig` accepts. Matches
 * {@link SteeringConfig} but with `const`-generic tuple slots on
 * `plugins` / `rules` / `observers` so tuple literal types survive
 * through the call and drive name inference.
 *
 * Generic constraints:
 *   - `disabledRules` / `disabledPlugins` typed against the rule / plugin
 *     name unions — typos rejected at compile time.
 *   - `exemptions[].rule` typed against the same rule-name union as
 *     `disabledRules` — a carve-out targeting a typo'd rule name is
 *     rejected at compile time.
 *   - `rules[].when.missing.event` and `rules[].when.missing.since`
 *     are both typed against `AllWrites` — typos rejected at compile
 *     time. `exemptions[].when.missing.*` narrows the same way.
 */
export interface DefineConfigInput<
  P extends readonly Plugin[],
  Inline extends readonly Observer[],
  R extends readonly Rule<
    AllObserverNames<P, Inline>,
    AllWrites<P, R, Inline>,
    AllBasenames<P>
  >[],
> extends SteeringConfig {
  disabledRules?: readonly AllRuleNames<P, R>[];
  disabledPlugins?: readonly AllPluginNames<P>[];
  /**
   * Guard-rule carve-outs, typed so `rule` must name a real rule
   * (plugin rules or inline rules — same union as
   * {@link disabledRules}) and `when.missing.event` narrows against
   * the config's `writes` union. See {@link Exemption} for the
   * accumulation + fail-closed semantics.
   */
  exemptions?: readonly Exemption<
    AllWrites<P, R, Inline>,
    AllRuleNames<P, R>
  >[];
  plugins?: P;
  rules?: R;
  observers?: Inline;
}

/**
 * Build a {@link SteeringConfig} with cross-reference name checking.
 *
 * Observer references in {@link Rule.observer} are typed against the
 * union of observer names gathered from `plugins[*].observers` AND the
 * top-level `observers` array — a typo produces a compile error.
 *
 * The `disabledRules` / `disabledPlugins` arrays are typed against the unions
 * of registered rule / plugin names — typos rejected.
 *
 * `rules[].when.missing.event` and `rules[].when.missing.since` are
 * both typed against the union of all `writes` declarations across
 * plugin rules, plugin observers, user rules, and user observers —
 * typos rejected. (The `since` field on the `Writes` union enforces
 * the same contract as `event`: the sentinel event must be known to
 * the config, not a free-form string.)
 *
 * Runtime behavior: returns a shallow copy of the input with optional
 * fields normalized from `readonly` arrays to mutable arrays (the
 * {@link SteeringConfig} shape doesn't constrain mutability). The
 * return value is safe to pass to the loader / buildConfig.
 *
 * ## Authoring pattern — preserving observer/plugin names for inference
 *
 * For compile-time typo detection on rule `observer` references, declare
 * your observers and plugins with `as const satisfies` so TypeScript
 * preserves the literal `name` values through to `AllObserverNames`:
 *
 *     const myObs = {
 *       name: "description-read",
 *       onResult: (event, ctx) => { ... },
 *     } as const satisfies Observer;
 *
 *     const myPlugin = {
 *       name: "my-plugin",
 *       observers: [{ name: "sync-done", onResult: ... }],
 *     } as const satisfies Plugin;
 *
 * Authors who prefer type annotations (`const myObs: Observer = ...`)
 * get widened `name: string`, which collapses `AllObserverNames` to
 * `string` and silently disables typo detection. Use `as const satisfies`
 * to keep the inference.
 *
 * The same widening applies to plugin-shipped `exemptions`: a bare
 * `: Plugin` annotation widens `exemptions[].rule` to `string`, which
 * silently skips the plugin-exemption cross-check (see
 * {@link PluginExemptionsCheck}) — same footgun family, same fix.
 *
 * ## Behavior with no observers declared
 *
 * When no plugins contribute observers AND no inline `observers[]` is
 * passed, `AllObserverNames` resolves to `never`, which causes ANY
 * string `observer` reference on a Rule to be a compile error. This is
 * deliberate — fail-closed on unknown observer names. For configs that
 * deliberately reference observers by name without registering them
 * inline (e.g., deferred to runtime), use `satisfies SteeringConfig`
 * as a fallback; you lose typo detection but regain flexibility.
 *
 * ## Hover ergonomics for plugin-predicate JSDoc
 *
 * The `const R extends readonly Rule[]` signature narrows the
 * contextual type of inline rule literals to their `const`-inferred
 * shape, bypassing the homomorphic mapped-type linkage that surfaces
 * source-declared JSDoc on hover (e.g. on `when.isClean:`). Factor
 * rules out into `const myRule = { ... } as const satisfies Rule`
 * bindings before passing them to `defineConfig` to keep the
 * hover-rich shape; see the
 * `examples/dynamic-reason-runtime-cwd/steering.ts` example. The
 * `as const` modifier on the binding (and the `const R` modifier on
 * the signature) preserves each rule's literal `name` so
 * `disabledRules` typo detection fires — the alternatives `: Rule`
 * and bare `satisfies Rule` restore hover but widen the inferred
 * type and collapse typo detection (and `when.missing.event`
 * narrowing across declared `writes`).
 *
 * @example
 *   export default defineConfig({
 *     plugins: [gitPlugin],
 *     observers: [descriptionReadObserver],
 *     rules: [
 *       { name: "must-read-docs", ..., observer: "description-read" },
 *     ],
 *   });
 */
export function defineConfig<
  const P extends readonly Plugin[] = [],
  const Inline extends readonly Observer[] = [],
  const R extends readonly Rule<
    AllObserverNames<P, Inline>,
    AllWrites<P, R, Inline>,
    AllBasenames<P>
  >[] = [],
>(
  config: DefineConfigInput<P, Inline, R> & PluginExemptionsCheck<P, R>,
): SteeringConfig {
  // Runtime work is minimal: copy the supplied config, widening the
  // `readonly` tuple slots back to plain arrays for downstream
  // consumers (loader, evaluator) that don't care about the tuple
  // literal types. The generic machinery's job is done at the call
  // site — once we return, we return plain SteeringConfig.
  const out: SteeringConfig = {};
  if (config.defaultNoOverride !== undefined) {
    out.defaultNoOverride = config.defaultNoOverride;
  }
  if (config.disabledRules !== undefined) {
    out.disabledRules = [...config.disabledRules];
  }
  if (config.disabledPlugins !== undefined) {
    out.disabledPlugins = [...config.disabledPlugins];
  }
  if (config.failOnWarnings !== undefined) {
    out.failOnWarnings = config.failOnWarnings;
  }
  if (config.plugins !== undefined) {
    // Cast: `readonly Plugin[]` → `Plugin[]` (shape is identical;
    // the loader never mutates the array, but SteeringConfig
    // doesn't require readonly).
    out.plugins = [...config.plugins];
  }
  if (config.rules !== undefined) {
    out.rules = [...config.rules] as Rule[];
  }
  if (config.observers !== undefined) {
    out.observers = [...config.observers];
  }
  if (config.exemptions !== undefined) {
    // Shallow copy like the other array slots — the exemption `when`
    // clauses carry function-typed leaves (`condition:`) that must
    // survive the copy by reference; only the outer array is fresh.
    out.exemptions = [...config.exemptions];
  }
  return out;
}
