// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the Phase 5a testing primitives (`./index.ts`).
 *
 * Coverage axis:
 *   - `loadHarness`         — evaluator + dispatcher built from a
 *                              minimal config; explicit plugin
 *                              declaration (the former defaults-
 *                              injection harness flag is gone — issue
 *                              #72); plugin
 *                              merging; config.disabledRules; custom
 *                              host override.
 *   - `mockContext`         — default shape; per-option overrides; exec
 *                              stubbing + unstubbed reject; findEntries
 *                              filter + timestamp parsing; appendEntry
 *                              capture visible via getAppendedEntries.
 *   - `mockObserverContext` — default shape; exec stub pass-through;
 *                              entries/appendEntry capture.
 *   - `getAppendedEntries`  — empty on fresh ctx, populated after
 *                              appendEntry, empty on non-mock ctx.
 *
 * These are UNIT tests against the primitives — they don't exercise
 * the underlying evaluator / observer dispatcher semantics in depth
 * (those are covered in the *.test.ts suites). Here we verify the
 * wrappers assemble the right plumbing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvState, Tracker } from "@cad0p/unbash-walker";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  EVALUATOR_BUILTIN_TRACKERS,
  type EvaluatorHost,
} from "../evaluator.ts";
import { BLOCK_REASON_PREAMBLE } from "../helpers/block-reason-preamble.ts";
import { commandFromInput } from "../helpers/command.ts";
import { buildWalkRegistry } from "../internal/walk-registry.ts";
import { resolvePlugins } from "../plugin-merger.ts";
import gitPlugin from "../plugins/git/index.ts";
import type {
  Observer,
  ObserverContext,
  Plugin,
  PredicateContext,
  PredicateHandler,
  PredicateWord,
  Rule,
} from "../schema.ts";
import {
  createRecordingHost,
  expectAllows,
  expectBlocks,
  expectRuleFires,
  formatMatrix,
  getAppendedEntries,
  loadHarness,
  mockContext,
  mockExtensionContext,
  mockObserverContext,
  priorEntry,
  runMatrix,
  testObserver,
  testPredicate,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

/**
 * Minimal `ExtensionContext` stub for harness evaluate/dispatch
 * invocations. Only `cwd` + `sessionManager.getEntries` are read by
 * the evaluator pipeline; everything else we leave unset.
 */
function makeExtCtx(cwd = "/repo"): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getEntries: () => [],
    } as unknown as ExtensionContext["sessionManager"],
  } as ExtensionContext;
}

/**
 * Explicit-strict descriptors for the synthetic binaries these suites
 * drive (issue #107: absent descriptors are loud). Suites exercising
 * harness mechanics — not argv arity — pin this so their verdicts come
 * from their own feature. Suites WITH owning plugins (gitPlugin,
 * petting-zoo, …) must NOT also take it (descriptor-collision).
 */
const TEST_STRICT_FACTS = {
  name: "test-explicit-strict",
  cliDescriptors: {
    x: {},
    y: {},
    z: {},
    anything: {},
    git: {},
    npm: {},
  },
};

// ---------------------------------------------------------------------------
// loadHarness
// ---------------------------------------------------------------------------

