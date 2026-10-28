// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module — not part of the package's public API.
 *
 * This module holds the wiring that the bridge factory in `index.ts`
 * uses to spin up an evaluator + observer dispatcher from the
 * two-layer config (project layer at `cwd`, global layer at the
 * agent dir). It is intentionally NOT re-exported from
 * `index.ts` or any other public entry point; consumers building
 * their own extensions should go through `loadHarness` (subpath
 * `@cad0p/pi-steering/testing`) or call `buildEvaluator` /
 * `buildObserverDispatcher` directly.
 *
 * The runtime owns the strict-mode contract: diagnostics produced
 * by the loader (per-layer import failures, dual-form coexistence,
 * stray files, cross-layer + within-layer collisions) and by the
 * plugin merger (predicate / observer / rule / extension-orphan /
 * reserved-name / invalid-name diagnostics) are aggregated here.
 * Any error-class diagnostic always escalates to a thrown error;
 * warning-class diagnostics escalate when `failOnWarnings !== false`
 * on the merged config (default: true). Otherwise warnings are
 * emitted to `console.warn` for legacy fail-soft semantics.
 *
 * The bridge defers the build to the first `session_start` on each
 * extension instance, anchored on the session's `ctx.cwd`. A
 * strict-mode aggregate throw (the "<n> config issue(s):" header) is
 * caught by the bridge and surfaced as a `console.error` line plus an
 * in-chat `ui.notify` carrying the FULL aggregated body; the session
 * runs unsteered (fail-closed). Any other error is rethrown and stays
 * loud via pi's `Extension "..." error:` rendering.
 */

import {
  buildEvaluator,
  EVALUATOR_BUILTIN_TRACKERS,
  type EvaluatorHost,
  type EvaluatorRuntime,
} from "../evaluator.ts";
import {
  buildConfig,
  type LoadConfigsOptions,
  loadConfigs,
} from "../loader.ts";
import {
  buildObserverDispatcher,
  type ObserverDispatcher,
} from "../observer-dispatcher.ts";
import {
  type ResolvedPluginState,
  resolvePlugins,
  validateUserConfigNames,
} from "../plugin-merger.ts";
import type {
  Exemption,
  SteeringConfig,
  SteeringDiagnostic,
} from "../schema.ts";
import { finalizePluginState } from "./finalize-plugin-state.ts";

/**
 * Detect exemptions whose target rule name doesn't exist in the final
 * merged rule universe and emit an `exemption-orphan` diagnostic for
 * each — the carve-out can never match anything.
 *
 * Two-tier severity contract (the ONLY severity split in orphan
 * detection):
 *
 *   - Plugin-shipped exemptions (`merged.plugins[].exemptions`, source
 *     `plugin "Y"`) are ERROR-class. A plugin explicitly shipping a
 *     carve-out that targets a rule missing from the merged universe
 *     is a broken plugin/config contract (e.g. the napkin plugin
 *     documents "gitPlugin MUST be listed alongside") — it must fail
 *     every surface: the runtime always throws (regardless of
 *     `failOnWarnings`), the CLI exits 1, `loadHarness` short-circuits
 *     to a no-op harness.
 *   - Config-written exemptions (`merged.exemptions`, source
 *     `config`) stay WARNING-class. User typos are already caught at
 *     compile time by `AllRuleNames` inside `defineConfig`; `satisfies`
 *     / JSON / JS authors keep the documented fail-soft path (strict
 *     mode throws, else `console.warn`).
 *
 * Universe formula (single source of truth for runtime, CLI, and
 * `loadHarness` — all three funnel through `runMergerPipeline`):
 *
 *   `merged.rules` ∪ rule names across `merged.plugins`
 *
 * `merged.plugins` intentionally includes DISABLED plugins (loader's
 * `mergePlugins` keeps them; `resolvePlugins` filters them from
 * `resolved.rules`) — a rule shipped only by a disabled plugin exists
 * in the universe, so an exemption targeting it is inert, silent, and
 * NOT orphaned (by-design disable, consistent with the disabled-rule
 * `console.info` breadcrumb). `resolved.rules` is redundant under
 * this formula. There are no engine-injected default rules (issue
 * #72): the universe is exactly what the config declares.
 */
