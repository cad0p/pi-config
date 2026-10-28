// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Single source of truth for the walker's effective tracker registry.
 *
 * The rule surface ({@link buildEvaluator} → `prepareBashState`) and the
 * observer watch surface ({@link extractRefTextsForBash} → the
 * observer-dispatcher's dispatch path) must resolve the SAME bash
 * command to the SAME strings — issue #51/#52 pinned that contract, and
 * issue #54 closed the last divergence: the watch side used to re-walk
 * with the built-in `envTracker` only, so a plugin registering
 * `trackers: { env }` or `trackerExtensions.env` (both legal — `env` is
 * not a reserved tracker name) changed what RULES saw without changing
 * what OBSERVERS matched.
 *
 * Both consumers call {@link buildWalkRegistry} on the `resolved`
 * plugin state they already receive and derive their own registry:
 *
 *   - {@link buildEvaluator} (rule surface),
 *   - {@link buildObserverDispatcher} (watch surface) — seeding the
 *     watch walk with the same registry + the per-event `ctx.cwd`.
 *
 * Walkers are pure over the registry (each `walk` seeds per-walk state
 * from `tracker.initial` and never mutates the trackers), so two
 * registries built from the same `resolved` cannot diverge — the
 * module is the single source of truth, not object identity.
 *
 * ## Fallback contract
 *
 * The registry MUST always contain `env` and `cwd` so the built-in
 * `when.cwd` predicate + cd's env-aware resolution work even when no
 * plugin ships them — this is the correctness core of the module: a
 * consumer that spread `resolved.composedTrackers` directly would walk
 * with NO env tracker when none is registered and resolve every
 * `$VAR` raw (worse than the pre-issue-54 builtin-only watch side).
 * When no plugin registers a tracker by name, the built-in
 * `cwdTracker` / `envTracker` are used AND any
 * `resolved.trackerModifiers["cwd"]` / `["env"]` extensions are layered
 * on top (the plugin merger preserves extensions targeting these names
 * via `knownBuiltinTrackers`).
 *
 * Env goes in first so cd's modifier sees the current ref's env via
 * the `allState` read; walker iteration is registration-order stable
 * (Object.keys on an object literal) — the ordering is a soft
 * guarantee good for the built-in composition, not a hard API contract.
 *
 * ## Caller obligations
 *
 * Callers MUST NOT mutate the returned trackers (or the trackers they
 * contain). Walk is read-only over the registry; mutation would leak
 * across the two surfaces and re-introduce divergence. Containers are
 * freshly spread per call, but the individual trackers (and their
 * `modifiers` maps) are shared references with `resolved.composedTrackers`
 * — treat the whole result as read-only.
 *
 * ## Fail-open note
 *
 * The watch surface keeps its `null`-fallback: a command that fails to
 * parse falls back to RAW-only matching (see
 * {@link extractRefTextsForBash}). In the `not: { missing }` latch
 * idiom that fallback is fail-open (a parse crash silently never
 * records → the latch guard goes inert); empirically unreachable today
 * (the parser survived env-refs, arithmetic, `[[ ]]`,
 * process-substitution, case, nested quotes in the issue-54 probe),
 * but callers should know the raw-only tail exists.
 */

import {
  cwdTracker,
  type EnvState,
  envTracker,
  type Modifier,
  type Tracker,
} from "@cad0p/unbash-walker";
import type { ResolvedPluginState } from "../plugin-merger.ts";

/**
 * Build the effective walker registry for a resolved plugin state:
 * plugin-declared/composed trackers first, with built-in `env` + `cwd`
 * fallbacks (modifier-extended via `trackerModifiers`) when no plugin
 * registers them. See the file-level JSDoc for the fallback contract
 * and the "callers MUST NOT mutate" obligation.
 */
export function buildWalkRegistry(
  resolved: ResolvedPluginState,
): Record<string, Tracker<unknown>> {
  // Env goes in first so cd's modifier sees the current ref's env via
  // the `allState` read (same ordering guarantee as the pre-extraction
  // inline build in the evaluator).
  const trackers: Record<string, Tracker<unknown>> = {
    ...resolved.composedTrackers,
  };
  if (!("env" in trackers)) {
    const extraEnvModifiers = resolved.trackerModifiers["env"];
    trackers["env"] = composeBuiltinEnv(extraEnvModifiers) as Tracker<unknown>;
  }
  if (!("cwd" in trackers)) {
    const extraCwdModifiers = resolved.trackerModifiers["cwd"];
    trackers["cwd"] = composeBuiltinCwd(extraCwdModifiers) as Tracker<unknown>;
  }
  return trackers;
}

/**
 * The watch surface's STANDALONE default registry: the built-in env
 * tracker only. Used by the `matchesWatch` default ref-texts provider
 * and by test call sites that exercise the watch matcher in isolation
 * (no plugin state present).
 *
 * Frozen so a test (or future caller) mutating the map fails loudly
 * instead of silently diverging from every other walk-registry
 * consumer.
 *
 * Deliberately no `cwd` tracker: standalone callers have no session
 * cwd, and `WATCH_DEFAULT_WALK` contains no cwd-dependent modifiers,
 * so the cwd dimension is inert there. Production dispatch NEVER uses
 * this constant — it threads `buildWalkRegistry(resolved)` + per-event
 * `ctx.cwd` instead.
 */
export const WATCH_DEFAULT_WALK: Record<
  string,
  Tracker<unknown>
> = Object.freeze({ env: envTracker });

/**
 * Layer a bucket of plugin-provided `{ basename -> Modifier[] }`
 * extensions on top of the built-in {@link cwdTracker}, returning a
 * fresh tracker so the built-in's `modifiers` map is never mutated.
 *
 * Used when no plugin registers a `cwd` tracker but plugins still
 * want to add basename modifiers to the built-in one (e.g. the git
 * plugin's `--git-dir=` handler). Mirrors the plugin-merger's
 * `composeTracker` shape — kept local here because the merger's
 * helper is private to that module and exposing it would force the
 * merger to know about the built-in cwd tracker. Keeping the merger
 * built-in-agnostic is worth the small duplication.
 */
function composeBuiltinCwd(
  extras: Record<string, Modifier<unknown>[]> | undefined,
): Tracker<string> {
  return composeBuiltin(cwdTracker, extras);
}

/**
 * Layer a bucket of plugin-provided `{ basename -> Modifier[] }`
 * extensions on top of the built-in {@link envTracker}, returning a
 * fresh tracker so the built-in's `modifiers` map is never mutated.
 *
 * Parallels {@link composeBuiltinCwd}. Env extensions are the
 * `.envrc`-style surface — a plugin ships an env-loader modifier on
 * the shared tracker rather than replacing it — and the composition
 * is symmetric with cwd.
 */
function composeBuiltinEnv(
  extras: Record<string, Modifier<unknown>[]> | undefined,
): Tracker<EnvState> {
  return composeBuiltin(envTracker, extras);
}

/**
 * Generic tracker-extension compositor. Given a base tracker and a
 * bucket of plugin-provided `{ basename -> Modifier[] }` extensions,
 * returns a fresh tracker whose `modifiers` map fuses the two
 * without mutating the base.
 *
 * Resolution rule per basename:
 *   - Base has none, extras has 1+: extras become the entry
 *     (unwrapped to a single Modifier when length is 1).
 *   - Base has one or many, extras has 1+: concatenated into an
 *     array ordered base-first, extras-after, so per-command
 *     overrides layer in the expected sequence.
 *
 * Used by {@link composeBuiltinCwd} and {@link composeBuiltinEnv}
 * to fold `trackerExtensions.cwd` / `trackerExtensions.env` from
 * plugin registrations onto the built-ins. Keeping this helper
 * internal (not exported) lets the plugin-merger stay agnostic of
 * which built-in trackers exist.
 */
function composeBuiltin<T>(
  baseTracker: Tracker<T>,
  extras: Record<string, Modifier<unknown>[]> | undefined,
): Tracker<T> {
  if (!extras || Object.keys(extras).length === 0) return baseTracker;
  const merged: Record<string, Modifier<T> | Modifier<T>[]> = {};
  for (const [basename, mod] of Object.entries(baseTracker.modifiers)) {
    merged[basename] = Array.isArray(mod) ? [...(mod as Modifier<T>[])] : mod;
  }
  for (const [basename, mods] of Object.entries(extras)) {
    const existing = merged[basename];
    const extrasTyped = mods as unknown as Modifier<T>[];
    if (existing === undefined) {
      merged[basename] =
        extrasTyped.length === 1 ? extrasTyped[0]! : [...extrasTyped];
      continue;
    }
    const existingList = Array.isArray(existing)
      ? (existing as Modifier<T>[])
      : [existing as Modifier<T>];
    merged[basename] = [...existingList, ...extrasTyped];
  }
  return { ...baseTracker, modifiers: merged };
}
