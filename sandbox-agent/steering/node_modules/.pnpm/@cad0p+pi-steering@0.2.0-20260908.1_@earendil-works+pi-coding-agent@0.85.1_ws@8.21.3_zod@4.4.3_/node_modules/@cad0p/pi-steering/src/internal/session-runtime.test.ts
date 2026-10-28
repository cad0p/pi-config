// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Direct coverage for the strict-mode contract owned by
 * `buildSessionRuntime`. Tests:
 *
 *   - error-class diagnostics always escalate to a thrown error;
 *   - warning-class diagnostics escalate when `failOnWarnings !==
 *     false`;
 *   - with `failOnWarnings: false`, warnings fall back to
 *     `console.warn` and the runtime returns normally;
 *   - the aggregated error message follows the rule-based spec
 *     (header + bullets, errors first, optional path prefix).
 *
 * Uses a tmp `$HOME` so the loader's global layer is scoped to the
 * test directory.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  makeCtx,
  useIsolatedHome,
  writeSteeringSingleFileConfig,
} from "../__test-helpers__.ts";
import type { SteeringDiagnostic } from "../schema.ts";
import {
  buildSessionRuntime,
  formatAggregatedDiagnostics,
  formatSingleLineDiagnostic,
  runMergerPipeline,
} from "./session-runtime.ts";

/** Minimal evaluator host; the strict-mode tests don't drive evaluation. */
const noopHost = {
  exec: async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  }),
  appendEntry: () => {},
};

