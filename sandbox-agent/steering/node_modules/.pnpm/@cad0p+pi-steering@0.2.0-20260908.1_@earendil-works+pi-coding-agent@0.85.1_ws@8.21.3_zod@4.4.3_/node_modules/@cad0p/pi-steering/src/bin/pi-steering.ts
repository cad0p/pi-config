#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `@cad0p/pi-steering` CLI. Two subcommands:
 *
 *   pi-steering import-json <input.json> [-o <output.ts>]
 *     Convert a v1 JSON config to the v2 TS config shape.
 *
 *   pi-steering list [--format=text|json]
 *     Resolve the two-layer config (project `<cwd>/.pi/steering/` +
 *     global `<agentDir>/steering/`) from the CWD and print the
 *     effective plugins / rules / observers / disables. The project
 *     layer is gated on pi's project-trust formula (mirrored here,
 *     non-UI: trust.json / no trust-requiring resources → trusted);
 *     the global layer always loads. The mirror is cross-checked
 *     against pi's real trust machinery by a live-oracle fidelity
 *     test + a weekly upstream drift workflow that files `[drift]`
 *     issues on any mismatch (see the mirror section below).
 *
 * Exit codes:
 *   0 - success
 *   1 - invalid arguments / file read / parse error / `list`
 *       surfaced one or more error-class diagnostics (CI-lint signal)
 *   2 - import-json conversion error ({@link FromJSONError})
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FromJSONError, fromJSON } from "../compat.ts";
import { EVALUATOR_BUILTIN_TRACKERS } from "../evaluator.ts";
import { finalizePluginState } from "../internal/finalize-plugin-state.ts";
import {
  formatSingleLineDiagnostic,
  runMergerPipeline,
} from "../internal/session-runtime.ts";
import { loadConfigs, resolveAgentDir } from "../loader.ts";
import type {
  Exemption,
  Observer,
  Rule,
  SteeringConfig,
  SteeringDiagnostic,
  TopLevelWhenClause,
} from "../schema.ts";

// `import.meta.main` (Node >=22.18, inside the 22.19.0 engines floor)
// is typed by @types/node from 22.18.0 on — at or below our `^22.19.0`
// types floor, so no augmentation needed here.

/**
 * CLI entrypoint. Exported (not just `void main(...)` at module top)
 * so the test suite can exercise the argument parser without spawning
 * a subprocess. Real invocation goes through the bottom-of-file
 * bootstrap when this module is run as `node pi-steering.js`.
 */
export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return 0;
  }

  const [subcommand, ...rest] = args;
  if (subcommand === "import-json") {
    return runImportJson(rest);
  }
  if (subcommand === "list") {
    return runList(rest);
  }

  process.stderr.write(`pi-steering: unknown subcommand "${subcommand}"\n\n`);
  printHelp();
  return 1;
}

function printHelp(): void {
  process.stdout.write(`pi-steering — tools for pi-steering

USAGE
  pi-steering <subcommand> [options]

SUBCOMMANDS
  import-json <input.json> [-o <output.ts>]
      Convert a v1 JSON steering config to v2 TS form. Writes to
      <output.ts> if specified, else stdout. See the README for
      the JSON-to-TS conversion surface and rejected features.

  list [--format=text|json]
      Load the effective config for the current directory (project
      layer at <cwd>/.pi/steering/ + global layer at
      <agentDir>/steering/) and print the resolved plugins, rules,
      and observers, grouped by source. Useful for answering "which
      rules are active here?" without reading the config files by
      hand. The project layer loads only when the current directory
      is trusted per pi's project-trust formula (trust.json entries
      under <agentDir>/trust.json, or no trust-requiring resources
      present); the global layer always loads.

OPTIONS
  -h, --help    Show this help.

`);
}