function detectExemptionOrphans(merged: SteeringConfig): SteeringDiagnostic[] {
  const universe = new Set<string>();
  for (const rule of merged.rules ?? []) universe.add(rule.name);
  for (const plugin of merged.plugins ?? []) {
    for (const rule of plugin.rules ?? []) universe.add(rule.name);
  }

  const diagnostics: SteeringDiagnostic[] = [];
  const check = (
    exemption: Exemption,
    source: string,
    type: "error" | "warning",
  ): void => {
    if (universe.has(exemption.rule)) return;
    diagnostics.push({
      type,
      kind: "exemption-orphan",
      message:
        `exemption for rule "${exemption.rule}" (${source}) targets a rule ` +
        "that doesn't exist in the merged config; exemption ignored. " +
        "Check the rule name for typos, or install the plugin that ships it.",
    });
  };
  // Plugin bucket → error-class (broken plugin/config contract);
  // config bucket → warning-class (fail-soft, see JSDoc above).
  for (const plugin of merged.plugins ?? []) {
    for (const exemption of plugin.exemptions ?? []) {
      check(exemption, `plugin "${plugin.name}"`, "error");
    }
  }
  for (const exemption of merged.exemptions ?? []) {
    check(exemption, "config", "warning");
  }
  return diagnostics;
}

/**
 * Run `buildConfig` then `resolvePlugins` over the raw layer list,
 * short-circuiting before `resolvePlugins` if any merge-side
 * diagnostic is error-class. Avoids double-emitting
 * `tracker-name-collision` (O2 in INVARIANTS.md).
 * `validateUserConfigNames` runs unconditionally so user-config name
 * issues surface alongside merge errors; `detectExemptionOrphans`
 * runs on the merged config so runtime / CLI / loadHarness see the
 * same rule universe (defaults divergence handled explicitly). Its
 * severity split — plugin-shipped orphans error-class, config-written
 * orphans warning-class — applies identically on every surface.
 */
export function runMergerPipeline(
  layers: readonly SteeringConfig[],
  builtinTrackers: readonly string[],
): {
  merged: SteeringConfig;
  resolved: ResolvedPluginState | null;
  diagnostics: SteeringDiagnostic[];
} {
  const { config: merged, diagnostics: mergeDiagnostics } = buildConfig(layers);
  const userConfigNameDiagnostics = validateUserConfigNames(layers);
  const exemptionOrphanDiagnostics = detectExemptionOrphans(merged);
  if (mergeDiagnostics.some((d) => d.type === "error")) {
    return {
      merged,
      resolved: null,
      diagnostics: [
        ...mergeDiagnostics,
        ...userConfigNameDiagnostics,
        ...exemptionOrphanDiagnostics,
      ],
    };
  }
  const resolved = resolvePlugins(
    merged.plugins ?? [],
    merged,
    builtinTrackers,
  );
  return {
    merged,
    resolved,
    diagnostics: [
      ...mergeDiagnostics,
      ...userConfigNameDiagnostics,
      ...exemptionOrphanDiagnostics,
      ...resolved.diagnostics,
    ],
  };
}

/**
 * Render a diagnostics array into a single multi-line message
 * suitable for use as a thrown Error's `message`. See {@link
 * SteeringDiagnostic} render-format matrix for the canonical shape;
 * the `formatAggregatedDiagnostics: rule-based spec` describe block in
 * `internal/session-runtime.test.ts` pins the rules.
 */
export function formatAggregatedDiagnostics(
  diagnostics: readonly SteeringDiagnostic[],
): string {
  const errors = diagnostics.filter((d) => d.type === "error");
  const warnings = diagnostics.filter((d) => d.type === "warning");
  const ordered = [...errors, ...warnings];
  const count = ordered.length;
  const noun = count === 1 ? "issue" : "issues";
  const lines = ordered.map((d) => {
    const pathPrefix = d.path !== undefined ? `${d.path}: ` : "";
    return `  - [${d.type}] ${pathPrefix}${d.message}`;
  });
  return `${count} config ${noun}:\n${lines.join("\n")}`;
}

/**
 * Single-line render of one diagnostic; see {@link SteeringDiagnostic}
 * render-format matrix for the canonical contract.
 */