describe("buildSessionRuntime: strict-mode contract", () => {
  let tmpHome: string;
  let warnings: string[];
  let origWarn: typeof console.warn;
  let origInfo: typeof console.info;
  useIsolatedHome("pi-steering-runtime-", (t) => {
    tmpHome = t;
  });

  beforeEach(() => {
    warnings = [];
    origWarn = console.warn;
    origInfo = console.info;
    console.warn = (msg: unknown) => {
      warnings.push(String(msg));
    };
    // Silence the "observer dropped" info-level chatter; only the
    // strict-mode warn channel is under assertion here.
    console.info = () => {};
  });

  afterEach(() => {
    console.warn = origWarn;
    console.info = origInfo;
  });

  it("returns evaluator + dispatcher when there are no diagnostics", async () => {
    // No config layers, no plugins, no diagnostics. There are no
    // engine-injected defaults (issue #72), so an empty home yields
    // a clean, rule-free runtime.
    const result = await buildSessionRuntime(tmpHome, noopHost);
    assert.ok(result.evaluator);
    assert.ok(result.dispatcher);
    assert.deepEqual(warnings, []);
  });

  it("fresh-empty config: zero active rules — nothing blocks (issue #72 headline)", async () => {
    // THE headline behavior change of the defaults cut: a fresh
    // install with NO steering config has NO implicit rails. Every
    // former default (no-force-push, no-rm-rf-slash, …) is inert
    // until its shipping plugin is declared. Assert end-to-end that
    // the canonical destructive commands evaluate to undefined.
    const result = await buildSessionRuntime(tmpHome, noopHost);
    const event = (command: string) => ({
      type: "tool_call" as const,
      toolCallId: "t1",
      toolName: "bash",
      input: { command },
    });
    const ctx = makeCtx(tmpHome);
    assert.equal(
      await result.evaluator.evaluate(event("git push --force"), ctx, 0),
      undefined,
      "no-force-push must NOT fire without the git plugin declared",
    );
    assert.equal(
      await result.evaluator.evaluate(event("rm -rf /"), ctx, 0),
      undefined,
      "no-rm-rf-slash must NOT fire without the rm plugin declared",
    );
  });

  it("fresh-empty merged config: the merged universe is empty", async () => {
    // Merge-level twin of the e2e assertion above: the empty-config
    // universe is EMPTY (no implicit rails to inherit).
    const { merged, diagnostics } = runMergerPipeline([], []);
    assert.equal(merged.rules, undefined);
    assert.equal(merged.plugins, undefined);
    assert.deepEqual(diagnostics, []);
  });

  it("throws on a warning-class diagnostic by default (failOnWarnings undefined)", async () => {
    // A plugin-shipped predicate collision via direct buildConfig
    // would be hard to stage from a written config; instead, write
    // a config layer that declares two within-layer duplicate rules
    // (rule-name-collision, type:'warning').
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				rules: [
					{ name: "dup", tool: "bash", command: "never", reason: "first" },
					{ name: "dup", tool: "bash", command: "never", reason: "second" },
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        assert.match(err.message, /^1 config issue:/);
        assert.match(err.message, /\[warning\]/);
        assert.match(err.message, /duplicate rule "dup"/);
        return true;
      },
    );
  });

  it("does NOT throw on a warning-class diagnostic when failOnWarnings: false; emits to console.warn", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				failOnWarnings: false,
				rules: [
					{ name: "dup", tool: "bash", command: "never", reason: "first" },
					{ name: "dup", tool: "bash", command: "never", reason: "second" },
				],
			};`,
    );
    const result = await buildSessionRuntime(tmpHome, noopHost);
    assert.ok(result.evaluator);
    assert.ok(result.dispatcher);
    assert.ok(
      warnings.some(
        (w) =>
          w.startsWith("[pi-steering] ") && w.includes('duplicate rule "dup"'),
      ),
      `expected a legacy console.warn for the rule collision; got: ${JSON.stringify(warnings)}`,
    );
  });

  it("throws on an error-class diagnostic regardless of failOnWarnings", async () => {
    // Two plugins claim the tracker `branch`. The loader's
    // buildConfig pushes an error-class tracker-name-collision
    // diagnostic; the strict-mode opt-out applies only to warnings,
    // not errors. Setting `failOnWarnings: false` does NOT change
    // the throw — errors always escalate.
    //
    // Single-emission lock: both `buildConfig` and `resolvePlugins`
    // independently detect tracker-name collisions. The runtime's
    // short-circuit between the two passes (when merge-side has any
    // error-class diagnostic) drops the second detection so the
    // aggregated message lists the collision exactly once — the
    // header reads `1 config issue:` (singular), and a regex count
    // of the bullet line confirms there's no duplicate.
    writeSteeringSingleFileConfig(
      tmpHome,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				failOnWarnings: false,
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        assert.match(err.message, /^1 config issue:/);
        assert.match(err.message, /\[error\]/);
        assert.match(err.message, /tracker name collision/);
        const collisionLines = err.message.match(/tracker name collision/g);
        assert.equal(
          collisionLines?.length,
          1,
          `expected exactly one tracker-name-collision bullet (short-circuit drops the second emission); got ${collisionLines?.length}: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("throws on an invalid-name diagnostic for a malformed plugin name", async () => {
    // `validateName` flows through the diagnostic stream rather than
    // throwing a plain Error, so the strict-mode aggregation surfaces
    // the malformed name in the same `N config issue:` shape as other
    // error-class diagnostics. The malformed plugin must use a name
    // shape the loader's plugin-name validation accepts — here we
    // trigger the merger via a malformed RULE name shipped by an
    // otherwise-valid plugin.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				plugins: [
					{
						name: "forge-plugin",
						rules: [
							{
								name: "bad name",
								tool: "bash",
								command: "never",
								reason: "r",
							},
						],
					},
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        assert.match(err.message, /^1 config issue:/);
        assert.match(err.message, /\[error\]/);
        assert.match(err.message, /^.*rule name "bad name".*disallowed/m);
        return true;
      },
    );
  });

  it("aggregates multiple diagnostics with errors first", async () => {
    // One error (tracker collision) + one warning (rule
    // collision). Aggregated message lists the error before the
    // warning.
    writeSteeringSingleFileConfig(
      tmpHome,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
				rules: [
					{ name: "dup", tool: "bash", command: "never", reason: "first" },
					{ name: "dup", tool: "bash", command: "never", reason: "second" },
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        const message = err.message;
        assert.match(message, /^2 config issues:/);
        const errorIdx = message.indexOf("[error]");
        const warningIdx = message.indexOf("[warning]");
        assert.ok(errorIdx > -1, "expected an [error] line");
        assert.ok(warningIdx > -1, "expected a [warning] line");
        assert.ok(
          errorIdx < warningIdx,
          "errors should be ordered before warnings",
        );
        return true;
      },
    );
  });

  it("throws on a malformed user-config rule name (aggregated, not plain Error)", async () => {
    // User-config rule + observer names route through the same
    // `invalid-name` diagnostic stream as plugin-shipped names. Before
    // the unification, this case threw a plain `pi-steering: rule name
    // "..."` Error from `buildEvaluator` rather than the aggregated
    // `N config issue:` shape; production callers and tests then had
    // to handle two distinct error formats for what is structurally
    // the same kind of issue.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				rules: [
					{
						name: "phony] BAD",
						tool: "bash",
						command: "never",
						reason: "r",
					},
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        assert.match(err.message, /^1 config issue:/);
        assert.match(err.message, /\[error\]/);
        assert.match(
          err.message,
          /rule name "phony\] BAD" \(user config\) contains disallowed/,
        );
        // Confirm the legacy plain-Error shape is GONE.
        assert.doesNotMatch(err.message, /^pi-steering: rule name/);
        return true;
      },
    );
  });

  it("aggregates a malformed user-config rule name with a warning-class diagnostic into one throw", async () => {
    // Combined error (user-config invalid name) + warning (observer
    // dropped). Confirms the user-config name diagnostic flows through
    // the same aggregation path as everything else — single throw,
    // errors-first ordering.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				rules: [
					{
						name: "phony] BAD",
						tool: "bash",
						command: "never",
						reason: "r",
					},
					{
						name: "dup",
						tool: "bash",
						command: "never",
						reason: "first",
					},
					{
						name: "dup",
						tool: "bash",
						command: "never",
						reason: "second",
					},
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        assert.match(err.message, /^2 config issues:/);
        const errorIdx = err.message.indexOf("[error]");
        const warningIdx = err.message.indexOf("[warning]");
        assert.ok(errorIdx > -1, "expected an [error] line");
        assert.ok(warningIdx > -1, "expected a [warning] line");
        assert.ok(
          errorIdx < warningIdx,
          "errors should be ordered before warnings",
        );
        assert.match(err.message, /\(user config\)/);
        return true;
      },
    );
  });

  it("aggregates a tracker-name-collision merge error AND a malformed user-config rule name into one throw", async () => {
    // Combined error: tracker-name-collision (merge-side) plus a
    // malformed user-config rule name. Pins that user-config name
    // validation runs unconditionally so both surface together
    // rather than the user seeing them on separate runs.
    writeSteeringSingleFileConfig(
      tmpHome,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
				rules: [
					{
						name: "phony] BAD",
						tool: "bash",
						command: "never",
						reason: "r",
					},
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        assert.match(err.message, /^2 config issues:/);
        assert.match(err.message, /tracker name collision/);
        assert.match(
          err.message,
          /rule name "phony\] BAD" \(user config\) contains disallowed/,
        );
        // Both errors render under [error] tags — errors-first
        // ordering is trivially satisfied (no warnings in this case).
        const errorTags = err.message.match(/\[error\]/g) ?? [];
        assert.equal(
          errorTags.length,
          2,
          `expected two [error] tags; got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

describe("buildSessionRuntime: project-trust gate", () => {
  let tmpHome: string;
  let infos: string[];
  let warns: string[];
  let origInfo: typeof console.info;
  let origWarn: typeof console.warn;
  useIsolatedHome("pi-steering-runtime-", (t) => {
    tmpHome = t;
  });

  beforeEach(() => {
    infos = [];
    warns = [];
    origInfo = console.info;
    origWarn = console.warn;
    console.info = (msg: unknown) => {
      infos.push(String(msg));
    };
    console.warn = (msg: unknown) => {
      warns.push(String(msg));
    };
  });

  afterEach(() => {
    console.info = origInfo;
    console.warn = origWarn;
  });

  /** Project config + global config: the project one is the gate target. */
  function writeTrustGateFixture(): void {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				rules: [
					{ name: "proj-rule", tool: "bash", command: "never", reason: "proj" },
				],
			};`,
    );
    writeGlobalConfig(
      `export default {
				rules: [
					{ name: "global-rule", tool: "bash", command: "never", reason: "global" },
				],
			};`,
    );
  }

  /** Write a config at the global layer `<agentDir>/steering/index.ts`. */
  function writeGlobalConfig(body: string): void {
    const dir = join(tmpHome, ".pi", "agent", "steering");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), body, "utf8");
  }

  it("emits a console.info breadcrumb and keeps global-layer steering when untrusted", async () => {
    writeTrustGateFixture();
    const result = await buildSessionRuntime(tmpHome, noopHost, {
      projectLayerTrusted: false,
    });
    assert.ok(result.evaluator);
    assert.ok(result.dispatcher);
    // Breadcrumb: exactly one info line, single-line shape with the
    // skipped dir as path prefix.
    const breadcrumbs = infos.filter((m) =>
      m.includes("project layer skipped"),
    );
    assert.equal(
      breadcrumbs.length,
      1,
      `expected exactly one skip breadcrumb; got: ${JSON.stringify(infos)}`,
    );
    assert.match(
      breadcrumbs[0] ?? "",
      /^\[pi-steering\] \[info\] .*\.pi\/steering: project layer skipped/,
    );
    // The skip never reaches console.warn (F1 single-route contract).
    assert.equal(
      warns.filter((w) => w.includes("project layer skipped")).length,
      0,
      `expected no skip line on console.warn; got: ${JSON.stringify(warns)}`,
    );
  });

  it("strict-mode aggregate throw does NOT mention the skip", async () => {
    // A warning-producing GLOBAL config + an untrusted project layer:
    // the strict-mode throw carries the warning but never the
    // info-class skip (aggregate filters error/warning by
    // construction).
    writeTrustGateFixture();
    // Make the global layer warning-producing (within-layer duplicate).
    writeGlobalConfig(
      `export default {
				rules: [
					{ name: "dup", tool: "bash", command: "never", reason: "first" },
					{ name: "dup", tool: "bash", command: "never", reason: "second" },
				],
			};`,
    );
    await assert.rejects(
      () =>
        buildSessionRuntime(tmpHome, noopHost, {
          projectLayerTrusted: false,
        }),
      (err: Error) => {
        assert.match(err.message, /^1 config issue:/);
        assert.match(err.message, /duplicate rule "dup"/);
        assert.doesNotMatch(err.message, /project layer skipped/);
        assert.doesNotMatch(err.message, /layer-project-untrusted/);
        return true;
      },
    );
    // Breadcrumb still fired before the throw (escalation-independent).
    assert.equal(
      infos.filter((m) => m.includes("project layer skipped")).length,
      1,
      `expected the skip breadcrumb despite the strict-mode throw; got: ${JSON.stringify(infos)}`,
    );
  });

  it("failOnWarnings: false does NOT double-emit the skip (F1 pin)", async () => {
    // Global config with a warning + failOnWarnings: false → fail-soft
    // path. The skip must appear exactly once (console.info) and zero
    // times on console.warn — the fail-soft loop filters to
    // warning-class only. Project config candidate present so the
    // info diagnostic fires.
    writeTrustGateFixture();
    writeGlobalConfig(
      `export default {
				failOnWarnings: false,
				rules: [
					{ name: "dup", tool: "bash", command: "never", reason: "first" },
					{ name: "dup", tool: "bash", command: "never", reason: "second" },
				],
			};`,
    );
    const result = await buildSessionRuntime(tmpHome, noopHost, {
      projectLayerTrusted: false,
    });
    assert.ok(result.evaluator);
    assert.ok(result.dispatcher);
    assert.equal(
      infos.filter((m) => m.includes("project layer skipped")).length,
      1,
      `expected exactly one skip breadcrumb on console.info; got: ${JSON.stringify(infos)}`,
    );
    assert.equal(
      warns.filter((w) => w.includes("project layer skipped")).length,
      0,
      `expected zero skip lines on console.warn (F1); got: ${JSON.stringify(warns)}`,
    );
    // The warning itself still reaches console.warn once (fail-soft
    // route unchanged).
    assert.equal(
      warns.filter((w) => w.includes('duplicate rule "dup"')).length,
      1,
      `expected the warning on console.warn; got: ${JSON.stringify(warns)}`,
    );
  });

  it("failOnWarnings escalation is unaffected by the gate (absent opts)", async () => {
    // Without opts the gate is inert: project layer loads, its
    // warning escalates under strict mode exactly as before.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				rules: [
					{ name: "dup", tool: "bash", command: "never", reason: "first" },
					{ name: "dup", tool: "bash", command: "never", reason: "second" },
				],
			};`,
    );
    await assert.rejects(
      () => buildSessionRuntime(tmpHome, noopHost),
      (err: Error) => {
        assert.match(err.message, /^1 config issue:/);
        assert.match(err.message, /duplicate rule "dup"/);
        return true;
      },
    );
    assert.equal(infos.length, 0, "no info breadcrumb without the gate");
  });
});

describe("buildSessionRuntime: observer-drop breadcrumbs", () => {
  let tmpHome: string;
  let infos: string[];
  let origInfo: typeof console.info;
  let origWarn: typeof console.warn;
  useIsolatedHome("pi-steering-runtime-", (t) => {
    tmpHome = t;
  });

  beforeEach(() => {
    infos = [];
    origInfo = console.info;
    origWarn = console.warn;
    console.info = (msg: unknown) => {
      infos.push(String(msg));
    };
    // Silence the strict-mode warn channel; only the info-level
    // observer-drop breadcrumb is under assertion here.
    console.warn = () => {};
  });

  afterEach(() => {
    console.info = origInfo;
    console.warn = origWarn;
  });

  it("emits an `observer dropped` breadcrumb when the observer's only consumer rule is disabled via `disabledRules` (parity with CLI)", async () => {
    // Symmetric to the CLI regression test in
    // `bin/pi-steering.test.ts` ("surfaces an `observer dropped`
    // breadcrumb when the consumer rule is disabled via
    // `disabledRules`"). The runtime filters `merged.rules` against
    // `disabledRules` BEFORE handing the union to
    // `dropUnusedObservers`, so an observer whose only consumer is
    // disabled gets dropped at runtime build time (session start). This test pins the
    // production code path — a future refactor that swaps the
    // runtime's filter order (filtering after observer-drop instead
    // of before, or skipping the filter entirely) would let
    // `pi-steering list` continue to surface the breadcrumb
    // correctly while production silently fails to drop the
    // observer.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				disabledRules: ["consumer"],
				observers: [
					{
						name: "obs-x",
						writes: ["X"],
						onResult: () => {},
					},
				],
				rules: [
					{
						name: "consumer",
						tool: "bash",
						command: "never",
						reason: "r",
						when: { missing: { event: "X" } },
					},
				],
			};`,
    );
    const result = await buildSessionRuntime(tmpHome, noopHost);
    assert.ok(result.evaluator);
    assert.ok(result.dispatcher);
    const breadcrumb = infos.find((m) =>
      /\[pi-steering\] observer 'obs-x' dropped; its writes \(X\) are not consumed by any rule/.test(
        m,
      ),
    );
    assert.ok(
      breadcrumb !== undefined,
      `expected observer-drop breadcrumb on console.info (consumer rule was disabled, observer should be reported as dropped); got: ${JSON.stringify(infos)}`,
    );
  });

  it("does NOT drop the observer when the consumer rule is enabled (inverse parity)", async () => {
    // Cross-surface symmetry with the inverse-parity test in
    // `bin/pi-steering.test.ts` (O1 in INVARIANTS.md): both surfaces
    // must agree that an enabled consumer keeps its observer alive.

    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				observers: [
					{
						name: "obs-x",
						writes: ["X"],
						onResult: () => {},
					},
				],
				rules: [
					{
						name: "consumer",
						tool: "bash",
						command: "never",
						reason: "r",
						when: { missing: { event: "X" } },
					},
				],
			};`,
    );
    const result = await buildSessionRuntime(tmpHome, noopHost);
    assert.ok(result.evaluator);
    assert.ok(result.dispatcher);
    const breadcrumb = infos.find((m) =>
      /\[pi-steering\] observer 'obs-x' dropped/.test(m),
    );
    assert.equal(
      breadcrumb,
      undefined,
      `expected NO observer-drop breadcrumb (consumer rule is enabled, observer is consumed); got: ${JSON.stringify(infos)}`,
    );
  });

  it("does NOT drop the observer when the only consumer is an exemption's missing (O1 parity extension)", async () => {
    // An observer whose writes are consumed ONLY by an exemption's
    // top-level `missing` must survive the drop — otherwise the
    // carve-out is silently dead (its event never written).
    // `finalizePluginState` threads both exemption buckets (config +
    // plugin) into `collectConsumedEvents`; this test pins the config
    // bucket through the production factory path.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				observers: [
					{
						name: "obs-x",
						writes: ["X"],
						onResult: () => {},
					},
				],
				rules: [
					{
						name: "consumer",
						tool: "bash",
						command: "never",
						reason: "r",
					},
				],
				exemptions: [
					{
						rule: "consumer",
						when: { missing: { event: "X" } },
					},
				],
			};`,
    );
    const result = await buildSessionRuntime(tmpHome, noopHost);
    assert.ok(result.evaluator);
    assert.ok(result.dispatcher);
    const breadcrumb = infos.find((m) =>
      /\[pi-steering\] observer 'obs-x' dropped/.test(m),
    );
    assert.equal(
      breadcrumb,
      undefined,
      `expected NO observer-drop breadcrumb (exemption's missing consumes the write); got: ${JSON.stringify(infos)}`,
    );
  });
});