describe("loadHarness", () => {
  it("builds evaluator + dispatcher from a minimal (empty) config", async () => {
    const h = loadHarness({ config: {} });
    // evaluator fires: allow (no rules → undefined).
    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "echo hi" },
      },
      makeExtCtx(),
      0,
    );
    assert.equal(res, undefined);
    // dispatcher fires: no observers, no throw.
    await h.dispatch(
      {
        type: "tool_result",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "echo hi" },
        content: [{ type: "text", text: "" }],
        isError: false,
        details: { exitCode: 0 },
      } as unknown as Parameters<typeof h.dispatch>[0],
      makeExtCtx(),
      0,
    );
    // Resolved shape is sane.
    assert.deepEqual(h.resolved.rules, []);
    assert.deepEqual(h.resolved.observers, []);
  });

  it("declared git plugin's no-force-push fires (explicit plugin construction)", async () => {
    // The former defaults-injection harness flag is gone (#72):
    // harness callers construct configs explicitly, declaring each
    // shipping plugin they want active.
    const h = loadHarness({ config: { plugins: [gitPlugin] } });
    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "git push --force" },
      },
      makeExtCtx(),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason ?? "", /\[steering:no-force-push@[^\]]+\]/);
  });

  it("empty config stays rule-free (nothing is injected)", async () => {
    const h = loadHarness({ config: {} });
    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "git push --force" },
      },
      makeExtCtx(),
      0,
    );
    assert.equal(res, undefined);
  });

  it("merges a custom plugin's rules + predicates", async () => {
    // Custom rule + plugin predicate; evaluate a matching bash call.
    const rule: Rule = {
      name: "no-cowsay",
      tool: "bash",
      command: "cowsay",
      reason: "no cows",
    };
    const plugin: Plugin = {
      name: "petting-zoo",
      cliDescriptors: { cowsay: {} },
      predicates: {
        // Loose predicate: always-true; here to verify the merger
        // registered it so `when` can reference it by name.
        always: async () => true,
      },
      rules: [rule],
    };
    const h = loadHarness({ config: { plugins: [plugin] } });
    assert.ok(h.resolved.predicates["always"] !== undefined);
    assert.equal(h.resolved.rules.length, 1);
    assert.equal(h.resolved.rules[0]!.name, "no-cowsay");

    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "cowsay hello" },
      },
      makeExtCtx(),
      0,
    );
    assert.ok(res && res.block === true);
  });

  it("applies config.disabledRules to named rules", async () => {
    const h = loadHarness({
      config: { plugins: [gitPlugin], disabledRules: ["no-force-push"] },
    });
    // Rule was filtered out → force-push no longer blocks.
    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "git push --force" },
      },
      makeExtCtx(),
      0,
    );
    assert.equal(res, undefined);
  });

  it("inline rule vs declared plugin's same-named rule: warning + user copy wins (#72 precedence delta)", async () => {
    // End-to-end twin of the resolvePlugins unit test: an inline rule
    // sharing `no-force-push` with the declared git plugin collides
    // loudly (warning-class rule-collision) and the inline copy — the
    // first-registered rule in the evaluator's [...userRules,
    // ...pluginRules] order — owns the block reason.
    const h = loadHarness({
      config: {
        plugins: [gitPlugin],
        rules: [
          {
            name: "no-force-push",
            tool: "bash",
            command: "git",
            reason: "user copy",
          },
        ],
      },
    });
    const collision = h.diagnostics.find((d) => d.kind === "rule-collision");
    assert.ok(collision, "expected a rule-collision warning");
    assert.equal(collision.type, "warning");
    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "git push --force origin main" },
      },
      makeExtCtx(),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason ?? "", /\[steering:no-force-push@user\]/);
    assert.doesNotMatch(res.reason ?? "", /@git\]/);
  });

  it("respects a custom host option", async () => {
    let execCalls = 0;
    const host: EvaluatorHost = {
      exec: async () => {
        execCalls++;
        return { stdout: "main", stderr: "", code: 0, killed: false };
      },
      appendEntry: () => {},
    };
    // A rule with a condition that calls ctx.exec.
    const rule: Rule = {
      name: "uses-exec",
      tool: "bash",
      command: "git",
      reason: "calls exec",
      when: {
        condition: async (ctx) => {
          await ctx.exec("git", ["rev-parse", "HEAD"]);
          return true;
        },
      },
    };
    const h = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [rule] },
      host,
    });
    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "git status" },
      },
      makeExtCtx(),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(execCalls, 1);
  });

  it("default host's unstubbed exec surfaces as a logged warning + fires fail-CLOSED (S1)", async () => {
    // S1: a throwing predicate (here: the default host's `exec`
    // throwing 'exec not stubbed') is caught by the evaluator and
    // treated as `"unknown"`. Outer-level `condition:` is
    // bare-`PredicateFn`-typed (no leaf-level `onUnknown:` opt-in
    // available), so the projection always uses the default `"block"`
    // policy and the rule fires fail-CLOSED. The test's original
    // intent — 'authors who forget to stub exec see a clear error' —
    // still holds: the warning names the rule + its source and carries
    // the original error message.
    //
    // Symmetry note: outer-level `condition:` throws now mirror the
    // inner not-block treatment + the plugin-handler exception
    // contract — throw → `"unknown"` → default `"block"` projection.
    // Authors who want fail-OPEN treatment for a throwing condition
    // need to express the policy at the containing block level (e.g.
    // inside `not: { condition: fn, onUnknown: "allow" }`).
    const rule: Rule = {
      name: "uses-exec",
      tool: "bash",
      command: "git",
      reason: "calls exec",
      when: {
        condition: async (ctx) => {
          await ctx.exec("git", ["rev-parse", "HEAD"]);
          return true;
        },
      },
    };
    const h = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [rule] },
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const result = await h.evaluate(
        {
          type: "tool_call",
          toolCallId: "t",
          toolName: "bash",
          input: { command: "git status" },
        },
        makeExtCtx(),
        0,
      );
      // Rule fires fail-CLOSED (condition: threw → unknown → default
      // leaf-level `"block"` policy fires the rule).
      assert.ok(result && result.block === true);
      // Warning names the rule + its `@<source>` tag + the
      // unstubbed-exec message via the `when.condition threw` channel.
      assert.ok(
        warnings.some((w) =>
          /Rule "uses-exec"@user.*when\.condition threw.*exec not stubbed/.test(
            w,
          ),
        ),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("exposes harness.config reflecting the effective (disable-filtered) state (T3)", () => {
    const harness = loadHarness({
      config: {
        plugins: [TEST_STRICT_FACTS],
        rules: [
          {
            name: "keep-me",
            tool: "bash",
            command: "x",
            reason: "keep",
          },
          {
            name: "drop-me",
            tool: "bash",
            command: "y",
            reason: "drop",
          },
        ],
        disabledRules: ["drop-me"],
      },
    });
    // Config mirror is post-filter: only `keep-me` survives in
    // `config.rules`; the `disabledRules` list is preserved for
    // introspection.
    assert.ok(harness.config);
    assert.equal(harness.config.rules?.length, 1);
    assert.equal(harness.config.rules?.[0]?.name, "keep-me");
    assert.deepEqual(harness.config.disabledRules, ["drop-me"]);
  });

  it("exposes harness.resolved with plugin-side rules after merger (T3)", () => {
    const pluginRule = {
      name: "plugin-rule",
      tool: "bash" as const,
      command: "x" as const,
      reason: "plugin",
    };
    const droppedPluginRule = {
      name: "dropped-plugin-rule",
      tool: "bash" as const,
      command: "y" as const,
      reason: "drop",
    };
    const harness = loadHarness({
      config: {
        plugins: [
          {
            name: "demo",
            cliDescriptors: { x: {}, y: {} },
            rules: [pluginRule, droppedPluginRule],
          },
        ],
        disabledRules: ["dropped-plugin-rule"],
      },
    });
    // `resolved` reflects plugin-merger output: plugin-shipped rules
    // after disable filtering. User rules live on `harness.config`,
    // not here.
    const resolvedNames = harness.resolved.rules.map((r) => r.name);
    assert.deepEqual(resolvedNames, ["plugin-rule"]);
    assert.ok(
      !resolvedNames.includes("dropped-plugin-rule"),
      "disabled plugin rule must not appear in resolved state",
    );
  });

  it("surfaces an empty diagnostics array for a clean config", () => {
    const rule = {
      name: "clean",
      tool: "bash" as const,
      command: "x" as const,
      reason: "clean",
    };
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [rule] },
    });
    assert.deepEqual(harness.diagnostics, []);
  });

  it("does NOT throw on a malformed plugin name; surfaces it as an invalid-name error-class diagnostic", () => {
    // `validateName` flows through the diagnostic stream rather than
    // throwing so plugin-author tests can read the failure surface
    // from `harness.diagnostics` instead of catching a thrown Error.
    const plugin: Plugin = {
      // Spaces in a plugin name forge the `[steering:<name>@<source>]`
      // block-reason tag (S3 boundary).
      name: "bad name",
    };
    const harness = loadHarness({ config: { plugins: [plugin] } });
    const hit = harness.diagnostics.find((d) => d.kind === "invalid-name");
    assert.ok(
      hit,
      `expected an invalid-name diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
    assert.match(hit.message, /^plugin name "bad name".*disallowed/);
  });

  it("surfaces a plugin-shipped orphan exemption as error-class without throwing (no-op harness)", () => {
    // Severity split at harness level: a plugin explicitly shipping a
    // carve-out targeting a rule missing from the merged universe is
    // error-class — the diagnostic is surfaced (no throw) and the
    // harness short-circuits to the no-op pair, mirroring the
    // invalid-name pattern above.
    const plugin: Plugin = {
      name: "napkin",
      exemptions: [{ rule: "no-such-rule", when: { cwd: "/vault/" } }],
    };
    const harness = loadHarness({ config: { plugins: [plugin] } });
    const hit = harness.diagnostics.find((d) => d.kind === "exemption-orphan");
    assert.ok(
      hit,
      `expected an exemption-orphan diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
    assert.match(hit.message, /\(plugin "napkin"\)/);
    // No-op short-circuit: nothing resolves, nothing fires.
    assert.equal(harness.resolved.rules.length, 0);
  });

  it("surfaces a config-written orphan exemption as warning-class (fail-soft)", () => {
    // Config-written orphans keep the fail-soft path: warning-class
    // diagnostic in `harness.diagnostics`, harness still builds
    // (warning-class alone never short-circuits).
    const harness = loadHarness({
      config: {
        exemptions: [{ rule: "no-such-rule", when: { cwd: "/vault/" } }],
      },
    });
    const hit = harness.diagnostics.find((d) => d.kind === "exemption-orphan");
    assert.ok(
      hit,
      `expected an exemption-orphan diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.equal(hit.type, "warning");
    assert.match(hit.message, /\(config\)/);
  });

  it("returns a no-op harness on a plugin-merger-side error-class diagnostic (reserved-tracker-name)", () => {
    // Symmetric short-circuit: any error-class diagnostic — from the
    // loader, the cross-config merge, OR the plugin merger — produces
    // a no-op harness so plugin-author tests see uniform behavior
    // regardless of which surface flagged the problem. Before the
    // short-circuit moved to AFTER `resolvePlugins`, plugin-merger
    // errors flowed through to a partially-built harness.
    const t = {
      initial: "?" as const,
      unknown: "unknown" as const,
      modifiers: {},
      subshellSemantics: "isolated" as const,
    };
    const plugin: Plugin = {
      name: "reserved-name-plugin",
      trackers: { events: t as never },
      rules: [
        {
          name: "would-block",
          tool: "bash" as const,
          command: "never" as const,
          reason: "never",
        },
      ],
    };
    const harness = loadHarness({ config: { plugins: [plugin] } });
    // Diagnostic surfaced.
    const hit = harness.diagnostics.find(
      (d) => d.kind === "reserved-tracker-name",
    );
    assert.ok(
      hit,
      `expected a reserved-tracker-name diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    // Harness is no-op: resolved is empty (no rules / no observers /
    // no trackers), so the would-block rule that the plugin shipped
    // alongside the bad tracker doesn't fire either.
    assert.equal(harness.resolved.rules.length, 0);
    assert.equal(harness.resolved.observers.length, 0);
    assert.deepEqual(harness.resolved.trackers, {});
    // Consistency: resolved.diagnostics mirrors the outer
    // harness.diagnostics in the no-op short-circuit branch so
    // consumers reading either surface get the same list.
    assert.equal(
      harness.resolved.diagnostics.length,
      harness.diagnostics.length,
    );
    assert.ok(
      harness.resolved.diagnostics.some(
        (d) => d.kind === "reserved-tracker-name",
      ),
    );
  });

  it("surfaces an error-class diagnostic when a plugin claims a reserved tracker name", () => {
    // Plugin authors writing tests against `loadHarness` should see
    // reserved-name violations in their diagnostics array, NOT a thrown
    // error that hides which other diagnostics fired alongside.
    const t = {
      initial: "?" as const,
      unknown: "unknown" as const,
      modifiers: {},
      subshellSemantics: "isolated" as const,
    };
    const plugin: Plugin = {
      name: "reserved-name-plugin",
      // `events` is reserved for the evaluator's speculative-entry
      // synthesis; plugins must not register a tracker under that name.
      trackers: { events: t as never },
    };
    const harness = loadHarness({ config: { plugins: [plugin] } });
    const hit = harness.diagnostics.find(
      (d) => d.kind === "reserved-tracker-name",
    );
    assert.ok(
      hit,
      `expected a reserved-tracker-name diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
  });

  it("surfaces a warning-class diagnostic when two plugins register the same predicate key", () => {
    const plugin1: Plugin = {
      name: "p1",
      predicates: { branch: () => true },
    };
    const plugin2: Plugin = {
      name: "p2",
      predicates: { branch: () => false },
    };
    const harness = loadHarness({
      config: { plugins: [plugin1, plugin2] },
    });
    const hit = harness.diagnostics.find(
      (d) => d.kind === "predicate-collision",
    );
    assert.ok(
      hit,
      `expected a predicate-collision diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.equal(hit.type, "warning");
  });

  it("does NOT throw on a tracker-name collision; surfaces it as a single error-class diagnostic", () => {
    // loadHarness aggregates loader + buildConfig + resolvePlugins
    // diagnostics and short-circuits to a no-op evaluator/dispatcher
    // when any error-class diagnostic fires, so plugin-author tests
    // can read the diagnostic from `harness.diagnostics` instead of
    // catching a thrown Error. The shared merge-pipeline helper
    // short-circuits before resolvePlugins, so the same collision
    // should appear exactly once even though both buildConfig's
    // detectTrackerNameCollisions and resolvePlugins independently
    // flag the same shape.
    const t = {
      initial: "?" as const,
      unknown: "unknown" as const,
      modifiers: {},
      subshellSemantics: "isolated" as const,
    };
    const harness = loadHarness({
      config: {
        plugins: [
          { name: "pa", trackers: { branch: t as never } },
          { name: "pb", trackers: { branch: t as never } },
        ],
      },
    });
    const hits = harness.diagnostics.filter(
      (d) => d.kind === "tracker-name-collision",
    );
    assert.equal(
      hits.length,
      1,
      `expected a single tracker-name-collision diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    const [hit] = hits;
    assert.equal(hit?.type, "error");
  });

  it("does NOT throw on a malformed user-config rule name; surfaces it as an invalid-name error-class diagnostic", () => {
    // User-config rule name validation runs inside the shared
    // merge-pipeline helper before `resolvePlugins`, so a malformed
    // rule name in the harness's input config produces the same
    // `kind: "invalid-name"` diagnostic shape as a malformed
    // plugin-shipped rule name. Without unification the harness
    // would throw a plain `pi-steering: rule name "..."` Error from
    // `buildEvaluator`, contradicting the documented "does NOT throw
    // on error-class diagnostics" contract.
    const harness = loadHarness({
      config: {
        rules: [
          {
            name: "phony] BAD",
            tool: "bash" as const,
            command: "never" as const,
            reason: "r",
          },
        ],
      },
    });
    const hit = harness.diagnostics.find((d) => d.kind === "invalid-name");
    assert.ok(
      hit,
      `expected an invalid-name diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
    assert.match(hit.message, /^rule name "phony\] BAD".*disallowed/);
    assert.match(hit.message, /\(user config\)/);
    // Harness short-circuits to a no-op evaluator/dispatcher pair
    // the same way it does for plugin-shipped errors.
    assert.equal(harness.resolved.rules.length, 0);
  });

  it("does NOT throw on a malformed user-config observer name; surfaces it as an invalid-name error-class diagnostic", () => {
    // Same shape as the rule-name case but for observers — confirms
    // the validation covers both surfaces of `validateUserConfigNames`.
    const harness = loadHarness({
      config: {
        observers: [
          {
            name: "bad observer name",
            watch: { toolName: "bash" as const },
            onResult: () => {},
          },
        ],
      },
    });
    const hit = harness.diagnostics.find((d) => d.kind === "invalid-name");
    assert.ok(
      hit,
      `expected an invalid-name diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
    assert.match(hit.message, /^observer name "bad observer name".*disallowed/);
    assert.match(hit.message, /\(user config\)/);
  });

  it("surfaces BOTH a tracker-name-collision AND a malformed user-config rule name in one harness load", () => {
    // Combined error: tracker-name-collision (merge-side) plus a
    // malformed user-config rule name. Pins that user-config name
    // validation runs unconditionally so both surface in one
    // harness load, not on consecutive runs.
    const t = {
      initial: "?" as const,
      unknown: "unknown" as const,
      modifiers: {},
      subshellSemantics: "isolated" as const,
    };
    const harness = loadHarness({
      config: {
        plugins: [
          { name: "pa", trackers: { branch: t as never } },
          { name: "pb", trackers: { branch: t as never } },
        ],
        rules: [
          {
            name: "phony] BAD",
            tool: "bash" as const,
            command: "never" as const,
            reason: "r",
          },
        ],
      },
    });
    assert.ok(
      harness.diagnostics.some((d) => d.kind === "tracker-name-collision"),
      `expected a tracker-name-collision diagnostic; got: ${JSON.stringify(harness.diagnostics)}`,
    );
    assert.ok(
      harness.diagnostics.some(
        (d) =>
          d.kind === "invalid-name" &&
          /phony\] BAD/.test(d.message) &&
          /\(user config\)/.test(d.message),
      ),
      `expected an invalid-name diagnostic for the malformed user-config rule; got: ${JSON.stringify(harness.diagnostics)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// mockContext
// ---------------------------------------------------------------------------

describe("mockContext", () => {
  it("returns a ctx with all required PredicateContext fields populated", () => {
    const ctx = mockContext();
    assert.equal(typeof ctx.cwd, "string");
    assert.equal(ctx.tool, "bash");
    assert.deepEqual(ctx.input, { tool: "bash", command: "" });
    assert.equal(ctx.agentLoopIndex, 0);
    assert.equal(typeof ctx.exec, "function");
    assert.equal(typeof ctx.appendEntry, "function");
    assert.equal(typeof ctx.findEntries, "function");
    // Default walkerState populates cwd + an empty env map (Tier B /
    // D1: plugin authors reading `walkerState.env.get(...)` get a
    // well-typed Map even when the test doesn't wire up the env
    // tracker explicitly).
    assert.deepEqual(ctx.walkerState, {
      cwd: "/tmp/test",
      env: new Map<string, string>(),
    });
  });

  it("applies cwd / agentLoopIndex / tool / input / walkerState overrides", () => {
    const ctx = mockContext({
      cwd: "/work",
      agentLoopIndex: 7,
      tool: "write",
      input: { tool: "write", path: "/a.ts", content: "x" },
      walkerState: { cwd: "/work", branch: "main" },
    });
    assert.equal(ctx.cwd, "/work");
    assert.equal(ctx.agentLoopIndex, 7);
    assert.equal(ctx.tool, "write");
    assert.deepEqual(ctx.input, {
      tool: "write",
      path: "/a.ts",
      content: "x",
    });
    // walkerState overrides merge OVER the defaults (shallow merge),
    // so branch lands, cwd overrides the default, and env stays as the
    // default empty Map — matching production evaluator shape.
    assert.deepEqual(ctx.walkerState, {
      cwd: "/work",
      env: new Map(),
      branch: "main",
    });
  });

  it("derives default input shape per tool", () => {
    const w = mockContext({ tool: "write" });
    assert.deepEqual(w.input, { tool: "write", path: "", content: "" });
    const e = mockContext({ tool: "edit" });
    assert.deepEqual(e.input, { tool: "edit", path: "", edits: [] });
  });

  it("exposes a working command view bound to the input args (#101)", () => {
    const arg = (value: string): PredicateWord =>
      ({
        value,
        text: value,
        rawText: value,
        pos: 0,
        end: value.length,
      }) as PredicateWord;
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "git commit -m a -m b",
        basename: "testcli",
        args: [arg("-m"), arg("a"), arg("-m"), arg("b")],
      },
      // Strict-always arity: the facade consumes `-m` only via the
      // descriptor binding (same channel the engine uses per ref).
      descriptors: {
        testcli: { flags: { m: { aliases: ["-m"], takesValue: true } } },
      },
    });
    assert.deepEqual(
      ctx.command.getAllFlagValues({ aliases: ["-m"], takesValue: true }),
      ["a", "b"],
    );
    assert.equal(
      ctx.command.getFlagValue({ aliases: ["-m"], takesValue: true }),
      "b",
    );
    assert.equal(
      ctx.command.hasFlag({ aliases: ["-m"], takesValue: false }),
      true,
    );
  });

  it("default input drives an empty command view (no throw)", () => {
    const ctx = mockContext();
    assert.equal(
      ctx.command.hasFlag({ aliases: ["--help"], takesValue: false }),
      false,
    );
    assert.equal(
      ctx.command.getFlagValue({ aliases: ["--help"], takesValue: false }),
      null,
    );
    assert.deepEqual(
      ctx.command.getAllFlagValues({ aliases: ["--help"], takesValue: false }),
      [],
    );
    assert.equal(ctx.command.isInfoOnly(), false);
  });

  it("stubs exec: passes through cmd/args/opts", async () => {
    const seen: Array<{
      cmd: string;
      args: readonly string[];
      cwd?: string | undefined;
    }> = [];
    const ctx = mockContext({
      exec: (cmd, args, opts) => {
        seen.push({ cmd, args, cwd: opts?.cwd });
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });
    const r = await ctx.exec("git", ["status"], { cwd: "/x" });
    assert.equal(r.stdout, "ok");
    assert.deepEqual(seen, [{ cmd: "git", args: ["status"], cwd: "/x" }]);
  });

  it("unstubbed exec rejects with a clear error", async () => {
    const ctx = mockContext();
    await assert.rejects(
      () => ctx.exec("git", ["status"]),
      /mockContext: exec not stubbed/,
    );
  });

  it("findEntries filters by customType and parses timestamps to epoch-ms", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    const ctx = mockContext({
      entries: [
        {
          type: "custom",
          customType: "a",
          data: { v: 1 },
          timestamp: iso,
        },
        {
          type: "custom",
          customType: "b",
          data: { v: 2 },
          timestamp: iso,
        },
        {
          type: "custom",
          customType: "a",
          data: { v: 3 },
          timestamp: "not-a-date",
        },
      ],
    });
    const hits = ctx.findEntries<{ v: number }>("a");
    assert.equal(hits.length, 2);
    assert.deepEqual(hits[0]!.data, { v: 1 });
    assert.equal(hits[0]!.timestamp, Date.parse(iso));
    // Unparseable timestamp → 0 (documented fallback).
    assert.equal(hits[1]!.timestamp, 0);
    // No match → empty.
    assert.deepEqual(ctx.findEntries("missing"), []);
  });

  it("appendEntry writes are captured (visible via getAppendedEntries)", () => {
    // Auto-tag: object payloads get `_agentLoopIndex` merged in,
    // bare calls wrap as `{ value: undefined, _agentLoopIndex }`.
    // Same shape the real engine writes (production parity is the
    // whole point of routing through createAppendEntry).
    const ctx = mockContext();
    ctx.appendEntry("x", { a: 1 });
    ctx.appendEntry("y"); // no data — pi allows bare customType.
    const captured = getAppendedEntries(ctx);
    assert.equal(captured.length, 2);
    assert.equal(captured[0]!.customType, "x");
    assert.deepEqual(captured[0]!.data, { a: 1, _agentLoopIndex: 0 });
    assert.equal(captured[1]!.customType, "y");
    assert.deepEqual(captured[1]!.data, {
      value: undefined,
      _agentLoopIndex: 0,
    });
  });

  it("appendEntry auto-tags object payloads with agentLoopIndex (G2)", () => {
    const ctx = mockContext({ agentLoopIndex: 5 });
    ctx.appendEntry("marker", { foo: 1 });
    const entries = getAppendedEntries(ctx);
    assert.deepEqual(entries, [
      { customType: "marker", data: { foo: 1, _agentLoopIndex: 5 } },
    ]);
  });

  it("appendEntry wraps primitive payloads as { value, _agentLoopIndex } (G2)", () => {
    const ctx = mockContext({ agentLoopIndex: 2 });
    ctx.appendEntry("num", 42);
    const entries = getAppendedEntries(ctx);
    assert.deepEqual(entries, [
      { customType: "num", data: { value: 42, _agentLoopIndex: 2 } },
    ]);
  });

  it("appendEntry wraps array payloads (F2 / G2 / G3)", () => {
    const ctx = mockContext({ agentLoopIndex: 5 });
    ctx.appendEntry("items", [1, 2, 3]);
    const entries = getAppendedEntries(ctx);
    assert.deepEqual(entries, [
      { customType: "items", data: { value: [1, 2, 3], _agentLoopIndex: 5 } },
    ]);
  });

  // ---- toolCallEvents: walkerState.events surface for tool_call-
  // ---- scope `when.missing` and plugin predicates over synthesized entries

  it("toolCallEvents default: walkerState has no `events` key when the option is omitted", () => {
    // Matches the production shape for non-bash candidates or configs
    // with no eligible observer — the evaluator's synthesis pass runs
    // only for bash, and mockContext doesn't manufacture one on the
    // caller's behalf.
    const ctx = mockContext();
    assert.equal(
      (ctx.walkerState as Record<string, unknown> | undefined)?.["events"],
      undefined,
    );
  });

  it("toolCallEvents threads through to ctx.walkerState.events", () => {
    // Surface-level: plugin authors drive `when.missing` with `in: "tool_call"`
    // in isolation by passing `toolCallEvents`. The option merges
    // into walkerState under the reserved `events` key, same shape
    // the walker-level synthesis pass produces in production.
    const events = {
      SYNC: [{ data: {}, timestamp: 2 ** 52 + 1, speculative: true as const }],
    };
    const ctx = mockContext({ toolCallEvents: events });
    const got = (ctx.walkerState as Record<string, unknown>)["events"];
    assert.equal(got, events);
  });

  it("toolCallEvents overrides an `events` entry placed on walkerState directly", () => {
    // Explicit option wins: the caller who opts into `toolCallEvents`
    // gets the canonical shape without having to strip their own
    // `walkerState.events` entry. Mirrors the evaluator's merge order
    // (`{ ...trackerState, events }`).
    const override = {
      X: [{ data: 1, timestamp: 7, speculative: true as const }],
    };
    const ctx = mockContext({
      walkerState: { cwd: "/w", events: { X: [] } },
      toolCallEvents: override,
    });
    const got = (ctx.walkerState as Record<string, unknown>)["events"];
    assert.equal(got, override);
  });

  it("testPredicate forwards toolCallEvents so plugin predicates over walkerState.events can be driven", async () => {
    // End-to-end: a plugin predicate introspects walkerState.events,
    // and testPredicate (which forwards the full options object to
    // mockContext) lets the caller exercise both branches.
    const fires: PredicateHandler<string> = async (event, ctx) => {
      const events = (ctx.walkerState as Record<string, unknown> | undefined)?.[
        "events"
      ] as Record<string, readonly unknown[]> | undefined;
      return (events?.[event]?.length ?? 0) > 0;
    };

    const cold = await testPredicate(fires, "SYNC", {});
    assert.equal(cold, false, "no toolCallEvents → predicate sees nothing");

    const warm = await testPredicate(fires, "SYNC", {
      toolCallEvents: {
        SYNC: [
          { data: {}, timestamp: 2 ** 52 + 1, speculative: true as const },
        ],
      },
    });
    assert.equal(warm, true, "toolCallEvents populated → predicate fires");
  });

  // -------------------------------------------------------------------
  // Env surface (Tier B / PR #5 — D1)
  // -------------------------------------------------------------------

  it("default walkerState carries an empty env Map", () => {
    const ctx = mockContext();
    const env = ctx.walkerState?.["env"];
    assert.ok(env instanceof Map, "walkerState.env is a Map");
    assert.equal((env as Map<string, string>).size, 0);
  });

  it("walkerState override SHALLOW-MERGES with defaults so env stays a Map (M8)", () => {
    // Correctness fix M8: `mockContext({ walkerState: { cwd: "/x" } })`
    // previously replaced the entire default, dropping `env: new Map()`
    // and crashing any predicate that did `ctx.walkerState.env.get(...)`.
    // The merge now preserves defaults for fields the override omits.
    const ctx = mockContext({ walkerState: { cwd: "/x" } });
    assert.equal(ctx.walkerState?.["cwd"], "/x", "override cwd lands");
    const env = ctx.walkerState?.["env"];
    assert.ok(
      env instanceof Map,
      "walkerState.env is still a Map — default not dropped by partial override",
    );
    assert.equal((env as Map<string, string>).size, 0);
  });

  it("walkerState.env override threads through to ctx", () => {
    const ctx = mockContext({
      walkerState: {
        cwd: "/ws/pkg",
        env: new Map([["WS", "/ws"]]),
      },
    });
    const env = ctx.walkerState?.["env"] as ReadonlyMap<string, string>;
    assert.equal(env.get("WS"), "/ws");
    assert.equal(ctx.walkerState?.["cwd"], "/ws/pkg");
  });

  it("walkerState.cwd === 'unknown' is a legal input (exercises onUnknown branch)", async () => {
    // Spec requirement: mockContext should accept walkerState.cwd
    // at the "unknown" sentinel so tests can exercise the
    // fail-closed `onUnknown: 'block'` path without wiring up a
    // full walker.
    const ctx = mockContext({
      walkerState: { cwd: "unknown", env: new Map() },
    });
    assert.equal(ctx.walkerState?.["cwd"], "unknown");

    // Sanity: a plugin predicate reading the sentinel can discriminate.
    const onUnknownBlock = async (_args: unknown, c: typeof ctx) =>
      c.walkerState?.["cwd"] === "unknown";
    assert.equal(await onUnknownBlock(null, ctx), true);
  });

  it("env is consumable by a ReasonFn-style predicate via testPredicate", async () => {
    // End-to-end: a plugin reads walkerState.env.get('NAME') and
    // fires the rule when the var resolves to a specific value.
    const envGuard: PredicateHandler<string> = async (name, ctx) => {
      const env = ctx.walkerState?.["env"] as
        | ReadonlyMap<string, string>
        | undefined;
      return env?.get(name) === "/workspace";
    };
    const hit = await testPredicate(envGuard, "WS", {
      walkerState: {
        cwd: "/start",
        env: new Map([["WS", "/workspace"]]),
      },
    });
    assert.equal(hit, true);

    const miss = await testPredicate(envGuard, "WS", {
      walkerState: { cwd: "/start", env: new Map() },
    });
    assert.equal(miss, false);
  });
});

// ---------------------------------------------------------------------------
// ctx.command harness integration (#101)
// ---------------------------------------------------------------------------

describe("ctx.command harness integration", () => {
  it("condition on getAllFlagValues fires on repeated -m (git-faithful read)", async () => {
    const rule: Rule = {
      name: "two-messages",
      tool: "bash",
      command: "git",
      reason: "two -m values",
      when: {
        condition: (ctx) =>
          ctx.command.getAllFlagValues([{ aliases: ["-m"], takesValue: true }])
            .length === 2,
      },
    };
    const h = loadHarness({
      config: {
        // Synthetic plugin-registered `-m` fact (issue #107
        // strict-always: the facade consumes only via descriptors).
        plugins: [
          {
            name: "test-facts",
            cliDescriptors: {
              git: { flags: { m: { aliases: ["-m"], takesValue: true } } },
            },
          },
        ],
        rules: [rule],
      },
    });
    const hit = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "git commit -m a -m b" },
      },
      makeExtCtx(),
      0,
    );
    assert.ok(hit && hit.block === true);
    const miss = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "bash",
        input: { command: "git commit -m a" },
      },
      makeExtCtx(),
      0,
    );
    assert.equal(miss, undefined);
  });

  it("write-tool rule sees the empty facade (no throw)", async () => {
    let sawEmpty = false;
    const rule: Rule = {
      name: "write-sees-empty-command",
      tool: "write",
      field: "path",
      pattern: ".*",
      reason: "probe",
      when: {
        condition: (ctx) => {
          sawEmpty =
            ctx.command.getAllFlagValues([
              { aliases: ["-m"], takesValue: true },
            ]).length === 0 &&
            ctx.command.getFlagValue({ aliases: ["-m"], takesValue: true }) ===
              null &&
            ctx.command.hasFlag({ aliases: ["-m"], takesValue: false }) ===
              false;
          return true;
        },
      },
    };
    const h = loadHarness({ config: { rules: [rule] } });
    const res = await h.evaluate(
      {
        type: "tool_call",
        toolCallId: "t",
        toolName: "write",
        input: { path: "/x.ts", content: "hi" },
      },
      makeExtCtx(),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(sawEmpty, true);
  });
});

// ---------------------------------------------------------------------------
// mockObserverContext
// ---------------------------------------------------------------------------

describe("mockObserverContext", () => {
  it("returns a ctx with all required ObserverContext fields populated", () => {
    const ctx = mockObserverContext();
    assert.equal(ctx.cwd, "/tmp/test");
    assert.equal(ctx.agentLoopIndex, 0);
    assert.equal(typeof ctx.appendEntry, "function");
    assert.equal(typeof ctx.findEntries, "function");
  });

  it("applies cwd / agentLoopIndex / entries overrides", () => {
    const iso = "2026-03-04T05:06:07.000Z";
    const ctx = mockObserverContext({
      cwd: "/work",
      agentLoopIndex: 3,
      entries: [
        {
          type: "custom",
          customType: "seen",
          data: { n: 42 },
          timestamp: iso,
        },
      ],
    });
    assert.equal(ctx.cwd, "/work");
    assert.equal(ctx.agentLoopIndex, 3);
    const hits = ctx.findEntries<{ n: number }>("seen");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0]!.data, { n: 42 });
    assert.equal(hits[0]!.timestamp, Date.parse(iso));
  });

  it("appendEntry captures are independent per context", () => {
    const a = mockObserverContext({ agentLoopIndex: 0 });
    const b = mockObserverContext({ agentLoopIndex: 0 });
    a.appendEntry("one", { x: 1 });
    b.appendEntry("two", { y: 2 });
    assert.deepEqual(getAppendedEntries(a), [
      { customType: "one", data: { x: 1, _agentLoopIndex: 0 } },
    ]);
    assert.deepEqual(getAppendedEntries(b), [
      { customType: "two", data: { y: 2, _agentLoopIndex: 0 } },
    ]);
  });

  it("observer appendEntry auto-tags with agentLoopIndex (G2)", () => {
    const ctx = mockObserverContext({ agentLoopIndex: 9 });
    ctx.appendEntry("seen", { foo: 1 });
    assert.deepEqual(getAppendedEntries(ctx), [
      { customType: "seen", data: { foo: 1, _agentLoopIndex: 9 } },
    ]);
  });

  it("observer appendEntry wraps primitive payloads (G2)", () => {
    const ctx = mockObserverContext({ agentLoopIndex: 3 });
    ctx.appendEntry("n", 7);
    assert.deepEqual(getAppendedEntries(ctx), [
      { customType: "n", data: { value: 7, _agentLoopIndex: 3 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getAppendedEntries
// ---------------------------------------------------------------------------

describe("getAppendedEntries", () => {
  it("returns empty for a freshly-built mockContext (nothing appended yet)", () => {
    const ctx = mockContext();
    assert.deepEqual(getAppendedEntries(ctx), []);
  });

  it("returns writes after ctx.appendEntry calls", () => {
    const ctx = mockContext();
    ctx.appendEntry("x", { a: 1 });
    const captured = getAppendedEntries(ctx);
    assert.deepEqual(captured, [
      { customType: "x", data: { a: 1, _agentLoopIndex: 0 } },
    ]);
  });

  it("returns empty for a non-mock context (safe lookup, no throw)", () => {
    // Craft a minimal non-mock PredicateContext. Shape-only — we never
    // call its methods.
    const adhoc: PredicateContext = {
      cwd: "/",
      tool: "bash",
      input: { tool: "bash", command: "" },
      command: commandFromInput({ tool: "bash", command: "" }),
      agentLoopIndex: 0,
      exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      appendEntry: () => {},
      findEntries: () => [],
    };
    assert.deepEqual(getAppendedEntries(adhoc), []);
    // Same for an ad-hoc ObserverContext.
    const adhocObs: ObserverContext = {
      cwd: "/",
      agentLoopIndex: 0,
      appendEntry: () => {},
      findEntries: () => [],
    };
    assert.deepEqual(getAppendedEntries(adhocObs), []);
  });

  it("returned snapshot is decoupled from later writes", () => {
    const ctx = mockContext();
    ctx.appendEntry("first");
    const snap = getAppendedEntries(ctx);
    ctx.appendEntry("second");
    // Snapshot captured only the first entry.
    assert.equal(snap.length, 1);
    // Re-reading picks up both.
    assert.equal(getAppendedEntries(ctx).length, 2);
  });
});

// ===========================================================================
// Phase 5b — Convenience wrappers
// ===========================================================================

describe("testPredicate", () => {
  it("returns the predicate's boolean verdict", async () => {
    const alwaysTrue: PredicateHandler<unknown> = async () => true;
    const alwaysFalse: PredicateHandler<unknown> = async () => false;
    assert.equal(await testPredicate(alwaysTrue, null), true);
    assert.equal(await testPredicate(alwaysFalse, null), false);
  });

  it("threads args + ctx (walkerState + exec stub) to the predicate", async () => {
    const branchEq: PredicateHandler<string> = async (arg, ctx) => {
      return ctx.walkerState?.["branch"] === arg;
    };
    const fires = await testPredicate(branchEq, "main", {
      walkerState: { branch: "main" },
    });
    assert.equal(fires, true);
  });

  it("predicates can call stubbed exec via ctx", async () => {
    const readsExec: PredicateHandler<unknown> = async (_, ctx) => {
      const r = await ctx.exec("echo", ["hi"]);
      return r.exitCode === 0;
    };
    const fires = await testPredicate(readsExec, null, {
      exec: () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
    });
    assert.equal(fires, true);
  });
});

describe("testObserver", () => {
  it("fires onResult when watch matches (or watch is absent)", async () => {
    const obs: Observer = {
      name: "all-events",
      onResult: (_evt, ctx) => {
        ctx.appendEntry("seen");
      },
    };
    const { entries, watchMatched } = await testObserver(obs, {
      toolName: "bash",
      input: { command: "ls" },
      output: {},
      exitCode: 0,
    });
    assert.equal(watchMatched, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.customType, "seen");
  });

  it("does NOT fire onResult when watch filter rejects", async () => {
    const obs: Observer = {
      name: "bash-only",
      watch: { toolName: "bash" },
      onResult: (_evt, ctx) => {
        ctx.appendEntry("seen");
      },
    };
    const { entries, watchMatched } = await testObserver(obs, {
      toolName: "read",
      input: {},
      output: {},
    });
    assert.equal(watchMatched, false);
    assert.equal(entries.length, 0);
  });

  it("watch.inputMatches with absent key is fail-closed", async () => {
    const obs: Observer = {
      name: "cmd-match",
      watch: { inputMatches: { command: /^git/ } },
      onResult: () => {},
    };
    const { watchMatched } = await testObserver(obs, {
      toolName: "read",
      input: {}, // no `command` field
      output: {},
    });
    assert.equal(watchMatched, false);
  });

  it("watch.exitCode: success / failure / numeric / any", async () => {
    const mk = (code: number | "success" | "failure" | "any") => ({
      name: "e" + String(code),
      watch: { exitCode: code },
      onResult: () => {},
    });
    const ok = { toolName: "bash", input: {}, output: {}, exitCode: 0 };
    const fail = {
      toolName: "bash",
      input: {},
      output: {},
      exitCode: 2,
    };
    assert.equal((await testObserver(mk("success"), ok)).watchMatched, true);
    assert.equal((await testObserver(mk("success"), fail)).watchMatched, false);
    assert.equal((await testObserver(mk("failure"), fail)).watchMatched, true);
    assert.equal((await testObserver(mk(2), fail)).watchMatched, true);
    assert.equal((await testObserver(mk("any"), fail)).watchMatched, true);
  });

  it("warns when options.exec is set (observers don't see exec)", async () => {
    const obs: Observer = { name: "n", onResult: () => {} };
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      await testObserver(
        obs,
        { toolName: "bash", input: {}, output: {} },
        { exec: () => ({ stdout: "", stderr: "", exitCode: 0 }) },
      );
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0] ?? ""), /exec option ignored/);
  });

  it("watch.inputMatches.command is wrapper-aware on bash events (ADR §12)", async () => {
    // Regression test for the former testing-side reimplementation
    // of matchesWatch: it did a raw-string match only, so a watch of
    // `command: /^git commit/` silently missed `sh -c 'git commit ...'`
    // while production correctly fired on it. Now `testObserver`
    // shares `matchesWatch` with the dispatcher so both paths agree.
    const fired: string[] = [];
    const obs: Observer = {
      name: "commit-watcher",
      watch: {
        toolName: "bash",
        inputMatches: { command: /^git commit/ },
      },
      onResult: (evt) => {
        fired.push(String((evt.input as { command?: unknown }).command));
      },
    };

    // Raw match still works (outer command IS `git commit ...`).
    const raw = await testObserver(obs, {
      toolName: "bash",
      input: { command: 'git commit -m "x"' },
      output: {},
      exitCode: 0,
    });
    assert.equal(raw.watchMatched, true);

    // Wrapper-aware: outer is `sh -c '...'`, the inner extracted ref
    // is `git commit -m "x"` — the pattern matches the inner ref, so
    // the observer fires. This previously failed silently under the
    // reimplemented filter.
    const wrapped = await testObserver(obs, {
      toolName: "bash",
      input: { command: `sh -c 'git commit -m "x"'` },
      output: {},
      exitCode: 0,
    });
    assert.equal(wrapped.watchMatched, true);
    assert.equal(fired.length, 2);

    // Negative control: an unrelated outer command doesn't match,
    // even though it's a bash event.
    const miss = await testObserver(obs, {
      toolName: "bash",
      input: { command: "ls -la" },
      output: {},
      exitCode: 0,
    });
    assert.equal(miss.watchMatched, false);
  });
});

describe("expectBlocks / expectAllows / expectRuleFires", () => {
  const blockAllRule: Rule = {
    name: "block-all",
    tool: "bash",
    command: ["x", "y", "z", "anything", "git", "npm"],
    reason: "test block",
    noOverride: true,
  };

  it("expectBlocks returns result on block", async () => {
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    const result = await expectBlocks(harness, { command: "anything" });
    assert.ok(result);
    assert.equal(result.block, true);
  });

  it("expectBlocks throws AssertionError on allow", async () => {
    const harness = loadHarness({ config: { rules: [] } });
    await assert.rejects(
      () => expectBlocks(harness, { command: "anything" }),
      /expected block, got allow/,
    );
  });

  it("expectBlocks { rule } asserts rule name match", async () => {
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    await expectBlocks(harness, { command: "x" }, { rule: "block-all" });
    await assert.rejects(
      () => expectBlocks(harness, { command: "x" }, { rule: "other-rule" }),
      /expected rule "other-rule" to fire/,
    );
  });

  it("expectBlocks { rule } resolves through the reason preamble (N4)", async () => {
    // The rule-fired block reason now carries the engine preamble;
    // `extractRuleName` must strip it before matching the tag, and
    // `expected.reason` matching must run against the stripped
    // (rule-authored) portion — both the string-equality branch
    // (below) and the RegExp branch (a `^`-anchored pattern that
    // would fail against the raw preamble-prefixed reason).
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    const result = await expectBlocks(
      harness,
      { command: "x" },
      { rule: "block-all", reason: "[steering:block-all@user] test block" },
    );
    assert.ok(
      result.reason?.startsWith(
        `${BLOCK_REASON_PREAMBLE}\n\n[steering:block-all@user]`,
      ),
    );
    await expectBlocks(
      harness,
      { command: "x" },
      { rule: "block-all", reason: /^\[steering:block-all@user\] test block/ },
    );
  });

  it("expectBlocks { reason: RegExp } asserts reason match", async () => {
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    await expectBlocks(harness, { command: "x" }, { reason: /test block/ });
    await assert.rejects(
      () => expectBlocks(harness, { command: "x" }, { reason: /wrong reason/ }),
      /reason did not match/,
    );
  });

  it("expectAllows succeeds on no block", async () => {
    const harness = loadHarness({ config: { rules: [] } });
    await expectAllows(harness, { command: "anything" });
  });

  it("expectAllows throws on block", async () => {
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    await assert.rejects(
      () => expectAllows(harness, { command: "x" }),
      /expected allow, got block/,
    );
  });

  it("expectRuleFires delegates to expectBlocks { rule }", async () => {
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    await expectRuleFires(harness, { command: "x" }, "block-all");
    await assert.rejects(
      () => expectRuleFires(harness, { command: "x" }, "nope"),
      /expected rule "nope" to fire/,
    );
  });

  it("accepts a WriteShorthand", async () => {
    const writeBlock: Rule = {
      name: "write-block",
      tool: "write",
      field: "content",
      pattern: /forbidden/,
      reason: "no",
      noOverride: true,
    };
    const harness = loadHarness({ config: { rules: [writeBlock] } });
    await expectBlocks(harness, {
      write: { path: "f.txt", content: "forbidden content" },
    });
    await expectAllows(harness, {
      write: { path: "f.txt", content: "ok content" },
    });
  });
});

describe("runMatrix / formatMatrix", () => {
  const blockAllRule: Rule = {
    name: "block-all",
    tool: "bash",
    command: ["x", "y", "z", "anything", "git", "npm"],
    reason: "test block",
    noOverride: true,
  };

  it("tallies pass / fail counts", async () => {
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    const result = await runMatrix(harness, [
      { name: "a", event: { command: "x" }, expect: "block" },
      {
        name: "b",
        event: { command: "y" },
        expect: { block: true, rule: "block-all" },
      },
      { name: "c", event: { command: "z" }, expect: "allow" }, // will fail
    ]);
    assert.equal(result.total, 3);
    assert.equal(result.passed, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.cases[0]?.passed, true);
    assert.equal(result.cases[1]?.passed, true);
    assert.equal(result.cases[2]?.passed, false);
    assert.match(
      result.cases[2]?.errorMessage ?? "",
      /expected allow.*got block/,
    );
  });

  it("block:{rule} expectation catches wrong-rule fires", async () => {
    const r1: Rule = {
      name: "rule-one",
      tool: "bash",
      command: "x",
      reason: "r1",
      noOverride: true,
    };
    const r2: Rule = {
      name: "rule-two",
      tool: "bash",
      command: "y",
      reason: "r2",
      noOverride: true,
    };
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [r1, r2] },
    });
    const result = await runMatrix(harness, [
      {
        name: "wrong-rule",
        event: { command: "x" },
        expect: { block: true, rule: "rule-two" }, // r1 fires, not r2
      },
    ]);
    assert.equal(result.passed, 0);
    assert.equal(result.failed, 1);
    assert.match(
      result.cases[0]?.errorMessage ?? "",
      /expected rule "rule-two"; got "rule-one"/,
    );
  });

  it("never throws — failures appear in the result", async () => {
    const harness = loadHarness({ config: { rules: [] } });
    // All cases will fail.
    const result = await runMatrix(harness, [
      { name: "f1", event: { command: "x" }, expect: "block" },
      { name: "f2", event: { command: "y" }, expect: "block" },
    ]);
    assert.equal(result.passed, 0);
    assert.equal(result.failed, 2);
  });

  it("formatMatrix renders a readable report", async () => {
    const harness = loadHarness({
      config: { plugins: [TEST_STRICT_FACTS], rules: [blockAllRule] },
    });
    const result = await runMatrix(harness, [
      { name: "case-a", event: { command: "x" }, expect: "block" },
      { name: "case-b", event: { command: "y" }, expect: "allow" },
    ]);
    const report = formatMatrix(result);
    assert.match(report, /MATRIX — 2 cases\. 1 pass, 1 fail/);
    assert.match(report, /\[case-a\].*expect:block.*actual:BLOCK/);
    assert.match(report, /\[case-b\].*expect:allow.*actual:BLOCK.*FAIL/);
    assert.match(report, /PASS: 1\/2/);
  });
});

// ===========================================================================
// createRecordingHost + mockExtensionContext
// ===========================================================================

describe("createRecordingHost", () => {
  it("returns a host with empty entries / execCalls / appendedEntries", () => {
    const host = createRecordingHost();
    assert.deepEqual(host.entries, []);
    assert.deepEqual(host.execCalls, []);
    assert.deepEqual(host.appendedEntries, []);
    assert.equal(typeof host.exec, "function");
    assert.equal(typeof host.appendEntry, "function");
  });

  it("appendEntry records both raw (appendedEntries) and session-shape (entries) logs", () => {
    const host = createRecordingHost();
    host.appendEntry("marker", { foo: 1 });
    host.appendEntry("marker-bare"); // bare call — pi allows no data.
    assert.equal(host.appendedEntries.length, 2);
    assert.deepEqual(host.appendedEntries[0], {
      type: "marker",
      data: { foo: 1 },
    });
    assert.deepEqual(host.appendedEntries[1], {
      type: "marker-bare",
      data: undefined,
    });

    assert.equal(host.entries.length, 2);
    // Session-shape entries mirror what pi's sessionManager emits:
    // type, customType, data, timestamp, id, parentId.
    assert.equal(host.entries[0]?.type, "custom");
    assert.equal(host.entries[0]?.customType, "marker");
    assert.deepEqual(host.entries[0]?.data, { foo: 1 });
    assert.equal(typeof host.entries[0]?.timestamp, "string");
    assert.match(
      host.entries[0]?.timestamp ?? "",
      /^2026-01-01T00:00:/, // monotonic ISO starting at the 2026-01-01 epoch.
    );
    assert.equal(host.entries[0]?.parentId, null);
    // Timestamps strictly increase so chronological asserts are stable.
    assert.ok(
      (host.entries[0]?.timestamp ?? "") < (host.entries[1]?.timestamp ?? ""),
      "entry timestamps should be monotonically increasing",
    );
  });

  it("exec defaults to empty-success, records cmd/args/cwd per call", async () => {
    const host = createRecordingHost();
    const r = await host.exec("git", ["status"], { cwd: "/work" });
    assert.deepEqual(r, {
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    });
    assert.equal(host.execCalls.length, 1);
    assert.deepEqual(host.execCalls[0], {
      cmd: "git",
      args: ["status"],
      cwd: "/work",
    });

    // A call without explicit cwd falls back to "/".
    await host.exec("pwd", []);
    assert.equal(host.execCalls[1]?.cwd, "/");
  });

  it("exec override is threaded through, default still records the call", async () => {
    const host = createRecordingHost({
      exec: async (cmd, _args, cwd) => ({
        stdout: `ran:${cmd}@${cwd}`,
        stderr: "",
        code: 0,
        killed: false,
      }),
    });
    const r = await host.exec("echo", ["hi"], { cwd: "/x" });
    assert.equal(r.stdout, "ran:echo@/x");
    assert.equal(host.execCalls.length, 1);
  });

  it("defensively copies args so later mutation doesn't corrupt the record", async () => {
    const host = createRecordingHost();
    const args = ["status"];
    await host.exec("git", args, { cwd: "/x" });
    args.push("--mutated");
    assert.deepEqual(host.execCalls[0]?.args, ["status"]);
  });
});

describe("mockExtensionContext", () => {
  it("exposes cwd + sessionManager.getEntries", () => {
    const entries = [
      {
        type: "custom" as const,
        customType: "seen",
        data: { n: 1 },
        timestamp: "2026-01-01T00:00:00.000Z",
        id: "e1",
        parentId: null,
      },
    ];
    const ctx = mockExtensionContext("/repo", entries);
    assert.equal(ctx.cwd, "/repo");
    assert.deepEqual(ctx.sessionManager.getEntries(), entries);
  });

  it("defaults entries to an empty array when omitted", () => {
    const ctx = mockExtensionContext("/repo");
    assert.deepEqual(ctx.sessionManager.getEntries(), []);
  });

  it("round-trips: host.appendEntry writes visible via ctx.sessionManager.getEntries", () => {
    // The core contract: feeding `host.entries` into the ctx lets
    // the engine's writes flow back into its subsequent reads.
    const host = createRecordingHost();
    const ctx = mockExtensionContext("/repo", host.entries);

    assert.deepEqual(ctx.sessionManager.getEntries(), []);
    host.appendEntry("mark", { a: 1 });
    const read = ctx.sessionManager.getEntries();
    assert.equal(read.length, 1);
    const first = read[0];
    assert.ok(first && first.type === "custom");
    assert.equal(first.customType, "mark");
    assert.deepEqual(first.data, { a: 1 });

    host.appendEntry("mark", { a: 2 });
    assert.equal(ctx.sessionManager.getEntries().length, 2);
  });

  it("drives harness.evaluate + harness.dispatch end-to-end with a shared entries store", async () => {
    // Demonstrates the intended plugin-author usage pattern:
    // harness + recording host + shared ctx lets a test assert on
    // the cross-hook observer → evaluator handoff without any
    // `as any` escape hatches.
    const rule: Rule = {
      name: "needs-mark",
      tool: "bash",
      command: "git",
      reason: "needs mark",
      noOverride: true,
      when: {
        // Default `when.missing` semantic: fires when the type has
        // NOT been written in the scope (ADR §5).
        missing: { event: "test-passed", in: "agent_loop" },
      },
    };
    const observer: Observer = {
      name: "test-tracker",
      watch: { toolName: "bash", inputMatches: { command: /^npm test/ } },
      onResult: (_evt, obsCtx) => {
        obsCtx.appendEntry("test-passed", {});
      },
    };

    const host = createRecordingHost();
    const ctx = mockExtensionContext("/repo", host.entries);
    const harness = loadHarness({
      config: {
        plugins: [TEST_STRICT_FACTS],
        rules: [rule],
        observers: [observer],
      },
      host,
    });

    // Without a prior test-passed entry, the guarded command blocks.
    const blocked = await harness.evaluate(
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "bash",
        input: { command: "git pu origin feat/x" },
      } as unknown as Parameters<typeof harness.evaluate>[0],
      ctx,
      0,
    );
    assert.ok(blocked && blocked.block === true);

    // Dispatch an `npm test` success → observer records test-passed.
    await harness.dispatch(
      {
        type: "tool_result",
        toolCallId: "tc1",
        toolName: "bash",
        input: { command: "npm test" },
        content: [],
        details: { exitCode: 0 },
      } as unknown as Parameters<typeof harness.dispatch>[0],
      ctx,
      0,
    );
    assert.ok(
      host.entries.some((e) => e.customType === "test-passed"),
      "observer should have recorded a test-passed entry",
    );

    // Subsequent guarded command in the same agent loop passes.
    const allowed = await harness.evaluate(
      {
        type: "tool_call",
        toolCallId: "tc2",
        toolName: "bash",
        input: { command: "git pu origin feat/x" },
      } as unknown as Parameters<typeof harness.evaluate>[0],
      ctx,
      0,
    );
    assert.equal(allowed, undefined);
  });
});