async function runImportJson(args: string[]): Promise<number> {
  let inputPath: string | null = null;
  let outputPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--output") {
      const next = args[++i];
      if (next === undefined) {
        process.stderr.write("pi-steering: -o requires an argument\n");
        return 1;
      }
      outputPath = next;
    } else if (a !== undefined && a.startsWith("-")) {
      process.stderr.write(`pi-steering: unknown flag "${a}"\n`);
      return 1;
    } else if (inputPath === null && a !== undefined) {
      inputPath = a;
    } else {
      process.stderr.write("pi-steering: too many positional arguments\n");
      return 1;
    }
  }

  if (inputPath === null) {
    process.stderr.write("pi-steering: import-json requires an input file\n");
    return 1;
  }

  let raw: string;
  try {
    raw = await readFile(inputPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `pi-steering: cannot read ${inputPath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `pi-steering: ${inputPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  let config: SteeringConfig;
  try {
    config = fromJSON(json);
  } catch (err) {
    if (err instanceof FromJSONError) {
      process.stderr.write(
        `pi-steering: conversion failed at ${err.path}: ${err.message}\n`,
      );
      return 2;
    }
    throw err;
  }

  const output = renderConfig(config);

  if (outputPath !== null) {
    await writeFile(outputPath, output, "utf8");
    process.stdout.write(`Wrote ${outputPath}\n`);
  } else {
    process.stdout.write(output);
  }
  return 0;
}

/**
 * Render a {@link SteeringConfig} as a v2 TS file using `defineConfig`.
 * Uses `JSON.stringify` for the config value since v1 rules only carry
 * string / number / boolean / array — JSON literal rendering is
 * semantically identical to the TS object literal.
 */
function renderConfig(config: SteeringConfig): string {
  const body = JSON.stringify(config, null, 2);
  return `// Generated by \`pi-steering import-json\`.
// Edit freely — this is your steering config now.

import { defineConfig } from "@cad0p/pi-steering";

export default defineConfig(${body});
`;
}

// ---------------------------------------------------------------------------
// `list` subcommand
// ---------------------------------------------------------------------------

/**
 * Parse the `list` flag set and print the resolved config.
 *
 * Flags:
 *   --format=text   (default)
 *   --format=json   machine-readable JSON
 *   -h / --help     per-subcommand help
 */
async function runList(args: string[]): Promise<number> {
  let format: "text" | "json" = "text";
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      printListHelp();
      return 0;
    }
    if (a === "--format=text") {
      format = "text";
    } else if (a === "--format=json") {
      format = "json";
    } else if (a.startsWith("--format=")) {
      process.stderr.write(
        `pi-steering: unknown --format value "${a.slice("--format=".length)}"; use text|json\n`,
      );
      return 1;
    } else {
      process.stderr.write(`pi-steering: unknown flag "${a}"\n`);
      return 1;
    }
  }

  // Load project layer (cwd) + global layer (agent dir) and merge.
  // The CLI loads exactly what the configs declare — there are no
  // engine-injected default plugins or rules (issue #72), so `list`
  // output is fully truthful (every rule has a declared provenance).
  // The project layer is gated on pi's project-trust
  // formula (mirrored in `resolveCliProjectTrust` below); info-class
  // diagnostics (the trust skip) flow through `recordDiagnostic` to
  // stderr like every other severity.
  let layers: readonly SteeringConfig[];
  let loaderDiagnostics: readonly SteeringDiagnostic[] = [];
  let projectLayerTrusted = true;
  try {
    projectLayerTrusted = resolveCliProjectTrust(process.cwd());
    ({ layers, diagnostics: loaderDiagnostics } = await loadConfigs(
      process.cwd(),
      { projectLayerTrusted },
    ));
  } catch (err) {
    process.stderr.write(
      `pi-steering: failed to load config: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  // Surface loader-side diagnostics on stderr in the legacy shape so
  // users running `pi-steering list` against a tree with broken layers,
  // dual-form coexistence, stray files, or cross-layer collisions see
  // them — restores the pre-refactor visibility the loader's direct
  // `console.warn` calls used to provide. Track whether any error-
  // class diagnostic was emitted so the CLI can exit non-zero, giving
  // CI lint pipelines a binary signal that the config would refuse to
  // start in production.
  //
  // CLI deliberately renders errors inline rather than via the
  // aggregated thrown-Error form: the audience is a CI grep target,
  // not a human reading a single Error.message.
  let sawError = false;
  const recordDiagnostic = (d: SteeringDiagnostic) => {
    if (d.type === "error") sawError = true;
    process.stderr.write(`${formatSingleLineDiagnostic(d)}\n`);
  };
  for (const d of loaderDiagnostics) {
    recordDiagnostic(d);
  }

  if (layers.length === 0) {
    if (format === "json") {
      process.stdout.write(
        `${JSON.stringify(emptyListJSON(projectLayerTrusted), null, 2)}\n`,
      );
    } else {
      process.stdout.write("No steering config found.\n");
    }
    return sawError ? 1 : 0;
  }

  const { config, diagnostics: mergeAndResolveDiagnostics } =
    runCliMergeWithInfoCapture(layers);
  for (const d of mergeAndResolveDiagnostics) {
    recordDiagnostic(d);
  }

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(renderListJSON(config, projectLayerTrusted), null, 2)}\n`,
    );
  } else {
    process.stdout.write(renderListText(config));
  }
  return sawError ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Project-trust resolution (CLI mirror of pi's non-UI formula)
// ---------------------------------------------------------------------------

/**
 * Resources that force a project-trust decision when present under
 * `<dir>/.pi/`. Mirrors pi's `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`
 * (trust-manager.js) — the CLI reimplements pi's non-UI trust formula
 * because pi's `exports` map blocks deep imports of its internals.
 * The mirror is cross-checked against pi's REAL trust machinery by
 * the live-oracle fidelity test (`src/bin/mirror-fidelity.test.ts`,
 * always-on in CI) and by the weekly upstream drift workflow
 * (`.github/workflows/drift-check.yml` — bumps pi, runs the full
 * suite, files a `[drift]` issue on any mismatch).
 * Scope note: fixed to pi's default `.pi` config dir — pi's
 * configurable `pkg.piConfig.configDir` is out of scope (the loader
 * itself is `.pi`-fixed, so the mirror and the loader stay in sync).
 */
const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
];

/**
 * Canonicalize a path like pi's `canonicalizePath` (paths.js):
 * `realpathSync`, falling back to the raw path when the target
 * doesn't exist (deleted cwd safe). Trust keys are canonicalized so
 * symlinked directories resolve to the same entry pi would consult.
 */
function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * CLI mirror of pi's `hasTrustRequiringProjectResources`
 * (trust-manager.js): true when `<dir>/.pi/` holds any trust-requiring
 * resource at the canonicalized cwd, or when any ancestor (cwd
 * included) has an `.agents/skills` dir other than the user's own
 * canonicalized `$HOME/.agents/skills`. Ancestor walk stops at root.
 *
 * Canonicalizes the cwd INTERNALLY (line-for-line pi's
 * `canonicalizePath(resolvePath(cwd))`, trust-manager.js) so the
 * standalone export behaves identically to pi on raw paths — the
 * fidelity test feeds RAW paths to both sides, and the symlinked-cwd
 * row exercises this parity.
 */
export function hasTrustRequiringProjectResourcesMirror(cwd: string): boolean {
  const homeDir = canonicalizePath(resolve(process.env.HOME || homedir()));
  const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
  let currentDir = canonicalizePath(resolve(cwd));
  if (
    TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) =>
      existsSync(join(currentDir, ".pi", entry)),
    )
  ) {
    return true;
  }
  while (true) {
    const agentsSkillsDir = join(currentDir, ".agents", "skills");
    if (
      agentsSkillsDir !== userAgentsSkillsDir &&
      existsSync(agentsSkillsDir)
    ) {
      return true;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return false;
    currentDir = parentDir;
  }
}

