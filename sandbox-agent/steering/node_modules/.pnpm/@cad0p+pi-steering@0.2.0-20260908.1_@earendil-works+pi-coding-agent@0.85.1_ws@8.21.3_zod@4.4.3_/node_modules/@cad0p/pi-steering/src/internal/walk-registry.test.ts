// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Unit tests for {@link buildWalkRegistry} + {@link WATCH_DEFAULT_WALK}
 * (issue #54 parity gap: the rule surface and the observer watch
 * surface must derive the SAME effective walker registry from the same
 * resolved plugin state).
 *
 * These tests pin the STRUCTURE of the derivation — builtin fallbacks,
 * plugin-tracker precedence, extension composition, non-mutation,
 * identity of composed modifier maps. The BEHAVIORAL consequence (a
 * plugin env tracker changing what both rules AND observers see) is
 * covered end-to-end in `observer-dispatcher.test.ts` / `evaluator.test.ts`.
 *
 * Fixtures mirror production wiring: `resolvePlugins` is called with
 * `EVALUATOR_BUILTIN_TRACKERS` as `knownBuiltinTrackers` (the same
 * third argument `session-runtime.ts` / `loadHarness` pass), so
 * `trackerExtensions.env` / `trackerExtensions.cwd` are kept in
 * `trackerModifiers` for `buildWalkRegistry` to compose onto the
 * built-ins.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cwdTracker,
  envTracker,
  type Modifier,
  type Tracker,
} from "@cad0p/unbash-walker";
import { EVALUATOR_BUILTIN_TRACKERS } from "../evaluator.ts";
import { resolvePlugins } from "../plugin-merger.ts";
import type { Plugin } from "../schema.ts";
import { buildWalkRegistry, WATCH_DEFAULT_WALK } from "./walk-registry.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal env-state-shaped tracker usable as a full-replacement `env`. */
function pluginEnvTracker(seed: string): Tracker<unknown> {
  return {
    initial: new Map([["PI_STEERING_PARITY_PROBE_FOO", seed]]),
    unknown: new Map(),
    modifiers: {},
    subshellSemantics: "isolated",
  };
}

/** Minimal cwd-state-shaped tracker usable as a full-replacement `cwd`. */
function pluginCwdTracker(value: string = "/plugin"): Tracker<unknown> {
  return {
    initial: value,
    unknown: "?",
    modifiers: {},
    subshellSemantics: "isolated",
  };
}

/** Sequential no-op modifier for probing composition shape. */
function markerModifier(): Modifier<unknown> {
  return { scope: "sequential", apply: () => undefined };
}

// ---------------------------------------------------------------------------
// Builtin fallbacks
// ---------------------------------------------------------------------------