// ---------------------------------------------------------------------------
// priorEntry
// ---------------------------------------------------------------------------

describe("priorEntry", () => {
  it("merges _agentLoopIndex into plain-object data", () => {
    const entry = priorEntry(
      "ws-sync-done",
      { note: "merged" },
      { agentLoopIndex: 5 },
    );
    assert.deepEqual(entry, {
      type: "custom",
      customType: "ws-sync-done",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { note: "merged", _agentLoopIndex: 5 },
    });
  });

  it("wraps primitive data as { value, _agentLoopIndex }", () => {
    const entry = priorEntry("counter", 42, { agentLoopIndex: 2 });
    assert.deepEqual(entry.data, { value: 42, _agentLoopIndex: 2 });
  });

  it("wraps array data as { value, _agentLoopIndex } (not merged)", () => {
    const entry = priorEntry("list", [1, 2, 3], { agentLoopIndex: 1 });
    assert.deepEqual(entry.data, { value: [1, 2, 3], _agentLoopIndex: 1 });
  });

  it("wraps undefined data as { value: undefined, _agentLoopIndex }", () => {
    const entry = priorEntry("flag", undefined, { agentLoopIndex: 3 });
    assert.deepEqual(entry.data, { value: undefined, _agentLoopIndex: 3 });
  });

  it("wraps null data as { value: null, _agentLoopIndex } (null is not a plain object)", () => {
    const entry = priorEntry("sentinel", null, { agentLoopIndex: 0 });
    assert.deepEqual(entry.data, { value: null, _agentLoopIndex: 0 });
  });

  it("defaults agentLoopIndex to 0 when opts omitted", () => {
    const entry = priorEntry("marker", {});
    assert.deepEqual(entry.data, { _agentLoopIndex: 0 });
    assert.equal(entry.timestamp, "2026-01-01T00:00:00.000Z");
    assert.equal(entry.type, "custom");
    assert.equal(entry.customType, "marker");
  });

  it("respects custom timestamp when provided", () => {
    const entry = priorEntry(
      "t",
      {},
      {
        agentLoopIndex: 0,
        timestamp: "2026-06-15T12:34:56.789Z",
      },
    );
    assert.equal(entry.timestamp, "2026-06-15T12:34:56.789Z");
  });

  it("round-trip with mockContext: entry is visible to findEntries with scope tag intact", () => {
    // The entry should flow from `entries` through `findEntries` with
    // its data shape preserved, INCLUDING the _agentLoopIndex tag —
    // that's what lets the engine's agent_loop scope filter match it.
    const ctx = mockContext({
      agentLoopIndex: 5,
      entries: [priorEntry("ws-sync-done", {}, { agentLoopIndex: 5 })],
    });
    const hits = ctx.findEntries<{ _agentLoopIndex: number }>("ws-sync-done");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.data._agentLoopIndex, 5);
  });
});

