// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * TS config loader. Two fixed layers: the project layer at
 * `<cwd>/.pi/steering/` (or `.pi/steering.ts`) and the global layer
 * at `<agentDir>/steering/`, dynamic-import each, merge inner-first
 * (project layer wins on name-keyed collisions). Per-symbol JSDoc
 * carries the contract; see also the {@link SteeringDiagnostic} /
 * {@link SteeringDiagnosticKind} JSDoc for the diagnostic stream.
 *
 * Trust gate: the project layer loads only when the project is
 * trusted — `loadConfigs` accepts pi's RESOLVED project-trust
 * decision via {@link LoadConfigsOptions} (see {@link loadConfigs}).
 */

import {
  accessSync,
  constants,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { EVALUATOR_BUILTIN_TRACKERS } from "./evaluator.ts";
import { runMergerPipeline } from "./internal/session-runtime.ts";
import { formatTrackerNameCollisionMessage } from "./plugin-merger.ts";
import type {
  Exemption,
  Observer,
  Plugin,
  Rule,
  SteeringConfig,
  SteeringDiagnostic,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Candidate file paths for a given directory's `slot` (default
 * `.pi/steering`), in priority order. First existing file wins.
 *
 * Exported for tests — not part of the library's public API.
 */
export function configCandidates(dir: string, slot = ".pi/steering"): string[] {
  return [join(dir, slot, "index.ts"), join(dir, `${slot}.ts`)];
}

/**
 * Return the non-`.ts` files that exist under `<dir>/<slot>` so
 * callers can warn about them. Uses a best-effort fs read: a missing
 * directory returns an empty list.
 */
function unexpectedFilesUnderSteering(
  dir: string,
  slot = ".pi/steering",
): string[] {
  const steeringDir = join(dir, slot);
  if (!existsSync(steeringDir)) return [];
  try {
    // globSync with withFileTypes: true (Node >=22.2, inside the
    // floor) deliberately narrows the stray scan to non-dotfile
    // regular files: dotfiles (.gitignore, .DS_Store, editor junk)
    // are never config-candidate files, so warning about them is
    // noise; symlinked entries are excluded (glob reports them as
    // non-file dirents, and a symlinked helper is a deliberate
    // redirect, not a stray); directories stay filtered by
    // isFile(). Ordering is sorted (glob) — previously unspecified
    // and unpinned.
    const entries = globSync("*", {
      cwd: steeringDir,
      withFileTypes: true,
    });
    const out: string[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name === "index.ts") continue;
      if (name.endsWith(".ts")) continue; // allow helpers like `rules.ts`
      if (!entry.isFile()) continue;
      out.push(join(steeringDir, name));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve the pi agent directory: `$PI_CODING_AGENT_DIR` when set
 * (tilde-expanded: `"~"` → home, `"~/x"` → `<home>/x`, anything else
 * as-is), else `<home>/.pi/agent`. Mirrors pi's `getAgentDir()` in
 * @earendil-works/pi-coding-agent.
 *
 * Exported for tests.
 */
export function resolveAgentDir(): string {
  const envDir = process.env["PI_CODING_AGENT_DIR"];
  if (envDir !== undefined && envDir !== "") {
    // mirror pi's expandTildePath: "~" -> homedir, "~/x" -> homedir/x, else as-is
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * Find the config file (if any) for a single layer. Returns the
 * resolved file path and a `layer-form-coexistence` diagnostic when
 * both `<slot>/index.ts` and `<slot>.ts` coexist in the same
 * directory (the directory form wins).
 *
 * Exported for tests.
 */
export function findConfigFile(
  dir: string,
  slot = ".pi/steering",
): {
  file: string | null;
  diagnostic: SteeringDiagnostic | null;
} {
  const [indexForm, flatForm] = configCandidates(dir, slot);
  const indexExists = indexForm !== undefined && existsSync(indexForm);
  const flatExists = flatForm !== undefined && existsSync(flatForm);
  let diagnostic: SteeringDiagnostic | null = null;
  if (indexExists && flatExists && indexForm !== undefined) {
    // `path` points at the directory holding the conflict so the
    // renderer's `${path}: ${message}` prefix surfaces the parent
    // once and the message names which two forms coexist. The winning
    // file path is implicit (the directory form always wins).
    diagnostic = {
      type: "warning",
      kind: "layer-form-coexistence",
      path: dir,
      message:
        `both ${slot}.ts and ${slot}/index.ts exist; using ` +
        `directory form. Delete ${slot}.ts to remove this warning.`,
    };
  }
  if (indexExists) return { file: indexForm ?? null, diagnostic };
  if (flatExists) return { file: flatForm ?? null, diagnostic };
  return { file: null, diagnostic };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Options for {@link loadConfigs} / {@link loadSteeringConfig}.
 *
 * `projectLayerTrusted` carries pi's RESOLVED project-trust decision
 * for the load root: when `false`, the project layer at
 * `<cwd>/.pi/steering/` is skipped and an `info`-class
 * `layer-project-untrusted` diagnostic is emitted (only when a
 * project-layer config candidate exists); the global layer ALWAYS
 * loads. When `undefined` or `true` the gate is inert and today's
 * exact behavior applies. The loader never resolves trust itself —
 * it adopts the caller's decision (bridge captures `ctx.isProjectTrusted()`
 * pre-await; the CLI mirrors pi's non-UI formula).
 */
export interface LoadConfigsOptions {
  projectLayerTrusted?: boolean;
}

/**
 * jiti's id-relative default cache resolution (prepareCacheDir) treats
 * the instance id as a directory: for a file id like `<pkg>/src/loader.ts`
 * it probes `<pkg>/src/node_modules` (never exists) and silently falls
 * back to `${tmpdir}/jiti` — volatile (wiped on reboot → every pi
 * process re-pays the ~1.2s cold transpile once), machine-wide shared
 * and unbounded. Pin to the package's own `node_modules/.cache/jiti`
 * when the package has a node_modules dir; fall back to jiti's default
 * otherwise (status quo).
 *
 * Exported for tests — not part of the library's public API.
 */
export function resolveJitiCacheDir(moduleUrl: string): string | true {
  if (!moduleUrl.startsWith("file://")) return true;
  const pkgRoot = dirname(dirname(fileURLToPath(moduleUrl)));
  const nm = join(pkgRoot, "node_modules");
  try {
    if (!existsSync(nm)) return true; // never create a stray node_modules
    const dir = join(nm, ".cache", "jiti");
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  } catch {
    return true; // read-only pnpm store etc. → jiti default (tmpdir), same as today
  }
}
const JITI_CACHE_DIR = resolveJitiCacheDir(import.meta.url);

/**
 * Load a single config file (via jiti `evalModule`) and return its
 * default export. The module MUST `export default` a
 * {@link SteeringConfig} object — the loader does not accept
 * module-namespace imports as a fallback, to keep the authoring
 * contract unambiguous.
 *
 * Throws a scoped error when the import fails, when the module has no
 * default export, or when the default export isn't a plain object —
 * the caller surfaces these per-layer without bringing the whole
 * session down (a single bad layer shouldn't nuke the engine).
 *
 * Reload contract: a FRESH jiti instance is created per call (the
 * per-instance parent cache starts empty, so nothing leaks between
 * loads), and `moduleCache: false` keeps jiti from registering
 * anything in `require.cache` — every load re-reads and re-evaluates
 * the file from disk, INCLUDING everything the config transitively
 * imports (sibling `.ts` / `.js` files, `node_modules` plugins).
 * `fsCache` is a source-level cache only (transformed output, keyed
 * by content hash) — it never affects reload semantics. The source
 * string is evaluated fresh each call, so a failed load never
 * poisons subsequent loads. Cache location contract: the directory
 * is pinned to `<pkgRoot>/node_modules/.cache/jiti` when the package
 * has a writable `node_modules` dir (see
 * {@link resolveJitiCacheDir}), else jiti's default `${tmpdir}/jiti`
 * fallback. The option is passed explicitly, so `JITI_FS_CACHE` env
 * defaults are overridden either way — unchanged from before (the
 * loader already passed `fsCache: true` explicitly; jiti's option
 * merge gives userOptions precedence over env defaults).
 *
 * `async: true` is passed explicitly to `evalModule`: it wraps the
 * module in an async function, so top-level `await` and dynamic
 * `import()` inside configs work, and `evalModule` returns a Promise
 * (hence the `await` below).
 *
 * jiti's default `interopDefault: true` wraps the module namespace in
 * an interop Proxy, so NEITHER `"default" in mod` NOR `mod.default`
 * reliably detects a real default export. The proxy's `get` trap
 * falls back to the namespace (or a `{ default: … }` wrapper)
 * whenever the real default is nullish, so `mod.default` is never
 * `undefined`; and `in` falls through to the raw exports object,
 * which OWNS a `default` key even for `export default undefined`.
 * The only reliable signal is the own-property descriptor probe
 * below (`Object.getOwnPropertyDescriptor`): it bypasses the proxy's
 * traps, sees the raw exports object, and yields `value: undefined`
 * exactly when the source default is `undefined` (`export default
 * null` throws inside evalModule before this guard runs).
 */
async function importConfigFile(path: string): Promise<SteeringConfig> {
  // Fresh instance per load: per-instance parentCache is empty, and
  // moduleCache: false keeps jiti from registering anything in
  // require.cache — every load re-reads + re-evaluates from disk,
  // including everything the config transitively imports.
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: JITI_CACHE_DIR,
  });
  const source = readFileSync(path, "utf8");
  // async: true → async wrapper: top-level await + dynamic import()
  // inside configs work; evalModule returns a Promise<module namespace>.
  const mod = (await jiti.evalModule(source, {
    filename: path,
    async: true,
  })) as {
    default?: unknown;
  } & Record<string, unknown>;

  // Probe the own property descriptor instead of `"default" in mod`
  // or `mod.default`: jiti's interop wrapper (interopDefault: true)
  // is a Proxy whose `get` trap fabricates a non-`undefined` value
  // for nullish real defaults — `export default undefined` yields an
  // object and a named-exports-only module yields the namespace, so
  // the bare checks would never fire and the module would silently
  // load as a config. `in` is no better: it falls through to the raw
  // exports object, which DOES own a `default` key for `export
  // default undefined`. The descriptor (which bypasses the proxy's
  // traps) is the only signal that sees the raw exports object AND
  // the true value of its `default` key.
  const defaultDesc = Object.getOwnPropertyDescriptor(mod, "default");
  if (defaultDesc === undefined || defaultDesc.value === undefined) {
    // Path is intentionally omitted from the message; the caller wraps
    // this throw in a `layer-import-failed` diagnostic whose own `path`
    // field is the single source of truth for the file location.
    throw new Error(
      "config file must have a default export. Use " +
        "`export default { ... } satisfies SteeringConfig` or " +
        "`export default defineConfig({ ... })`.",
    );
  }
  const candidate = defaultDesc.value;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new Error(
      `config file default export must be a SteeringConfig object, ` +
        `got ${Array.isArray(candidate) ? "array" : typeof candidate}.`,
    );
  }
  return candidate as SteeringConfig;
}

/**
 * Load the two fixed config layers for `cwd`: the project layer at
 * `<cwd>/.pi/steering/` (or `.pi/steering.ts`) and the global layer
 * at `<agentDir>/steering/` (see {@link resolveAgentDir}). Returns
 * the layers INNER-FIRST (project first, then global; caller passes
 * to {@link buildConfig}, which expects inner-first so early entries
 * take precedence on collisions).
 *
 * Trust gate: when `opts.projectLayerTrusted === false`, the project
 * layer is SKIPPED entirely — no candidate scan beyond the
 * `existsSync` probe, no stray-file scan, no coexistence diagnostic,
 * no import (the gate precedes jiti eval, the loader's only
 * code-execution surface). An `info`-class `layer-project-untrusted`
 * diagnostic is emitted only when a project-layer config candidate
 * exists (`findConfigFile(cwd, ".pi/steering").file !== null`), so
 * an untrusted project without one produces no noise. The global
 * layer loads unconditionally in every case. `projectLayerTrusted`
 * undefined or `true` → exact pre-gate behavior.
 *
 * Issues encountered along the way (per-layer import failure, dual
 * form coexistence, stray non-`.ts` file under the layer directory)
 * surface as structured {@link SteeringDiagnostic} entries on the
 * returned object. The loader does not log to `console.warn` directly
 * — the bridge runtime owns the policy decision (throw vs. log) once
 * it has collected diagnostics from every source.
 */
export async function loadConfigs(
  cwd: string,
  opts?: LoadConfigsOptions,
): Promise<{
  layers: SteeringConfig[];
  diagnostics: SteeringDiagnostic[];
}> {
  const layers: SteeringConfig[] = [];
  const diagnostics: SteeringDiagnostic[] = [];
  if (opts?.projectLayerTrusted === false) {
    // Gate: nothing of the project layer is inspected beyond the
    // candidate probe — no stray scan, no coexistence diagnostic,
    // no import. The coexistence diagnostic is intentionally NOT
    // produced when untrusted (accepted, documented).
    if (findConfigFile(cwd, ".pi/steering").file !== null) {
      diagnostics.push({
        type: "info",
        kind: "layer-project-untrusted",
        path: join(cwd, ".pi", "steering"),
        message:
          "project layer skipped (project untrusted); global layer still applies",
      });
    }
  } else {
    await loadLayer(cwd, ".pi/steering", layers, diagnostics);
  }
  await loadLayer(resolveAgentDir(), "steering", layers, diagnostics);
  return { layers, diagnostics };
}

/**
 * Load a single layer: `slot` under `dir` (candidate file discovery,
 * coexistence diagnostic, stray-file scan, dynamic import). Shared by
 * the project layer (`cwd` + `.pi/steering`) and the global layer
 * (`agentDir` + `steering`).
 */
async function loadLayer(
  dir: string,
  slot: string,
  layers: SteeringConfig[],
  diagnostics: SteeringDiagnostic[],
): Promise<void> {
  const { file, diagnostic } = findConfigFile(dir, slot);
  if (diagnostic !== null) diagnostics.push(diagnostic);
  if (file === null) {
    // Surface stray files under `<slot>/` that the loader won't pick
    // up. Only check when the directory exists but has no `index.ts`
    // — otherwise a project without any steering directory would
    // emit noise.
    const slotDir = join(dir, slot);
    if (existsSync(slotDir)) {
      for (const stray of unexpectedFilesUnderSteering(dir, slot)) {
        diagnostics.push({
          type: "warning",
          kind: "layer-stray-file",
          path: stray,
          message: `ignoring non-.ts file under ${slot}/`,
        });
      }
    }
    return;
  }
  try {
    layers.push(await importConfigFile(file));
  } catch (err) {
    // Use err.message to drop the `Error: ` class prefix; native
    // runtime errors (jiti syntax errors) may embed their path inside
    // the message and we accept that duplication.
    const body = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      type: "warning",
      kind: "layer-import-failed",
      path: file,
      message: `failed to import: ${body}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Collect plugins across layers, recording a diagnostic for each
 * cross-layer duplicate plugin name. First-registered wins (inner
 * layer is first — matches pi's project-local → global convention).
 *
 * The caller is responsible for unioning `config.disabledPlugins`
 * across layers and passing the result as `disabledPlugins` (see
 * `buildConfig`). Plugins whose name appears in the supplied set are
 * still merged into the output (so downstream surfaces like
 * `pi-steering list` can render them tagged as disabled), but they're
 * EXEMPT from collision detection. A user resolving a duplicate-plugin
 * warning by adding the plugin to `disabledPlugins` should see the
 * warning go away in the same config edit; detect-then-disable would
 * still surface the warning even though the disable already settled
 * the conflict.
 */
function mergePlugins(
  layers: readonly SteeringConfig[],
  disabledPlugins: ReadonlySet<string>,
  diagnostics: SteeringDiagnostic[],
): Plugin[] {
  const seen = new Set<string>();
  const out: Plugin[] = [];
  for (const layer of layers) {
    if (!layer.plugins) continue;
    for (const plugin of layer.plugins) {
      if (seen.has(plugin.name)) {
        if (!disabledPlugins.has(plugin.name)) {
          diagnostics.push({
            type: "warning",
            kind: "plugin-name-collision",
            message: `duplicate plugin "${plugin.name}"; keeping first-registered entry.`,
          });
        }
        continue;
      }
      seen.add(plugin.name);
      out.push(plugin);
    }
  }
  return out;
}

/**
 * Merge rules across layers — inner layer's rule name overrides outer.
 * Declaration order within a layer is preserved; cross-layer order is
 * "first layer that mentions a given rule name wins for its slot".
 *
 * Records a diagnostic on duplicate names WITHIN a single layer
 * (authoring mistake) — mirrors {@link mergeObservers}. Cross-layer
 * collisions stay silent: overriding a rule by name is the documented
 * customization path.
 *
 * Disabled rules are merged but exempt from collision detection (see
 * {@link mergePlugins} for rationale).
 */
function mergeRules(
  layers: readonly SteeringConfig[],
  disabledRules: ReadonlySet<string>,
  diagnostics: SteeringDiagnostic[],
): Rule[] {
  const byName = new Map<string, Rule>();
  for (const layer of layers) {
    if (!layer.rules) continue;
    const seenInLayer = new Set<string>();
    for (const rule of layer.rules) {
      if (seenInLayer.has(rule.name)) {
        if (!disabledRules.has(rule.name)) {
          diagnostics.push({
            type: "warning",
            kind: "rule-name-collision",
            message:
              `duplicate rule "${rule.name}" within single config layer; ` +
              "keeping first, dropping subsequent",
          });
        }
        continue;
      }
      seenInLayer.add(rule.name);
      if (!byName.has(rule.name)) {
        byName.set(rule.name, rule);
      }
    }
  }
  return [...byName.values()];
}

/**
 * Merge observers across layers — inner layer's observer name
 * overrides outer. Records a diagnostic on duplicate names WITHIN a
 * single layer (authoring mistake); cross-layer overrides are silent
 * (intentional customization).
 */
function mergeObservers(
  layers: readonly SteeringConfig[],
  diagnostics: SteeringDiagnostic[],
): Observer[] {
  const byName = new Map<string, Observer>();
  for (const layer of layers) {
    if (!layer.observers) continue;
    const seenInLayer = new Set<string>();
    for (const obs of layer.observers) {
      if (seenInLayer.has(obs.name)) {
        diagnostics.push({
          type: "warning",
          kind: "observer-name-collision",
          message: `duplicate observer "${obs.name}"; keeping first-registered entry.`,
        });
        continue;
      }
      seenInLayer.add(obs.name);
      if (!byName.has(obs.name)) {
        byName.set(obs.name, obs);
      }
    }
  }
  return [...byName.values()];
}

/**
 * Merge simple string-list fields (`disabledRules`, `disabledPlugins`)
 * as a union across layers. Preserves first-seen order for deterministic
 * output in tests.
 */
function mergeStringUnion(
  layers: readonly SteeringConfig[],
  key: "disabledRules" | "disabledPlugins",
): string[] | undefined {
  const seen = new Set<string>();
  let any = false;
  for (const layer of layers) {
    const list = layer[key];
    if (list === undefined) continue;
    any = true;
    for (const item of list) seen.add(item);
  }
  return any ? [...seen] : undefined;
}

/**
 * Merge config-layer exemptions as a UNION across layers — no
 * inner-wins (unlike rules / plugins / observers, which override by
 * name). Every layer's carve-outs apply; per-rule OR-ing happens at
 * evaluation time.
 *
 * Declaration order is preserved (inner-first, then outer) for
 * deterministic output in tests. Duplicates are intentionally NOT
 * deduped: the registry has no collision concept, and evaluation is
 * idempotent under duplicates.
 */
function mergeExemptions(
  layers: readonly SteeringConfig[],
): Exemption[] | undefined {
  const out: Exemption[] = [];
  for (const layer of layers) {
    if (!layer.exemptions) continue;
    out.push(...layer.exemptions);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Inner-wins boolean merge over the inner-first layers. Walks
 * left-to-right (inner-first); returns the first explicit boolean or
 * `undefined`. Used by `buildConfig` and the session runtime for the
 * inner-wins boolean fields. Internal — not in the package's
 * `exports` surface.
 */
export function mergeBool(
  layers: readonly SteeringConfig[],
  key: "defaultNoOverride" | "failOnWarnings",
): boolean | undefined {
  for (const layer of layers) {
    const v = layer[key];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

/**
 * Detect plugins registering a tracker under the same name and push
 * an error-class diagnostic for each collision. Two plugins claiming
 * the same state dimension is always a bug; the runtime escalates
 * these to a thrown error regardless of the user's strict-mode
 * preference.
 *
 * Plugins whose name appears in `disabledPlugins` are skipped before
 * collision detection (mirrors {@link mergePlugins}).
 */
function detectTrackerNameCollisions(
  plugins: readonly Plugin[],
  disabledPlugins: ReadonlySet<string>,
  diagnostics: SteeringDiagnostic[],
): void {
  const seen = new Map<string, string>(); // trackerName -> pluginName
  for (const plugin of plugins) {
    if (disabledPlugins.has(plugin.name)) continue;
    if (!plugin.trackers) continue;
    for (const trackerName of Object.keys(plugin.trackers)) {
      const prior = seen.get(trackerName);
      if (prior !== undefined) {
        diagnostics.push({
          type: "error",
          kind: "tracker-name-collision",
          message: formatTrackerNameCollisionMessage(
            prior,
            plugin.name,
            trackerName,
          ),
        });
        continue;
      }
      seen.set(trackerName, plugin.name);
    }
  }
}

/**
 * Merge `layers` (inner-first) into a single effective
 * {@link SteeringConfig}. There are no engine-injected defaults
 * (issue #72): the merged config contains exactly what the layers
 * declare.
 *
 * Cross-layer plugin name collisions, within-layer rule + observer
 * name collisions, and cross-layer tracker name collisions surface
 * as structured {@link SteeringDiagnostic} entries on the returned
 * object. Predicate-key + tracker-extension collisions are detected
 * in `resolvePlugins`, not here — buildConfig handles cross-layer and
 * within-layer name-collision shapes only.
 */
export function buildConfig(layers: readonly SteeringConfig[]): {
  config: SteeringConfig;
  diagnostics: SteeringDiagnostic[];
} {
  const effective: SteeringConfig[] = [...layers];

  const diagnostics: SteeringDiagnostic[] = [];

  const disabledPluginsList = mergeStringUnion(effective, "disabledPlugins");
  const disabledRulesList = mergeStringUnion(effective, "disabledRules");
  const disabledPluginsSet = new Set(disabledPluginsList ?? []);
  const disabledRulesSet = new Set(disabledRulesList ?? []);

  // Predicate + tracker-extension collisions are detected in
  // resolvePlugins, not here. buildConfig handles cross-layer and
  // within-layer name-collision shapes only.
  const plugins = mergePlugins(effective, disabledPluginsSet, diagnostics);
  detectTrackerNameCollisions(plugins, disabledPluginsSet, diagnostics);

  const rules = mergeRules(effective, disabledRulesSet, diagnostics);
  const observers = mergeObservers(effective, diagnostics);
  const exemptions = mergeExemptions(effective);

  const out: SteeringConfig = {};
  if (plugins.length > 0) out.plugins = plugins;
  if (rules.length > 0) out.rules = rules;
  if (observers.length > 0) out.observers = observers;
  if (exemptions !== undefined) out.exemptions = exemptions;

  if (disabledRulesList !== undefined) out.disabledRules = disabledRulesList;
  if (disabledPluginsList !== undefined) {
    out.disabledPlugins = disabledPluginsList;
  }

  const defaultNoOverride = mergeBool(effective, "defaultNoOverride");
  if (defaultNoOverride !== undefined) {
    out.defaultNoOverride = defaultNoOverride;
  }
  const failOnWarnings = mergeBool(effective, "failOnWarnings");
  if (failOnWarnings !== undefined) out.failOnWarnings = failOnWarnings;

  return { config: out, diagnostics };
}

/**
 * Convenience: load all layers for `cwd`, run the loader-side merge
 * (`buildConfig`), then the plugin merger (`resolvePlugins`) with
 * user-config rule + observer name validation between the two passes.
 * `opts` is forwarded to {@link loadConfigs} unchanged (trust-gate
 * parity for embedders — see {@link LoadConfigsOptions}).
 * Diagnostics from every surface flow into a single returned array,
 * so an external embedder writing their own bridge or pre-flight
 * check sees the SAME diagnostic stream the production runtime sees
 * — no surface is silently skipped.
 *
 * Diagnostics return in declaration order; merge-side errors
 * short-circuit `resolvePlugins` before its diagnostics are added.
 *
 * Production-strictness divergence: `loadSteeringConfig` does NOT
 * apply the strict-mode `failOnWarnings` throw policy that
 * `buildSessionRuntime` does. The function never throws on
 * diagnostics; embedders apply their own throw + warning policy.
 * See `failOnWarnings` on {@link SteeringConfig} for production-
 * faithful pre-flight semantics.
 */
export async function loadSteeringConfig(
  cwd: string,
  opts?: LoadConfigsOptions,
): Promise<{ config: SteeringConfig; diagnostics: SteeringDiagnostic[] }> {
  const { layers, diagnostics: loaderDiagnostics } = await loadConfigs(
    cwd,
    opts,
  );
  const { merged, diagnostics: mergeAndResolveDiagnostics } = runMergerPipeline(
    layers,
    EVALUATOR_BUILTIN_TRACKERS,
  );
  return {
    config: merged,
    diagnostics: [...loaderDiagnostics, ...mergeAndResolveDiagnostics],
  };
}