export function formatSingleLineDiagnostic(d: SteeringDiagnostic): string {
  const pathPrefix = d.path !== undefined ? `${d.path}: ` : "";
  return `[pi-steering] [${d.type}] ${pathPrefix}${d.message}`;
}

/**
 * Build the per-session evaluator + observer dispatcher from the walk-
 * up config rooted at `cwd`. Throws on any error-class diagnostic and
 * on warning-class diagnostics when `failOnWarnings !== false`;
 * otherwise emits surviving warnings via `console.warn`. See {@link
 * runMergerPipeline} for the merge contract and `finalizePluginState`
 * for observer-drop.
 *
 * `opts` is forwarded to {@link loadConfigs} — `projectLayerTrusted:
 * false` gates the project layer behind pi's resolved project-trust
 * decision (see {@link LoadConfigsOptions}). Info-class diagnostics
 * (e.g. the `layer-project-untrusted` skip breadcrumb) are emitted
 * via `console.info` BEFORE the throw/warn policy runs and are
 * excluded from the aggregate throw body by construction
 * (`formatAggregatedDiagnostics` filters error/warning only) — an
 * untrusted project keeps global-layer steering in every strict-mode
 * setting.
 */
export async function buildSessionRuntime(
  cwd: string,
  host: EvaluatorHost,
  opts?: LoadConfigsOptions,
): Promise<{
  evaluator: EvaluatorRuntime;
  dispatcher: ObserverDispatcher;
}> {
  const aggregated: SteeringDiagnostic[] = [];

  const { layers: rawLayers, diagnostics: loaderDiagnostics } =
    await loadConfigs(cwd, opts);
  aggregated.push(...loaderDiagnostics);

  // Info-class breadcrumbs (e.g. `layer-project-untrusted` under the
  // trust gate) surface on `console.info` here, BEFORE the throw/warn
  // policy below — they describe normal behavior, never escalate, and
  // must be visible even when the session build later throws on
  // warning/error diagnostics. Mirrors the disabled-rules / dropped-
  // observer `console.info` breadcrumb pattern.
  for (const d of aggregated) {
    if (d.type === "info") console.info(formatSingleLineDiagnostic(d));
  }

  const {
    merged,
    resolved,
    diagnostics: mergeAndResolveDiagnostics,
  } = runMergerPipeline(rawLayers, EVALUATOR_BUILTIN_TRACKERS);
  aggregated.push(...mergeAndResolveDiagnostics);

  const failOnWarnings = merged.failOnWarnings;
  const treatWarningsAsErrors = failOnWarnings !== false;

  const hasError = aggregated.some((d) => d.type === "error");
  const hasWarning = aggregated.some((d) => d.type === "warning");
  if (hasError || (treatWarningsAsErrors && hasWarning)) {
    throw new Error(formatAggregatedDiagnostics(aggregated));
  }
  if (hasWarning) {
    // Fail-soft single-line route — filtered to warning-class only
    // (F1): info-class diagnostics were already breadcrumbed via
    // `console.info` above and must never re-emit through the
    // `console.warn` loop. Behavior-preserving today (no info
    // producers existed before the trust gate); pins the single-route
    // contract.
    for (const d of aggregated) {
      if (d.type === "warning") console.warn(formatSingleLineDiagnostic(d));
    }
  }

  if (resolved === null) {
    throw new Error("internal: resolved null without error diagnostic");
  }

  const disabled = new Set(merged.disabledRules ?? []);
  const filteredConfig: SteeringConfig = { ...merged };
  if (merged.rules !== undefined) {
    const kept = merged.rules.filter((r) => !disabled.has(r.name));
    if (kept.length > 0) filteredConfig.rules = kept;
    else delete filteredConfig.rules;
  }

  const { pluginKept, userKept } = finalizePluginState(
    filteredConfig.rules ?? [],
    resolved.rules,
    filteredConfig.observers ?? [],
    resolved.observers,
    filteredConfig.exemptions ?? [],
    resolved.exemptions ?? [],
  );
  const filteredResolved = {
    ...resolved,
    observers: [...pluginKept],
  };

  const evaluator = buildEvaluator(filteredConfig, filteredResolved, host);
  const dispatcher = buildObserverDispatcher(filteredResolved, userKept, host);
  return { evaluator, dispatcher };
}