// ---------------------------------------------------------------------------
// Issue #54 — harness parity for plugin env trackers
// ---------------------------------------------------------------------------
//
// testObserver gains a `walkRegistry` option so plugin authors can pin
// the resolved-form watches production dispatch uses. loadHarness's
// dispatch is production-parity by construction (it shares the real
// builder), so plugin env trackers resolve there without any harness
// option.

describe("issue #54: harness parity for plugin env trackers", () => {
  const PROBE = "PI_STEERING_PARITY_PROBE_FOO" as const;

  function pluginEnvTracker(): Tracker<EnvState> {
    return {
      initial: new Map([[PROBE, "plugin-only"]]),
      unknown: new Map(),
      modifiers: {},
      subshellSemantics: "isolated",
    };
  }

  const resolved = resolvePlugins(
    [{ name: "env-owner", trackers: { env: pluginEnvTracker() } }],
    {},
    EVALUATOR_BUILTIN_TRACKERS,
  );

  it("testObserver walkRegistry option: resolved-form watch fires, raw ref-text form does NOT", async () => {
    const event = {
      toolName: "bash",
      input: { command: `echo "$PI_STEERING_PARITY_PROBE_FOO"` },
      output: {},
      exitCode: 0,
    };
    const resolvedObs: Observer = {
      name: "resolved-watcher",
      watch: {
        toolName: "bash",
        inputMatches: { command: /echo plugin-only/ },
      },
      onResult: () => {},
    };
    const rawObs: Observer = {
      name: "raw-watcher",
      watch: {
        toolName: "bash",
        inputMatches: { command: /echo \$PI_STEERING_PARITY_PROBE_FOO/ },
      },
      onResult: () => {},
    };

    const viaOption = await testObserver(resolvedObs, event, {
      walkRegistry: buildWalkRegistry(resolved),
    });
    assert.equal(
      viaOption.watchMatched,
      true,
      "resolved-form watch fires when the plugin walk registry is supplied",
    );

    const rawViaOption = await testObserver(rawObs, event, {
      walkRegistry: buildWalkRegistry(resolved),
    });
    assert.equal(
      rawViaOption.watchMatched,
      false,
      "raw ref-text form does NOT fire — fail-open direction pinned at the harness level",
    );
  });

  it("testObserver default (no option) keeps builtin-only resolution (blind spot documented)", async () => {
    // Without the option, the lightweight path cannot resolve the
    // plugin's env — the resolved-form watch misses. This is the
    // verification-tool blind spot the walkRegistry option closes;
    // the default stays backward-compatible.
    const resolvedObs: Observer = {
      name: "resolved-watcher",
      watch: {
        toolName: "bash",
        inputMatches: { command: /echo plugin-only/ },
      },
      onResult: () => {},
    };
    const res = await testObserver(resolvedObs, {
      toolName: "bash",
      input: { command: `echo "$PI_STEERING_PARITY_PROBE_FOO"` },
      output: {},
      exitCode: 0,
    });
    assert.equal(
      res.watchMatched,
      false,
      "default walk (builtin env only) cannot match the plugin-resolved form",
    );
  });

  it("loadHarness dispatch resolves plugin env trackers (production-parity by construction)", async () => {
    const plugin: Plugin = {
      name: "env-owner",
      trackers: { env: pluginEnvTracker() },
    };
    let fired = 0;
    const obs: Observer = {
      name: "resolved-watcher",
      watch: {
        toolName: "bash",
        inputMatches: { command: /echo plugin-only/ },
      },
      onResult: () => {
        fired++;
      },
    };
    const h = loadHarness({ config: { plugins: [plugin], observers: [obs] } });
    await h.dispatch(
      {
        type: "tool_result",
        toolCallId: "t",
        toolName: "bash",
        input: { command: `echo "$PI_STEERING_PARITY_PROBE_FOO"` },
        content: [{ type: "text", text: "" }],
        isError: false,
        details: { exitCode: 0 },
      } as unknown as Parameters<typeof h.dispatch>[0],
      makeExtCtx("/repo"),
      0,
    );
    assert.equal(
      fired,
      1,
      "loadHarness dispatch threads the plugin-composed registry — resolved watch fires",
    );
  });
});