/**
 * Read `<agentDir>/trust.json` and resolve the nearest entry for
 * `cwd` — ancestor walk, first true/false wins, null skipped,
 * root-stop. Mirrors pi's `ProjectTrustStore.get` (trust-manager.js).
 *
 * Divergence (deliberate, O3): pi's `readTrustFile` THROWS on a
 * malformed store (pi would crash at startup); the CLI is a read-only
 * inspector and must not crash — it treats the store as EMPTY and
 * writes a `pi-steering: trust store <path> …; ignoring` note to
 * stderr ("unreadable" for read/parse failures, "malformed" for
 * structurally invalid contents). The formula then proceeds on the
 * empty store: with trust-requiring resources present the decision is
 * UNTRUSTED and the project layer is skipped (mirror-faithful, no
 * fail-open fallback). The malformed-store DIVERGENCE from pi (which
 * throws) is asserted deliberately in the fidelity test.
 */
export function trustStoreGetMirror(cwd: string): boolean | null {
  const agentDir = resolveAgentDir();
  const trustPath = join(agentDir, "trust.json");
  let parsed: unknown;
  try {
    const raw = readFileSync(trustPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    // Missing store = empty store (pi's readTrustFile returns {} for
    // a nonexistent file). Unreadable / malformed JSON: same empty
    // store, but noted on stderr so the skip that follows is
    // explainable.
    if (existsSync(trustPath)) {
      process.stderr.write(
        `pi-steering: trust store ${trustPath} unreadable; ignoring\n`,
      );
    }
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(
      `pi-steering: trust store ${trustPath} malformed; ignoring\n`,
    );
    return null;
  }
  const store = parsed as Record<string, unknown>;
  for (const value of Object.values(store)) {
    if (value !== true && value !== false && value !== null) {
      process.stderr.write(
        `pi-steering: trust store ${trustPath} malformed; ignoring\n`,
      );
      return null;
    }
  }
  // Ancestor walk: first true/false wins, null skipped, root-stop.
  let currentDir = canonicalizePath(resolve(cwd));
  while (true) {
    const value = store[currentDir];
    if (value === true || value === false) return value;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * CLI mirror of pi's non-UI project-trust formula (main.js):
 * `trusted = !hasTrustRequiringProjectResources(cwd) ||
 * trustStore.get(cwd) === true`. No override, no prompt — the CLI is
 * a read-only inspector and adopts the resolved store decision.
 * Cross-checked against pi's real formula by the fidelity test.
 */
export function resolveCliProjectTrust(cwd: string): boolean {
  // Pre-canonicalization is now redundant (the mirror canonicalizes
  // internally, like pi) — kept so CLI behavior stays byte-identical.
  const resolvedCwd = canonicalizePath(resolve(cwd));
  if (!hasTrustRequiringProjectResourcesMirror(resolvedCwd)) return true;
  return trustStoreGetMirror(resolvedCwd) === true;
}

/**
 * CLI variant of the merge pipeline. Redirects `console.info`
 * breadcrumbs (disabled-plugin / disabled-rule / dropped-observer)
 * onto stderr so stdout stays clean for `--format=json`. Loads the
 * project + global layers and merges them inner-first (project wins),
 * then mirrors {@link buildSessionRuntime}'s `disabledRules` filter +
 * `finalizePluginState` so `pi-steering list` reports the same
 * observer-drop set production sees.
 */
function runCliMergeWithInfoCapture(layers: readonly SteeringConfig[]): {
  config: SteeringConfig;
  diagnostics: SteeringDiagnostic[];
} {
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => String(a)).join(" ")}\n`);
  };
  try {
    const { merged, resolved, diagnostics } = runMergerPipeline(
      layers,
      EVALUATOR_BUILTIN_TRACKERS,
    );
    // Skipped on merge short-circuit; without resolved we can't
    // enumerate plugin-side observers.
    if (resolved !== null) {
      const userObservers = merged.observers ?? [];
      // Mirror the runtime's `disabledRules` filter (see
      // `buildSessionRuntime` in `internal/session-runtime.ts`)
      // before invoking `finalizePluginState`. Without this
      // filter, observers whose only consumer is a disabled rule
      // would appear consumed in the CLI but get dropped by the
      // runtime — a divergence between `pi-steering list` and
      // what production sees.
      const disabledRules = new Set(merged.disabledRules ?? []);
      const userRules = (merged.rules ?? []).filter(
        (r) => !disabledRules.has(r.name),
      );
      finalizePluginState(
        userRules,
        resolved.rules,
        userObservers,
        resolved.observers,
        merged.exemptions ?? [],
        resolved.exemptions ?? [],
      );
    }
    return { config: merged, diagnostics };
  } finally {
    console.info = originalInfo;
  }
}

function printListHelp(): void {
  process.stdout.write(`pi-steering list — show the resolved config

USAGE
  pi-steering list [--format=text|json]

Loads the project layer (<cwd>/.pi/steering/) and the global layer
(~/.pi/agent/steering/, or $PI_CODING_AGENT_DIR/steering) and prints
the effective plugins, rules, and observers. Project layer wins on
rule-name collision. The project layer loads only when the current
directory is trusted per pi's project-trust formula (trust.json
entries, or no trust-requiring resources present); the global layer
always loads.

FLAGS
  --format=text   (default) human-readable grouped output
  --format=json   machine-readable JSON
  -h, --help      show this help

EXIT CODES
  0   resolved successfully (warnings, if any, are fail-soft)
  1   one or more error-class diagnostics surfaced — production
      runtime would refuse to start on this config; CI lint pipelines
      can gate on this code

EXAMPLES
  pi-steering list
  pi-steering list --format=json

`);
}

/**
 * Curated mapping from a plugin's `name` to a short human-readable
 * source label (used in the `name [source]` header in text output).
 * Covers plugins shipped by this package. Unknown plugin names get
 * no bracket — the plugin name alone is enough for the user to
 * locate it.
 */
const KNOWN_PLUGIN_SOURCES: Record<string, string> = {
  git: "pi-steering/plugins/git",
  rm: "pi-steering/plugins/rm",
};

/**
 * Render the config as JSON for machine consumption.
 *
 * Shape:
 *   {
 *     plugins: [{ name, source?, rules: [{ name, tool, when }], observers: [...] }],
 *     userRules: [{ name, tool, when }],
 *     userObservers: [{ name, writes }],
 *     disabled: { rules: [...], plugins: [...] },
 *     defaultNoOverride: bool|null,
 *     projectLayerTrusted: bool
 *   }
 */
function renderListJSON(
  config: SteeringConfig,
  projectLayerTrusted: boolean,
): unknown {
  const disabledSet = new Set(config.disabledRules ?? []);
  const disabledPluginsSet = new Set(config.disabledPlugins ?? []);
  const plugins = (config.plugins ?? []).map((p) => ({
    name: p.name,
    ...(KNOWN_PLUGIN_SOURCES[p.name] !== undefined
      ? { source: KNOWN_PLUGIN_SOURCES[p.name] }
      : {}),
    ...(disabledPluginsSet.has(p.name) ? { disabled: true } : {}),
    rules: (p.rules ?? []).map((r) => ruleJSON(r, disabledSet)),
    observers: (p.observers ?? []).map((o) => observerJSON(o)),
  }));

  return {
    plugins,
    userRules: (config.rules ?? []).map((r) => ruleJSON(r, disabledSet)),
    userObservers: (config.observers ?? []).map((o) => observerJSON(o)),
    // Additive `exemptions` key: flat rows with source labels,
    // mirroring the text section. Plugin exemptions carry the
    // plugin's name; config-layer exemptions carry `"config"`.
    exemptions: [
      ...(config.plugins ?? []).flatMap((p) =>
        (p.exemptions ?? []).map((e) => exemptionJSON(e, p.name)),
      ),
      ...(config.exemptions ?? []).map((e) => exemptionJSON(e, "config")),
    ],
    disabled: {
      rules: config.disabledRules ?? [],
      plugins: config.disabledPlugins ?? [],
    },
    defaultNoOverride: config.defaultNoOverride ?? null,
    projectLayerTrusted,
  };
}

function emptyListJSON(projectLayerTrusted: boolean): unknown {
  return {
    plugins: [],
    userRules: [],
    userObservers: [],
    exemptions: [],
    disabled: { rules: [], plugins: [] },
    defaultNoOverride: null,
    projectLayerTrusted,
  };
}

function ruleJSON(r: Rule, disabledSet?: ReadonlySet<string>): unknown {
  return {
    name: r.name,
    tool: r.tool,
    ...(r.when !== undefined ? { when: whenSummaryKeys(r.when) } : {}),
    ...(disabledSet?.has(r.name) ? { disabled: true } : {}),
  };
}

function observerJSON(o: Observer): unknown {
  return {
    name: o.name,
    writes: o.writes ?? [],
  };
}

function exemptionJSON(e: Exemption, source: string): unknown {
  return {
    rule: e.rule,
    when: whenSummaryKeys(e.when),
    source,
  };
}

/**
 * Render the config as a grouped text block.
 *
 * Shape mirrors ADR §16:
 *
 *   Resolved config: 2 plugins, 4 rules, 1 observer.
 *
 *   git  [pi-steering/plugins/git]
 *     no-main-commit     bash  when: branch
 *     ...
 *
 *   User (project + global):
 *     (none)
 *
 *   Disabled: (none)
 */
function renderListText(config: SteeringConfig): string {
  const plugins = config.plugins ?? [];
  const userRules = config.rules ?? [];
  const userObservers = config.observers ?? [];
  const disabled = config.disabledRules ?? [];
  const disabledPlugins = config.disabledPlugins ?? [];
  const disabledSet = new Set(disabled);
  const disabledPluginsSet = new Set(disabledPlugins);

  const totalRules =
    plugins.reduce((n, p) => n + (p.rules?.length ?? 0), 0) + userRules.length;
  const totalObservers =
    plugins.reduce((n, p) => n + (p.observers?.length ?? 0), 0) +
    userObservers.length;

  const lines: string[] = [];
  lines.push(
    `Resolved config: ${plugins.length} ${plural("plugin", plugins.length)}, ${totalRules} ${plural("rule", totalRules)}, ${totalObservers} ${plural("observer", totalObservers)}.`,
  );
  lines.push("");

  // Per-plugin block.
  for (const plugin of plugins) {
    const source = KNOWN_PLUGIN_SOURCES[plugin.name];
    const pluginDisabled = disabledPluginsSet.has(plugin.name);
    const suffix = pluginDisabled ? "  (disabled)" : "";
    const header = source
      ? `${plugin.name}  [${source}]${suffix}`
      : `${plugin.name}${suffix}`;
    lines.push(header);
    renderRuleLines(plugin.rules ?? [], lines, disabledSet);
    renderObserverLines(plugin.observers ?? [], lines);
    lines.push("");
  }

  // User block.
  lines.push("User (project + global):");
  if (userRules.length === 0 && userObservers.length === 0) {
    lines.push("  (none)");
  } else {
    renderRuleLines(userRules, lines, disabledSet);
    renderObserverLines(userObservers, lines);
  }
  lines.push("");

  // Exemptions block — rendered ONLY when non-empty so the pinned
  // empty-case output stays byte-identical. Plugin exemptions carry
  // the plugin's name as source label; config-layer exemptions carry
  // `config`. Rows: `no-main-commit ← napkin (when: cwd)`.
  const exemptionLines: string[] = [];
  for (const plugin of plugins) {
    renderExemptionLines(plugin.exemptions ?? [], plugin.name, exemptionLines);
  }
  renderExemptionLines(config.exemptions ?? [], "config", exemptionLines);
  if (exemptionLines.length > 0) {
    lines.push("Exemptions:");
    lines.push(...exemptionLines);
    lines.push("");
  }

  // Disabled block.
  if (disabled.length === 0 && disabledPlugins.length === 0) {
    lines.push("Disabled: (none)");
  } else {
    if (disabled.length > 0) {
      lines.push(`Disabled rules: ${disabled.join(", ")}`);
    }
    if (disabledPlugins.length > 0) {
      lines.push(`Disabled plugins: ${disabledPlugins.join(", ")}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function renderRuleLines(
  rules: readonly Rule[],
  lines: string[],
  disabledSet?: ReadonlySet<string>,
): void {
  if (rules.length === 0) return;
  const nameWidth = Math.max(...rules.map((r) => r.name.length), 20);
  for (const r of rules) {
    const tools = r.tool.padEnd(5);
    const whenSummary = r.when ? `  when: ${whenSummaryKeys(r.when)}` : "";
    const disabledSuffix = disabledSet?.has(r.name) ? "  (disabled)" : "";
    lines.push(
      `  ${r.name.padEnd(nameWidth)} ${tools}${whenSummary}${disabledSuffix}`,
    );
  }
}

function renderObserverLines(
  observers: readonly Observer[],
  lines: string[],
): void {
  if (observers.length === 0) return;
  for (const o of observers) {
    const writes =
      o.writes && o.writes.length > 0 ? `  writes: ${o.writes.join(", ")}` : "";
    lines.push(`  observer: ${o.name}${writes}`);
  }
}

function renderExemptionLines(
  exemptions: readonly Exemption[],
  source: string,
  lines: string[],
): void {
  for (const ex of exemptions) {
    lines.push(`  ${ex.rule} ← ${source} (when: ${whenSummaryKeys(ex.when)})`);
  }
}

/**
 * Compact summary of a `TopLevelWhenClause`. Returns a comma-separated list
 * of keys (e.g. `branch, cwd`). Built-in keys get special labels so
 * the output is informative without dumping full predicate values:
 *   - `missing` becomes `missing:<event>`
 *   - `not` becomes `not:...`
 *   - `condition` stays `condition`
 *   - plugin predicates just show the key name (`branch`, `upstream`, …).
 */
function whenSummaryKeys(when: TopLevelWhenClause<string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(when)) {
    if (key === "missing") {
      const missing = when.missing;
      if (missing !== undefined) {
        parts.push(`missing:${missing.event}`);
      } else {
        parts.push("missing");
      }
    } else if (key === "not") {
      parts.push("not:...");
    } else {
      // Everything else (cwd, condition, plugin predicates) renders
      // as its key name — the source file is the canonical place
      // to look up the full value.
      parts.push(key);
    }
  }
  return parts.join(", ");
}

function plural(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}

// Bootstrap: only invoke `main` when this module is the entry point,
// not when imported for testing.
//
// The previous check (`process.argv[1]` compared against
// `file://${entry}`) had two failure modes: symlink invocation
// (argv[1] is the symlink path, import.meta.url the realpath) and
// non-URL-encoded interpolation (a space or `#` in the path breaks
// the match). `import.meta.main` is correct in all cases.
if (import.meta.main) {
  void main(process.argv).then((code) => {
    process.exit(code);
  });
}