describe("formatAggregatedDiagnostics: rule-based spec", () => {
  it("renders a single warning with no path prefix", () => {
    const diagnostics: SteeringDiagnostic[] = [
      {
        type: "warning",
        kind: "plugin-name-collision",
        message: 'duplicate plugin "git"; keeping first-registered entry.',
      },
    ];
    const out = formatAggregatedDiagnostics(diagnostics);
    assert.equal(
      out,
      "1 config issue:\n" +
        '  - [warning] duplicate plugin "git"; keeping first-registered entry.',
    );
  });

  it("renders a single error with the singular header noun", () => {
    const diagnostics: SteeringDiagnostic[] = [
      {
        type: "error",
        kind: "tracker-name-collision",
        message: 'tracker name collision: plugins "a" and "b"',
      },
    ];
    const out = formatAggregatedDiagnostics(diagnostics);
    assert.match(out, /^1 config issue:/);
    assert.match(out, /\[error\] tracker name collision/);
  });

  it("renders multiple diagnostics with errors-first ordering and the plural header noun", () => {
    const diagnostics: SteeringDiagnostic[] = [
      {
        type: "warning",
        kind: "layer-import-failed",
        path: "/u/.pi/steering.ts",
        message: "failed to import: SyntaxError",
      },
      {
        type: "error",
        kind: "tracker-name-collision",
        message: 'tracker name collision: plugins "a" and "b"',
      },
      {
        type: "warning",
        kind: "plugin-name-collision",
        message: 'duplicate plugin "git"',
      },
    ];
    const out = formatAggregatedDiagnostics(diagnostics);
    const lines = out.split("\n");
    assert.equal(lines[0], "3 config issues:");
    // Error-class lines appear before warning-class.
    assert.match(lines[1] ?? "", /\[error\] tracker name collision/);
    assert.match(lines[2] ?? "", /\[warning\] /);
    assert.match(lines[3] ?? "", /\[warning\] /);
  });

  it("includes a path prefix when SteeringDiagnostic.path is set", () => {
    const diagnostics: SteeringDiagnostic[] = [
      {
        type: "warning",
        kind: "layer-stray-file",
        path: "/u/.pi/steering/rules.json",
        message: "ignoring non-.ts file under .pi/steering/",
      },
    ];
    const out = formatAggregatedDiagnostics(diagnostics);
    assert.match(out, /\[warning\] \/u\/\.pi\/steering\/rules\.json:/);
  });
});

