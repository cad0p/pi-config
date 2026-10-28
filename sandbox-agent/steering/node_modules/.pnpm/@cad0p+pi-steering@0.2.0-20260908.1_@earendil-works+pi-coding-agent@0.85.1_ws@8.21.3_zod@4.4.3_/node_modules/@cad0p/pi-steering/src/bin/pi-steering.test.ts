// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the `@cad0p/pi-steering` CLI (`./pi-steering.ts`).
 *
 * Runs the CLI as a subprocess via `node src/bin/pi-steering.ts …`.
 * This mirrors real invocation (the built
 * shebang script runs under a fresh node) and sidesteps the
 * `node:test` worker's stdout sharing — patching
 * `process.stdout.write` in-process swallows the worker's TAP frames.
 *
 * File IO fixtures live under `mkdtempSync`; each test cleans up its
 * directory in `afterEach`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSteeringDirConfig } from "../__test-helpers__.ts";

// ---------------------------------------------------------------------------
// subprocess runner
// ---------------------------------------------------------------------------

const CLI_PATH = resolve(import.meta.dirname, "pi-steering.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI as a child process under `node`.
 * Returns the exit code and captured stdout/stderr. Never throws for
 * non-zero exit codes — the caller asserts on `code`.
 *
 * Accepts an optional `cwd` so tests for the `list` subcommand can
 * point the loader's project layer at a scratch directory and isolate
 * HOME so no real global config leaks, without polluting the project.
 */
function runCli(...args: string[]): Promise<RunResult>;
function runCli(opts: { cwd?: string }, ...args: string[]): Promise<RunResult>;
function runCli(
  first?: string | { cwd?: string },
  ...rest: string[]
): Promise<RunResult> {
  let cwd: string | undefined;
  let args: string[];
  if (typeof first === "object" && first !== null) {
    cwd = first.cwd;
    args = rest;
  } else {
    args = first === undefined ? [...rest] : [first, ...rest];
  }
  // The child CLI reads the global layer from `$HOME`; without
  // isolation the developer's real `~/.pi/agent/steering/` would
  // leak into the tests. `PI_CODING_AGENT_DIR` must be removed (an
  // empty string still overrides the default agent dir).
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: scratch };
  delete env.PI_CODING_AGENT_DIR;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd !== undefined ? { cwd } : {}),
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      // Filter the Node experimental-strip-types warning so tests
      // assert against clean stderr. Type stripping is default-on on
      // the floor, so the warning no longer appears; the filter stays
      // as harmless robustness against other warnings.
      const cleanedStderr = stderr
        .split("\n")
        .filter((line) => !/ExperimentalWarning/.test(line))
        .filter((line) => !/Use `node --trace-warnings/.test(line))
        .join("\n");
      resolvePromise({
        code: code ?? -1,
        stdout,
        stderr: cleanedStderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// tmpdir fixture
// ---------------------------------------------------------------------------

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pi-steering-cli-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// top-level
// ---------------------------------------------------------------------------

describe("pi-steering CLI: help + dispatch", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await runCli("--help");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /pi-steering — tools for/);
    assert.match(r.stdout, /import-json/);
    assert.match(r.stdout, /list \[--format=/);
    assert.equal(r.stderr.trim(), "");
  });

  it("-h prints usage and exits 0", async () => {
    const r = await runCli("-h");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /USAGE/);
  });

  it("no args prints usage and exits 0", async () => {
    const r = await runCli();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /USAGE/);
  });

  it("unknown subcommand writes to stderr and exits 1", async () => {
    const r = await runCli("bogus-sub");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown subcommand "bogus-sub"/);
    // Help still gets written to stdout for context.
    assert.match(r.stdout, /USAGE/);
  });
});

// ---------------------------------------------------------------------------
// import-json: argument parsing
// ---------------------------------------------------------------------------

describe("pi-steering import-json: argument parsing", () => {
  it("requires an input file", async () => {
    const r = await runCli("import-json");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires an input file/);
  });

  it("rejects unknown flags", async () => {
    const r = await runCli("import-json", "--nope");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag "--nope"/);
  });

  it("rejects -o without an argument", async () => {
    const r = await runCli("import-json", "input.json", "-o");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-o requires an argument/);
  });

  it("rejects more than one positional argument", async () => {
    const r = await runCli("import-json", "a.json", "b.json");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /too many positional arguments/);
  });
});

// ---------------------------------------------------------------------------
// import-json: IO error paths
// ---------------------------------------------------------------------------

describe("pi-steering import-json: IO errors", () => {
  it("missing file -> stderr + exit 1", async () => {
    const r = await runCli("import-json", join(scratch, "nope.json"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot read /);
  });

  it("invalid JSON -> stderr + exit 1", async () => {
    const path = join(scratch, "bad.json");
    writeFileSync(path, "{ not json", "utf8");
    const r = await runCli("import-json", path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// import-json: happy path
// ---------------------------------------------------------------------------

const VALID_V1 = {
  disable: ["no-secrets"],
  rules: [
    {
      name: "no-secrets",
      tool: "write",
      field: "path",
      pattern: "^/etc/",
      reason: "Don't write outside the project.",
    },
  ],
};

describe("pi-steering import-json: conversion", () => {
  it("stdout mode: writes defineConfig output and exits 0", async () => {
    const path = join(scratch, "steering.json");
    writeFileSync(path, JSON.stringify(VALID_V1), "utf8");

    const r = await runCli("import-json", path);
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim(), "");
    assert.match(
      r.stdout,
      /import \{ defineConfig \} from "@cad0p\/pi-steering"/,
    );
    assert.match(r.stdout, /export default defineConfig\(/);
    assert.match(r.stdout, /"no-secrets"/);
    assert.match(r.stdout, /"Don\'t write outside the project\."/);
    // Preserve the disabled-rules list. Note the rename: v1 JSON's
    // `disable` key becomes v2 TS `disabledRules` on output.
    assert.match(r.stdout, /"disabledRules":\s*\[\s*"no-secrets"\s*\]/);
  });

  it("-o mode: writes file + reports path, exits 0", async () => {
    const inputPath = join(scratch, "steering.json");
    const outputPath = join(scratch, "steering.ts");
    writeFileSync(inputPath, JSON.stringify(VALID_V1), "utf8");

    const r = await runCli("import-json", inputPath, "-o", outputPath);
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`Wrote ${outputPath}`));
    assert.equal(r.stderr.trim(), "");

    const written = readFileSync(outputPath, "utf8");
    assert.match(written, /import \{ defineConfig \}/);
    assert.match(written, /"no-secrets"/);
    // The generated file should be valid enough that a user can
    // drop it in and `tsc --noEmit` it. Sanity check: trailing
    // newline, no BOM.
    assert.ok(written.endsWith("\n"));
    assert.ok(!written.startsWith("\uFEFF"));
  });

  it("--output long form works the same as -o", async () => {
    const inputPath = join(scratch, "steering.json");
    const outputPath = join(scratch, "out.ts");
    writeFileSync(inputPath, JSON.stringify(VALID_V1), "utf8");

    const r = await runCli("import-json", inputPath, "--output", outputPath);
    assert.equal(r.code, 0);
    const written = readFileSync(outputPath, "utf8");
    assert.match(written, /defineConfig/);
  });

  it("FromJSONError propagates as exit 2 with path info", async () => {
    // `plugins` is a v2-only construct; `fromJSON` rejects it.
    const inputPath = join(scratch, "steering.json");
    writeFileSync(
      inputPath,
      JSON.stringify({ plugins: [{ name: "git" }] }),
      "utf8",
    );

    const r = await runCli("import-json", inputPath);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /conversion failed at <root>\.plugins/);
    assert.equal(r.stdout, "");
  });

  it("bash rules fail with the issue #117 migration error (no shim)", async () => {
    const inputPath = join(scratch, "steering.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        rules: [
          {
            name: "no-force-push",
            tool: "bash",
            field: "command",
            pattern: "^git\\\\s+push",
            reason: "no",
          },
        ],
      }),
      "utf8",
    );
    const r = await runCli("import-json", inputPath);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /rewrite the rule in TypeScript as `command:`/);
    assert.equal(r.stdout, "");
  });
});

// ---------------------------------------------------------------------------
// `list` subcommand
// ---------------------------------------------------------------------------

describe("pi-steering list", () => {
  it("prints 'no config' when no .pi/steering exists", async () => {
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /No steering config found\./);
  });

  it("--format=json with no config returns empty structure", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      plugins: unknown[];
      userRules: unknown[];
      disabled: { rules: unknown[] };
    };
    assert.deepEqual(parsed.plugins, []);
    assert.deepEqual(parsed.userRules, []);
    assert.deepEqual(parsed.disabled.rules, []);
  });

  it("text format groups plugin + user rules and lists disables", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{
								name: "no-main-commit",
								tool: "bash",
								command: "git",
								when: { branch: /^main$/ },
								reason: "no",
							},
						],
					},
				],
				rules: [
					{
						name: "my-rule",
						tool: "bash",
						command: "echo",
						reason: "no",
					},
				],
				disabledRules: ["some-disabled-rule"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Resolved config: 1 plugin, 2 rules, 0 observers\./);
    assert.match(r.stdout, /git\s+\[pi-steering\/plugins\/git\]/);
    assert.match(r.stdout, /no-main-commit\s+bash\s+when: branch/);
    assert.match(r.stdout, /User \(project \+ global\):/);
    assert.match(r.stdout, /my-rule\s+bash/);
    assert.match(r.stdout, /Disabled rules: some-disabled-rule/);
  });

  it("loads a config importing a .ts-shipped node_modules plugin without layer-import-failed", async () => {
    // pi-napkin #77 end-to-end symptom at the CLI surface: on main
    // (native type-stripping), a config importing a `.ts`-shipped
    // node_modules plugin is dropped with a `layer-import-failed`
    // warning on stderr and the global/project config silently
    // degrades. The jiti loader must load it clean.
    const pi = join(scratch, ".pi", "steering");
    mkdirSync(pi, { recursive: true });
    const pkgDir = join(scratch, "node_modules", "@cad0p", "fake-plugin");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@cad0p/fake-plugin",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
      "utf8",
    );
    writeFileSync(
      join(pkgDir, "src", "index.ts"),
      'export const fakePlugin = { name: "fake" };\n',
      "utf8",
    );
    writeFileSync(
      join(pi, "index.ts"),
      'import { fakePlugin } from "@cad0p/fake-plugin";\n' +
        "export default { plugins: [fakePlugin] };\n",
      "utf8",
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.ok(
      !r.stderr.includes("layer-import-failed"),
      `expected clean load; stderr: ${r.stderr}`,
    );
    // Unknown plugin names render as a bare name line (no bracket).
    assert.match(r.stdout, /Resolved config: 1 plugin/);
    assert.match(r.stdout, /^fake$/m);
  });

  it("--format=json emits a parseable structure with all sections", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [{ name: "git", rules: [] }],
				rules: [
					{
						name: "u1",
						tool: "bash",
						command: "ls",
						reason: "no",
					},
				],
				observers: [
					{
						name: "obs1",
						writes: ["thing-done"],
						onResult: () => {},
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      plugins: Array<{ name: string; source?: string; rules: unknown[] }>;
      userRules: Array<{ name: string; tool: string }>;
      userObservers: Array<{ name: string; writes: string[] }>;
      disabled: { rules: unknown[]; plugins: unknown[] };
    };
    assert.equal(parsed.plugins[0]?.name, "git");
    assert.equal(parsed.plugins[0]?.source, "pi-steering/plugins/git");
    assert.equal(parsed.userRules[0]?.name, "u1");
    assert.equal(parsed.userObservers[0]?.name, "obs1");
    assert.deepEqual(parsed.userObservers[0]?.writes, ["thing-done"]);
  });

  it("rejects an unknown --format value", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--format=yaml");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown --format value "yaml"/);
  });

  it("rejects unknown flags", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--nope");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag "--nope"/);
  });

  it("list --help prints per-subcommand help", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--help");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /pi-steering list — show the resolved config/);
    assert.match(r.stdout, /--format=text\|json/);
  });

  it("summarizes missing: predicate with its event", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "rq",
						tool: "bash",
						command: "git",
						when: { missing: { event: "tests-passed", in: "agent_loop" } },
						reason: "no",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /when: missing:tests-passed/);
  });

  it("marks disabled rules with '(disabled)' suffix in text output (F4)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "active-rule", tool: "bash", command: "never", reason: "r" },
							{ name: "disabled-rule", tool: "bash", command: "never", reason: "r" },
						],
					},
				],
				disabledRules: ["disabled-rule"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    // Active rule: no suffix.
    assert.match(r.stdout, /active-rule\s+bash\s*$/m);
    // Disabled rule: (disabled) suffix.
    assert.match(r.stdout, /disabled-rule\s+bash\s+\(disabled\)/);
    // Footer unchanged.
    assert.match(r.stdout, /Disabled rules: disabled-rule/);
  });

  it("marks disabled plugins with '(disabled)' suffix on the header (F4)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "some-rule", tool: "bash", command: "never", reason: "r" },
						],
					},
				],
				disabledPlugins: ["git"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    // Plugin header carries the (disabled) suffix.
    assert.match(
      r.stdout,
      /git\s+\[pi-steering\/plugins\/git\]\s+\(disabled\)/,
    );
    assert.match(r.stdout, /Disabled plugins: git/);
  });

  it("JSON output tags disabled rules and plugins with 'disabled: true' (F4)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "active-rule", tool: "bash", command: "never", reason: "r" },
							{ name: "disabled-rule", tool: "bash", command: "never", reason: "r" },
						],
					},
					{ name: "also-disabled" },
				],
				disabledRules: ["disabled-rule"],
				disabledPlugins: ["also-disabled"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      plugins: Array<{
        name: string;
        disabled?: boolean;
        rules: Array<{ name: string; disabled?: boolean }>;
      }>;
    };
    const git = parsed.plugins.find((p) => p.name === "git");
    const also = parsed.plugins.find((p) => p.name === "also-disabled");
    assert.ok(git);
    assert.ok(also);
    assert.equal(
      git.disabled,
      undefined,
      "git plugin is active; no disabled flag",
    );
    assert.equal(
      also.disabled,
      true,
      "also-disabled plugin carries disabled: true",
    );
    const active = git.rules.find((r) => r.name === "active-rule");
    const disabled = git.rules.find((r) => r.name === "disabled-rule");
    assert.ok(active);
    assert.ok(disabled);
    assert.equal(active.disabled, undefined);
    assert.equal(disabled.disabled, true);
  });

  it("text format renders an Exemptions section ONLY when non-empty", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "no-force-push",
						tool: "bash",
						command: "git",
						reason: "no",
					},
				],
				exemptions: [
					{ rule: "no-force-push", when: { cwd: /\\/vault\\// } },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Exemptions:/);
    assert.match(r.stdout, /no-force-push ← config \(when: cwd\)/);
    // No orphan diagnostic: the exemption targets a rule declared in
    // this very config (post-#72 there are no engine-injected rails
    // to lean on).
    assert.equal(r.stderr, "");
  });

  it("text format labels plugin exemptions with the plugin name", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "napkin",
						rules: [
							{
								name: "no-force-push",
								tool: "bash",
								command: "git",
								reason: "no",
							},
						],
						exemptions: [
							{ rule: "no-force-push", when: { cwd: /\\/vault\\// } },
						],
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no-force-push ← napkin \(when: cwd\)/);
  });

  it("JSON output carries an additive exemptions key with source labels", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "napkin",
						rules: [
							{
								name: "no-force-push",
								tool: "bash",
								command: "git",
								reason: "no",
							},
						],
						exemptions: [
							{ rule: "no-force-push", when: { cwd: /\\/vault\\// } },
						],
					},
				],
				rules: [
					{
						name: "no-publish-test",
						tool: "bash",
						command: "npm",
						reason: "no",
					},
				],
				exemptions: [
					{ rule: "no-publish-test", when: { cwd: /\\/tmp\\// } },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      exemptions: Array<{ rule: string; when: string; source: string }>;
    };
    assert.deepEqual(parsed.exemptions, [
      { rule: "no-force-push", when: "cwd", source: "napkin" },
      {
        rule: "no-publish-test",
        when: "cwd",
        source: "config",
      },
    ]);
  });

  it("exemption targeting a disabled-plugin-only rule is NOT flagged orphan (CLI parity)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "napkin",
						rules: [
							{
								name: "no-main-commit",
								tool: "bash",
								command: "git",
								reason: "no",
							},
						],
						exemptions: [
							{ rule: "no-main-commit", when: { cwd: /\\/vault\\// } },
						],
					},
				],
				disabledPlugins: ["napkin"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.equal(
      r.stderr.includes("exemption for rule"),
      false,
      `disabled-plugin-only rule must not be flagged orphan; stderr: ${r.stderr}`,
    );
    // The exemption still renders (the listing shows merged state,
    // disabled or not — mirroring how disabled plugin rules render).
    assert.match(r.stdout, /no-main-commit ← napkin \(when: cwd\)/);
  });

  it("text format omits the Exemptions section entirely when empty (pinned output)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [{ name: "git", rules: [] }],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.equal(r.stdout.includes("Exemptions:"), false);
    // JSON empty shape stays additive + empty.
    const rj = await runCli({ cwd: scratch }, "list", "--format=json");
    const parsed = JSON.parse(rj.stdout) as { exemptions: unknown[] };
    assert.deepEqual(parsed.exemptions, []);
  });
});

// ---------------------------------------------------------------------------
// list: diagnostic surfacing on stderr
// ---------------------------------------------------------------------------

describe("pi-steering list: diagnostics on stderr", () => {
  it("writes a layer-stray-file diagnostic to stderr in the legacy single-line shape", async () => {
    const pi = join(scratch, ".pi", "steering");
    mkdirSync(pi, { recursive: true });
    writeFileSync(join(pi, "rules.json"), "{}", "utf8");
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    // Diagnostic on stderr; stdout shows the empty-config render.
    assert.match(
      r.stderr,
      /\[pi-steering\] .*rules\.json: ignoring non-\.ts file under \.pi\/steering\//,
      `expected stray-file diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("writes a layer-import-failed diagnostic to stderr when a layer fails to import", async () => {
    const pi = join(scratch, ".pi");
    mkdirSync(pi, { recursive: true });
    writeFileSync(
      join(pi, "steering.ts"),
      "export default { rules: {{ not valid ts }} };",
      "utf8",
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(
      r.stderr,
      /\[pi-steering\] .*\.pi\/steering\.ts: failed to import:/,
      `expected layer-import-failed diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("writes an error-class merge diagnostic to stderr with the [error] tag exactly once", async () => {
    writeSteeringDirConfig(
      scratch,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    // Error-class diagnostic → exit 1 so CI pipelines using
    // `pi-steering list` as a config-lint pre-flight gate the run
    // without parsing stderr.
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] tracker name collision/,
      `expected [error]-tagged tracker collision on stderr; got: ${r.stderr}`,
    );
    // The shared merge-pipeline helper short-circuits between
    // buildConfig and resolvePlugins on error-class merge
    // diagnostics, so the same collision should appear exactly once
    // even though both buildConfig and resolvePlugins independently
    // detect tracker-name collisions.
    const occurrences = r.stderr.match(/tracker name collision/g) ?? [];
    assert.equal(
      occurrences.length,
      1,
      `expected exactly one tracker-name-collision line on stderr; got ${occurrences.length}: ${r.stderr}`,
    );
  });

  it("surfaces BOTH a tracker-name-collision AND a malformed user-config rule name on stderr in one run", async () => {
    // Combined-error case: a config with both a merge-side error
    // (tracker-name-collision) AND a user-config-side error
    // (malformed rule name) should produce both diagnostics on
    // stderr in a single `pi-steering list` invocation. Before this change,
    // `runMergerPipeline`'s short-circuit gated
    // `validateUserConfigNames` behind the merge-error branch — the
    // CLI user fixed the tracker, re-ran, and only THEN saw the
    // malformed name. After this change, user-config name validation runs
    // unconditionally so both classes of error surface together,
    // matching the production runtime's aggregated throw.
    writeSteeringDirConfig(
      scratch,
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
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(
      r.code,
      1,
      `expected exit 1 on combined error stream; got: code=${r.code}, stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] tracker name collision/,
      `expected [error]-tagged tracker-name-collision on stderr; got: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] rule name "phony\] BAD" \(user config\).*disallowed/,
      `expected [error]-tagged invalid-name on stderr; got: ${r.stderr}`,
    );
  });

  it("writes an [error]-tagged reserved-tracker-name diagnostic from the plugin merger to stderr", async () => {
    // Reserved-name violations fire only at the plugin-merger surface;
    // without the merger pass in `runList`, a user running
    // `pi-steering list` on a config with a reserved tracker name
    // would see no error, then hit the same violation at session-start build time.
    writeSteeringDirConfig(
      scratch,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "reserved-plugin", trackers: { events: t } },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] tracker name "events" is reserved/,
      `expected reserved-tracker-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("writes an [error]-tagged invalid-name diagnostic from the plugin merger to stderr", async () => {
    // Malformed plugin / rule / observer names flow through the
    // merger's diagnostic stream after the validateName refactor.
    writeSteeringDirConfig(
      scratch,
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
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] rule name "bad name" \(plugin "forge-plugin"\).*disallowed/,
      `expected invalid-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("a clean config produces no diagnostic lines on stderr and exits 0", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "clean-rule",
						tool: "bash",
						command: "never",
						reason: "r",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    const diagnosticLines = r.stderr
      .split("\n")
      .filter((line) => line.startsWith("[pi-steering]"));
    assert.equal(
      diagnosticLines.length,
      0,
      `expected zero diagnostic lines; got: ${JSON.stringify(diagnosticLines)}`,
    );
  });

  it("a warning-only diagnostic stream still exits 0 (warnings are fail-soft on the CLI)", async () => {
    // Warning-class diagnostics like `layer-stray-file` are advisory
    // — they don't prevent production from starting on this config.
    // CI pipelines treating exit 1 as "config rejected" should not
    // trip on warnings; the CLI only escalates exit code on error-
    // class diagnostics.
    const pi = join(scratch, ".pi", "steering");
    mkdirSync(pi, { recursive: true });
    writeFileSync(join(pi, "rules.json"), "{}", "utf8");
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(
      r.stderr,
      /ignoring non-\.ts file/,
      `expected stray-file diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("a plugin-shipped orphan exemption exits 1 with an error-class stderr line", async () => {
    // Severity split at CLI level: a plugin explicitly shipping a
    // carve-out targeting a rule missing from the merged universe is
    // error-class — the full orphan list is printed inline, then the
    // CLI exits 1 (CI-grep audience).
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "napkin",
						exemptions: [
							{ rule: "no-such-rule", when: { cwd: /\\/vault\\// } },
						],
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] exemption for rule "no-such-rule" \(plugin "napkin"\)/,
      `expected plugin-shipped orphan as error-class on stderr; got: ${r.stderr}`,
    );
  });

  it("a config-written orphan exemption stays warning-class: exit 0 + warning line", async () => {
    // Config-written orphans keep the fail-soft path — the CLI prints
    // the warning line but exits 0, mirroring the warning-only stream
    // contract above. Pins the plugin/config severity split end-to-end
    // at CLI level.
    writeSteeringDirConfig(
      scratch,
      `export default {
				exemptions: [
					{ rule: "no-such-rule", when: { cwd: /\\/vault\\// } },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[warning\] exemption for rule "no-such-rule" \(config\)/,
      `expected config-written orphan as warning-class on stderr; got: ${r.stderr}`,
    );
  });

  it("flags a malformed user-config rule name with an invalid-name diagnostic and exits 1", async () => {
    // User-config rule names are validated only at session-start build time
    // (via the evaluator's build-time throw). Without this CLI pass,
    // `pi-steering list` would render the malformed rule as a valid
    // listing on stdout, then production would refuse to start —
    // authors using the CLI as pre-flight would get a false-green.
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "phony] ALL CLEAR [real",
						tool: "bash",
						command: "never",
						reason: "r",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] rule name "phony\] ALL CLEAR \[real" \(user config\).*disallowed/,
      `expected user-config rule invalid-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("flags a malformed user-config observer name with an invalid-name diagnostic and exits 1", async () => {
    // Same shape as the rule-name case but for observers — ensures
    // the CLI's pre-flight surface covers both halves of the
    // `validateUserConfigNames` helper.
    writeSteeringDirConfig(
      scratch,
      `export default {
				observers: [
					{ name: "evil] obs", onResult: () => {} },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] observer name "evil\] obs" \(user config\).*disallowed/,
      `expected user-config observer invalid-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("surfaces an `observer dropped` info-level breadcrumb on stderr when an observer's writes are unconsumed", async () => {
    // CLI mirrors `buildSessionRuntime`'s `dropUnusedObservers` pass
    // so `pi-steering list` surfaces the same breadcrumb a session
    // would, via the `console.info` interception in
    // `runCliMergeWithInfoCapture` (lands on stderr; stdout stays
    // clean for the structured listing).
    writeSteeringDirConfig(
      scratch,
      `export default {
				observers: [
					{
						name: "unread",
						writes: ["never_consumed"],
						onResult: () => {},
					},
				],
				rules: [
					{
						name: "r",
						tool: "bash",
						command: "never",
						reason: "r",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    // Drop pass is informational, not error-class — exit 0.
    assert.equal(
      r.code,
      0,
      `expected exit 0 (info-level breadcrumb only); got code=${r.code}, stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] observer 'unread' dropped; its writes \(never_consumed\) are not consumed by any rule/,
      `expected observer-drop breadcrumb on stderr; got: ${r.stderr}`,
    );
  });

  it("surfaces an `observer dropped` breadcrumb when the consumer rule is disabled via `disabledRules` (parity with runtime)", async () => {
    // CLI must filter `merged.rules` against `disabledRules` before
    // `dropUnusedObservers` so the observer set the runtime would
    // drop at session-start build time matches what `pi-steering list`
    // reports.
    writeSteeringDirConfig(
      scratch,
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
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(
      r.code,
      0,
      `expected exit 0 (info-level breadcrumb only); got code=${r.code}, stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] observer 'obs-x' dropped; its writes \(X\) are not consumed by any rule/,
      `expected observer-drop breadcrumb on stderr (consumer rule was disabled, observer should be reported as dropped to match runtime); got: ${r.stderr}`,
    );
  });

  it("does NOT drop the observer when the consumer rule is enabled (inverse parity)", async () => {
    // Pins the inverse direction so a refactor that flips the
    // filter (`disabledRules.has(r.name)` ↔ `!disabledRules.has`)
    // surfaces here — the disabled-true case alone would not catch
    // it.
    writeSteeringDirConfig(
      scratch,
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
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(
      r.code,
      0,
      `expected exit 0 (clean run); got code=${r.code}, stderr=${r.stderr}`,
    );
    assert.doesNotMatch(
      r.stderr,
      /\[pi-steering\] observer 'obs-x' dropped/,
      `expected NO observer-drop breadcrumb on stderr (consumer rule is enabled, observer is consumed); got: ${r.stderr}`,
    );
  });
});

// ---------------------------------------------------------------------------
// list — project trust gate
// ---------------------------------------------------------------------------

/**
 * Trust-gate fixtures for the CLI's mirrored pi trust formula.
 *
 * NOTE (F3): bin-test scratch dirs are raw `mkdtempSync` (NOT
 * realpath'ed) — trust.json keys must use `realpathSync(scratch)` /
 * `realpathSync(parent)`, never `resolve()`, because the mirror
 * canonicalizes before lookup (pi's write path does the same).
 */
describe("pi-steering list: project trust gate", () => {
  /** Write `<scratch>/.pi/settings.json` — makes the trust store read load-bearing (F3). */
  function writeTrustRequiringResource(): void {
    mkdirSync(join(scratch, ".pi"), { recursive: true });
    writeFileSync(join(scratch, ".pi", "settings.json"), "{}", "utf8");
  }

  /** Steering config with a distinctive rule so its presence in output is observable. */
  function writeProjectSteeringConfig(): void {
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "trusted-project-rule",
						tool: "bash",
						command: "echo",
						reason: "no",
					},
				],
			};`,
    );
  }

  /** Write the child's trust store (`<scratch>/.pi/agent/trust.json` — HOME is scratch). */
  function writeTrustStore(entries: Record<string, true | false | null>): void {
    const dir = join(scratch, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "trust.json"),
      `${JSON.stringify(entries, null, 2)}\n`,
      "utf8",
    );
  }

  it("untrusted dir (no trust entry + trust-requiring resource): project layer skipped, [info] on stderr, JSON false", async () => {
    writeTrustRequiringResource();
    writeProjectSteeringConfig();
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      projectLayerTrusted: boolean;
      userRules: unknown[];
    };
    assert.equal(parsed.projectLayerTrusted, false);
    // Project rules NOT listed (layers empty under the gate).
    assert.deepEqual(parsed.userRules, []);
    assert.ok(
      !r.stdout.includes("trusted-project-rule"),
      `project rule must not appear; stdout: ${r.stdout}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] \[info\] .*\.pi\/steering: project layer skipped/,
      `expected [info] skip line on stderr; got: ${r.stderr}`,
    );
  });

  it("trusted dir (trust.json true + trust-requiring resource): project layer loads, JSON true", async () => {
    writeTrustRequiringResource();
    writeProjectSteeringConfig();
    // The store entry is what flips the decision — the resource is
    // present, so without it the dir would be untrusted.
    writeTrustStore({ [realpathSync(scratch)]: true });
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      projectLayerTrusted: boolean;
      userRules: Array<{ name: string }>;
    };
    assert.equal(parsed.projectLayerTrusted, true);
    assert.equal(parsed.userRules[0]?.name, "trusted-project-rule");
    assert.ok(
      !r.stderr.includes("project layer skipped"),
      `expected no skip line when trusted; stderr: ${r.stderr}`,
    );
  });

  it("trust.json false entry: project layer skipped", async () => {
    writeTrustRequiringResource();
    writeProjectSteeringConfig();
    writeTrustStore({ [realpathSync(scratch)]: false });
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      projectLayerTrusted: boolean;
    };
    assert.equal(parsed.projectLayerTrusted, false);
    assert.ok(
      !r.stdout.includes("trusted-project-rule"),
      `project rule must not appear; stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /\[info\] .*project layer skipped/);
  });

  it("malformed trust.json: stderr note, empty-store semantics → untrusted → skipped (F2)", async () => {
    writeTrustRequiringResource();
    writeProjectSteeringConfig();
    const dir = join(scratch, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trust.json"), "{ not json", "utf8");
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      projectLayerTrusted: boolean;
    };
    // Mirror-faithful: the FORMULA decides on the empty store — with
    // trust-requiring resources present that is UNTRUSTED → skip. The
    // CLI diverges from pi only in not crashing (read-only inspector).
    assert.equal(parsed.projectLayerTrusted, false);
    assert.ok(
      !r.stdout.includes("trusted-project-rule"),
      `project rule must not appear; stdout: ${r.stdout}`,
    );
    assert.match(
      r.stderr,
      /pi-steering: trust store .*(unreadable|malformed); ignoring/,
      `expected unreadable-store note; got: ${r.stderr}`,
    );
    assert.match(r.stderr, /\[info\] .*project layer skipped/);
  });

  it("parent-dir trust entry honored via ancestor walk", async () => {
    writeTrustRequiringResource();
    writeProjectSteeringConfig();
    writeTrustStore({ [realpathSync(dirname(scratch))]: true });
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      projectLayerTrusted: boolean;
      userRules: Array<{ name: string }>;
    };
    assert.equal(parsed.projectLayerTrusted, true);
    assert.equal(parsed.userRules[0]?.name, "trusted-project-rule");
  });

  it("symlinked cwd: trust key is the canonicalized target", async () => {
    // Project dir reached via a symlink; the mirror canonicalizes
    // before the store lookup, so the entry written for the real
    // target decides. (getcwd resolves the symlink, and the mirror's
    // canonicalizePath agrees on the same target.)
    const realDir = join(scratch, "real");
    mkdirSync(join(realDir, ".pi"), { recursive: true });
    writeFileSync(join(realDir, ".pi", "settings.json"), "{}", "utf8");
    writeSteeringDirConfig(
      realDir,
      `export default {
				rules: [
					{
						name: "symlink-rule",
						tool: "bash",
						command: "echo",
						reason: "no",
					},
				],
			};`,
    );
    const link = join(scratch, "link");
    symlinkSync(realDir, link);
    writeTrustStore({ [realpathSync(realDir)]: true });
    const r = await runCli({ cwd: link }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      projectLayerTrusted: boolean;
      userRules: Array<{ name: string }>;
    };
    assert.equal(parsed.projectLayerTrusted, true);
    assert.equal(parsed.userRules[0]?.name, "symlink-rule");
  });
});
