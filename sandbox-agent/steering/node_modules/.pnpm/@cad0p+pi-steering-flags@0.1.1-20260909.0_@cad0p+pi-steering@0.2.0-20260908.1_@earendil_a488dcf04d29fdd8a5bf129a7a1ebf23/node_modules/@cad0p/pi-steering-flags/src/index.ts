// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * pi-steering-flags \u2014 declarative flag-presence and flag-allowlist
 * predicates for pi-steering rules.
 *
 * First official external plugin for the pi-steering ecosystem.
 * Establishes the precedent pattern for every community plugin that
 * follows:
 *
 *   - Package name: `pi-steering-<domain>` (unscoped, mirroring
 *     `@cad0p/pi-steering` core).
 *   - Keywords: `["pi-package", "pi-steering-package", ...]` for
 *     ecosystem discoverability via pi.dev and `npm search`.
 *   - PeerDep on `@cad0p/pi-steering` (pinned range once published).
 *   - Four predicates exported as a `Plugin` for `when.<name>` use.
 *     The former `when.condition` escape-hatch helpers (`hasFlag`,
 *     `getFlagValue`, `hasEnvAssignment`, `isInfoOnly`, `INFO_FLAGS`,
 *     `FlagLookupOptions`) were promoted to the `@cad0p/pi-steering`
 *     root and then superseded by the bound `ctx.command` facade
 *     (core #101/#110, entry-only; requires core >=0.2.0-20260908.1)
 *     — predicates read flags through `ctx.command`, never root imports.
 *
 * See this package's README for usage examples, and the pi-steering
 * README "Writing plugins" section for the design rationale.
 *
 * `declare global` lives here (alongside the plugin definition) so
 * `import "pi-steering-flags"` pulls the registry augmentation in
 * transitively. This package has no separate `plugin.ts` (the index
 * IS the plugin definition); sibling `pi-steering-commit-format`
 * mirrors the same import-side-effect contract from its `plugin.ts`.
 */

import type { Plugin, PredicateShape } from "@cad0p/pi-steering";
import { allowlistedFlagsOnly } from "./predicates/allowlisted-flags-only.ts";
import { infoOnly } from "./predicates/info-only.ts";
import { requiresFlag } from "./predicates/requires-flag.ts";
import { requiresFlagValue } from "./predicates/requires-flag-value.ts";
import type {
  AllowlistedFlagsOnlyArgs,
  InfoOnlyArgs,
  RequiresFlagArgs,
  RequiresFlagValueArgs,
} from "./types.ts";

declare global {
  /**
   * pi-steering-flags' typed-predicate registry. Each entry declares
   * the predicate's `bare` value type and (optionally) an explicit
   * `spreadBase` (the spread's object form WITHOUT modifiers).
   * Modifiers (currently `onUnknown:`) are added at use site via
   * `& PredicateModifiers` (outer leaf) or at the not-block top level
   * (inside `not:`).
   *
   * All predicates read `ctx.input.args` / `ctx.input.envAssignments`
   * — they don't depend on the walker's effective cwd, so none of
   * the predicates carries a walker-unknown-cwd guard. The `onUnknown:`
   * modifier still applies if a handler explicitly returns the
   * `"unknown"` sentinel; current handlers return only `boolean`.
   *
   * @see PredicateShape, DefaultSpreadBase, PredicateModifiers in
   *      `@cad0p/pi-steering`'s `schema.ts` for the full registry contract.
   * @see The `gitPlugin` declaration in pi-steering's
   *      `plugins/git/index.ts` for the canonical multi-predicate
   *      registry block.
   */
  interface PiSteeringPredicates {
    /**
     * `when.requiresFlag` — fires (rule BLOCKS) when none of the
     * specified flag / env-var equivalents appear in the evaluated
     * command's `ctx.input.args` / `ctx.input.envAssignments`.
     *
     * Bare shorthand `requiresFlag: "--profile"` is equivalent to
     * `{ flag: "--profile" }`. Spread form supports any combination
     * of `flag` / `flags` / `env` / `envs` (OR semantics across all
     * listed equivalents — at least one must be present to satisfy).
     *
     * Mixed-bare predicate: explicit `SpreadBase` since auto-detection
     * from `string` would give `{ pattern: string }` (Pattern wrapper),
     * which doesn't match the desired flag-bag shape.
     */
    requiresFlag: PredicateShape<string, RequiresFlagArgs>;

    /**
     * `when.allowlistedFlagsOnly` — fires (rule BLOCKS) on the first
     * `-`-prefixed token in `ctx.input.args` that is NOT in the
     * `allow` set, NOT covered by an auto-derived `--flag=` prefix
     * of an allowed long flag, and NOT matched by an explicit
     * `allowPrefixes` entry.
     *
     * Spread-only predicate (no bare shorthand): the args object's
     * `allow:` field is required, so there's no sensible single-value
     * shorthand. The auto-detected `SpreadBase` (object form: the
     * `Bare` shape itself) is exactly what we want.
     */
    allowlistedFlagsOnly: PredicateShape<AllowlistedFlagsOnlyArgs>;

    /**
     * `when.infoOnly` — fires (rule BLOCKS) when the command IS an
     * info-only invocation (token-level, quote-aware). This is the
     * replacement for the removed `INFO_ONLY` regex: a help token
     * inside a quoted VALUE (`--subject "see --help"`) does NOT
     * count, so guardrails still apply to real operations that merely
     * mention help text.
     *
     * Bare shorthand `infoOnly: true` checks the default set
     * (`--help` / `--version` only — `-h` / `-v` are deliberately
     * excluded: they are real operations in commands like
     * `docker run -v /data:/data` or `curl -v`). `infoOnly: false`
     * never fires.
     *
     * Spread form is additive-only:
     * `when: { infoOnly: { extraFlags: ["-h"] } }` checks the default
     * set PLUS the extra flags — nothing can remove the safe core; a
     * plugin author adding `-h` for their own CLI owns that security
     * tradeoff.
     *
     * Carve-out idiom — combine with `when.not`:
     * `when: { not: { infoOnly: true } }` ALLOWS info-only
     * invocations while everything else still evaluates. The `when`
     * clause is an AND: a naive `when: { infoOnly: true }` would
     * BLOCK on help (the clause requires the command to BE
     * info-only), the opposite of a carve-out.
     */
    infoOnly: PredicateShape<boolean, InfoOnlyArgs>;

    /**
     * `when.requiresFlagValue` — fires (rule BLOCKS) when the LAST-wins
     * value of any listed flag alias is missing or doesn't match
     * `matches`. Absent flag counts as unmet (fail-closed).
     *
     * Spread-only (no bare shorthand: needs ≥2 fields), like
     * `allowlistedFlagsOnly`.
     */
    requiresFlagValue: PredicateShape<RequiresFlagValueArgs>;
  }
}

/**
 * The plugin. `as const satisfies Plugin` preserves literal types so
 * `defineConfig({ plugins: [flagsPlugin] })` can cross-reference the
 * predicate names at compile time.
 *
 * Exported both as a named const (`flagsPlugin`) and as the default
 * export, mirroring `pi-steering-commit-format`'s `commitFormatPlugin`
 * shape so authors can pick the import style they prefer.
 */
export const flagsPlugin = {
  name: "flags",
  predicates: {
    requiresFlag,
    allowlistedFlagsOnly,
    infoOnly,
    requiresFlagValue,
  },
} as const satisfies Plugin;

export default flagsPlugin;

export { allowlistedFlagsOnly } from "./predicates/allowlisted-flags-only.ts";
// Named re-exports \u2014 pick-your-piece imports for authors who want
// just one predicate.
export { infoOnly } from "./predicates/info-only.ts";
export { requiresFlag } from "./predicates/requires-flag.ts";
export { requiresFlagValue } from "./predicates/requires-flag-value.ts";
export type {
  AllowlistedFlagsOnlyArgs,
  InfoOnlyArgs,
  RequiresFlagArgs,
  RequiresFlagValueArgs,
} from "./types.ts";