describe("formatSingleLineDiagnostic: rule-based spec", () => {
  it("renders a warning with a [warning] severity tag and a path prefix", () => {
    const d: SteeringDiagnostic = {
      type: "warning",
      kind: "layer-import-failed",
      path: "/u/.pi/steering.ts",
      message: "failed to import: SyntaxError",
    };
    assert.equal(
      formatSingleLineDiagnostic(d),
      "[pi-steering] [warning] /u/.pi/steering.ts: failed to import: SyntaxError",
    );
  });

  it("renders a warning with a [warning] severity tag and no path prefix", () => {
    const d: SteeringDiagnostic = {
      type: "warning",
      kind: "plugin-name-collision",
      message: 'duplicate plugin "git"; keeping first-registered entry.',
    };
    assert.equal(
      formatSingleLineDiagnostic(d),
      '[pi-steering] [warning] duplicate plugin "git"; keeping first-registered entry.',
    );
  });

  it("renders an error with an [error] severity tag and a path prefix", () => {
    const d: SteeringDiagnostic = {
      type: "error",
      kind: "layer-import-failed",
      path: "/u/.pi/steering.ts",
      message: "failed to import: SyntaxError",
    };
    assert.equal(
      formatSingleLineDiagnostic(d),
      "[pi-steering] [error] /u/.pi/steering.ts: failed to import: SyntaxError",
    );
  });

  it("renders an error with an [error] severity tag and no path prefix", () => {
    const d: SteeringDiagnostic = {
      type: "error",
      kind: "tracker-name-collision",
      message: 'tracker name collision: plugins "a" and "b"',
    };
    assert.equal(
      formatSingleLineDiagnostic(d),
      '[pi-steering] [error] tracker name collision: plugins "a" and "b"',
    );
  });
});