describe("mockContext binding symmetry (issue #110)", () => {
  it("with descriptors → derived arity (glued gh -Rfoo TRUE through the mock facade)", async () => {
    const { mockContext } = await import("./index.ts");
    const W = (value: string) => ({
      value,
      text: value,
      pos: 0,
      end: value.length,
    });
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "gh -Rfoo pr list",
        basename: "gh",
        args: [W("-Rfoo")],
      } as never,
      descriptors: {
        gh: {
          flags: { repo: { aliases: ["-R", "--repo"], takesValue: true } },
        },
      },
    });
    assert.equal(
      ctx.command.hasFlag({ aliases: ["-R"], takesValue: true }),
      true,
    );
  });

  it("omitted descriptors + defined basename → THROWS MissingDescriptorError (matches engine)", async () => {
    const { mockContext } = await import("./index.ts");
    const { MissingDescriptorError } = await import("../arity.ts");
    assert.throws(
      () =>
        mockContext({
          input: {
            tool: "bash",
            command: "gh pr list",
            basename: "gh",
            args: [],
          } as never,
        }),
      MissingDescriptorError,
    );
  });

  it("nameless → silent strict (never throws)", async () => {
    const { mockContext } = await import("./index.ts");
    const ctx = mockContext({
      input: { tool: "bash", command: "VAR=x" } as never,
    });
    assert.equal(
      ctx.command.hasFlag({ aliases: ["-R"], takesValue: true }),
      false,
    );
  });
});