describe("buildWalkRegistry: builtin fallbacks", () => {
  it("with zero plugins, registry contains the builtin env + cwd trackers", () => {
    const resolved = resolvePlugins([], {}, EVALUATOR_BUILTIN_TRACKERS);
    const registry = buildWalkRegistry(resolved);
    assert.equal(registry["env"], envTracker, "builtin env fallback present");
    assert.equal(registry["cwd"], cwdTracker, "builtin cwd fallback present");
    // No plugin registered anything, so no composites are created.
    assert.deepEqual(Object.keys(registry).sort(), ["cwd", "env"]);
  });

  it("never mutates resolvePlugins output (composedTrackers object untouched)", () => {
    const resolved = resolvePlugins([], {}, EVALUATOR_BUILTIN_TRACKERS);
    const before = structuredClone(Object.keys(resolved.composedTrackers));
    buildWalkRegistry(resolved);
    assert.deepEqual(
      Object.keys(resolved.composedTrackers),
      before,
      "composedTrackers object must not gain the builtin entries",
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin tracker wins (no builtin overlay)
// ---------------------------------------------------------------------------

describe("buildWalkRegistry: plugin env tracker precedence", () => {
  it("a plugin registering trackers.env wins over the builtin env", () => {
    const pluginEnv = pluginEnvTracker("plugin-only");
    const resolved = resolvePlugins(
      [{ name: "env-owner", trackers: { env: pluginEnv } }],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    const registry = buildWalkRegistry(resolved);
    assert.equal(
      registry["env"],
      pluginEnv,
      "plugin tracker wins (no overlay)",
    );
    assert.notEqual(registry["env"], envTracker);
  });

  it("env is composed by the merger when a plugin tracker + extensions coexist", () => {
    const pluginEnv = pluginEnvTracker("base");
    const m = markerModifier();
    const resolved = resolvePlugins(
      [
        { name: "env-owner", trackers: { env: pluginEnv } },
        { name: "env-ext", trackerExtensions: { env: { loader: m } } },
      ],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    const registry = buildWalkRegistry(resolved);
    assert.ok(
      "env" in registry,
      "composedTrackers.env present (merger layered the extension)",
    );
    const env = registry["env"]!;
    // The merger's composeTracker already produced a fresh tracker whose
    // modifiers map fuses plugin + extension — buildWalkRegistry keeps it.
    assert.notEqual(env, pluginEnv, "composed tracker is a fresh object");
    assert.ok("loader" in env.modifiers, "extension modifier composed in");
  });
});

// ---------------------------------------------------------------------------
// trackerExtensions-only path (.envrc-style, builtin composition)
// ---------------------------------------------------------------------------

describe("buildWalkRegistry: trackerExtensions.env on the builtin (.envrc path)", () => {
  it("composes a fresh env tracker fusing builtin modifiers + the extension", () => {
    const m = markerModifier();
    const resolved = resolvePlugins(
      [{ name: "env-ext", trackerExtensions: { env: { "load-env": m } } }],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    // Sanity: the merger keeps the extension (env is a known builtin)
    // and does NOT compose it itself (no plugin owns the tracker).
    assert.ok("env" in resolved.trackerModifiers);
    assert.ok(!("env" in resolved.composedTrackers));

    const registry = buildWalkRegistry(resolved);
    const env = registry["env"]!;
    assert.notEqual(env, envTracker, "composed env is a fresh tracker");
    assert.ok("load-env" in env.modifiers, "extension modifier present");
    // Builtin modifiers are preserved alongside the extension (git's
    // env-aware cd target handling relies on the builtin cwd/env
    // modifier surface staying intact).
    assert.ok(Object.keys(env.modifiers).length > 0);

    // The composed tracker's modifiers map is a NEW map, not the
    // builtin's (mutation isolation is what composeBuiltin guarantees).
    const fresh = env.modifiers;
    const source = envTracker.modifiers as unknown as Record<string, unknown>;
    assert.notEqual(fresh, source, "modifiers map is not the builtin's map");
    assert.notEqual(
      fresh,
      resolved.trackerModifiers["env"],
      "modifiers map is not the raw extension bucket",
    );
  });
});

// ---------------------------------------------------------------------------
// cwd mirror cases
// ---------------------------------------------------------------------------

describe("buildWalkRegistry: cwd mirror cases", () => {
  it("zero plugins → builtin cwd fallback present", () => {
    const resolved = resolvePlugins([], {}, EVALUATOR_BUILTIN_TRACKERS);
    assert.equal(
      buildWalkRegistry(resolved)["cwd"],
      cwdTracker,
      "builtin cwd fallback present",
    );
  });

  it("plugin registering trackers.cwd wins over the builtin cwd", () => {
    const pluginCwd = pluginCwdTracker();
    const resolved = resolvePlugins(
      [{ name: "cwd-owner", trackers: { cwd: pluginCwd } }],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    assert.equal(
      buildWalkRegistry(resolved)["cwd"],
      pluginCwd,
      "plugin cwd tracker wins (no overlay)",
    );
  });

  it("trackerExtensions.cwd on the builtin composes a fresh tracker", () => {
    const m = markerModifier();
    const resolved = resolvePlugins(
      [{ name: "cwd-ext", trackerExtensions: { cwd: { git: m } } }],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    const cwd = buildWalkRegistry(resolved)["cwd"]!;
    assert.notEqual(cwd, cwdTracker, "composed cwd is a fresh tracker");
    assert.ok("git" in cwd.modifiers, "extension modifier present");
  });

  it("plugin trackers.cwd + trackerExtensions.cwd → merger-composed", () => {
    const pluginCwd = pluginCwdTracker();
    const m = markerModifier();
    const resolved = resolvePlugins(
      [
        { name: "cwd-owner", trackers: { cwd: pluginCwd } },
        { name: "cwd-ext", trackerExtensions: { cwd: { git: m } } },
      ],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    const cwd = buildWalkRegistry(resolved)["cwd"]!;
    assert.notEqual(cwd, pluginCwd, "composed tracker is a fresh object");
    assert.ok("git" in cwd.modifiers, "extension modifier composed in");
  });
});

// ---------------------------------------------------------------------------
// Mutation safety + modifier-map identity
// ---------------------------------------------------------------------------

describe("buildWalkRegistry: purity (no input mutation)", () => {
  it("does not mutate composedTrackers or trackerModifiers maps", () => {
    const m = markerModifier();
    const pluginEnv = pluginEnvTracker("x");
    const resolved = resolvePlugins(
      [
        { name: "env-owner", trackers: { env: pluginEnv } },
        { name: "env-ext", trackerExtensions: { env: { "load-env": m } } },
      ],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    const trackerKeysBefore = Object.keys(resolved.composedTrackers).sort();
    const modKeysBefore = Object.keys(resolved.trackerModifiers).sort();
    const innerBefore = Object.entries(
      resolved.trackerModifiers["env"] ?? {},
    ).map(([k, v]) => [k, (v as unknown[]).length]);

    buildWalkRegistry(resolved);

    assert.deepEqual(
      Object.keys(resolved.composedTrackers).sort(),
      trackerKeysBefore,
      "composedTrackers gets no new keys from the builtins",
    );
    assert.deepEqual(
      Object.keys(resolved.trackerModifiers).sort(),
      modKeysBefore,
      "trackerModifiers key set unchanged",
    );
    assert.deepEqual(
      Object.entries(resolved.trackerModifiers["env"] ?? {}).map(([k, v]) => [
        k,
        (v as unknown[]).length,
      ]),
      innerBefore,
      "trackerModifiers.env modifier buckets unchanged",
    );
  });

  it("modifiers-map identity differs when builtin extensions exist", () => {
    const m = markerModifier();
    const resolved = resolvePlugins(
      [{ name: "env-ext", trackerExtensions: { env: { "load-env": m } } }],
      {},
      EVALUATOR_BUILTIN_TRACKERS,
    );
    const env = buildWalkRegistry(resolved)["env"]!;
    assert.notEqual(
      env.modifiers,
      envTracker.modifiers,
      "composed modifiers map is NOT the builtin env's map",
    );
    assert.notEqual(
      env.modifiers,
      resolved.trackerModifiers["env"],
      "composed modifiers map is NOT the raw extension bucket",
    );
  });
});

// ---------------------------------------------------------------------------
// WATCH_DEFAULT_WALK
// ---------------------------------------------------------------------------

describe("WATCH_DEFAULT_WALK", () => {
  it("is exactly the builtin env tracker and frozen", () => {
    assert.deepEqual(
      Object.keys(WATCH_DEFAULT_WALK),
      ["env"],
      "exactly one key: env",
    );
    assert.equal(WATCH_DEFAULT_WALK["env"], envTracker);
    assert.ok(Object.isFrozen(WATCH_DEFAULT_WALK));
  });

  it("buildWalkRegistry of an empty resolved differs from WATCH_DEFAULT_WALK", () => {
    // Production dispatch uses buildWalkRegistry (builtin env+cwd);
    // standalone watch calls use WATCH_DEFAULT_WALK (builtin env only).
    const resolved = resolvePlugins([], {}, EVALUATOR_BUILTIN_TRACKERS);
    const registry = buildWalkRegistry(resolved);
    assert.ok("cwd" in registry, "production registry carries builtin cwd");
    assert.ok(!("cwd" in WATCH_DEFAULT_WALK));
  });
});
