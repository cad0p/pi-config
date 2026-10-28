// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * End-to-end exercise of the pi extension wiring in `register()`.
 *
 * Uses an in-memory mock of `ExtensionAPI` that captures `on(...)`
 * handlers and records `appendEntry(...)` + `exec(...)` calls. We then
 * drive the extension by firing lifecycle events in order
 * (`agent_start`, `session_start`, `tool_call`, `tool_result`) and
 * assert on:
 *
 *   - the `tool_call` handler's return value (block / allow),
 *   - the audit-log side effect for accepted overrides,
 *   - the observer-dispatcher side effect on matching tool_result
 *     events,
 *   - the two-layer TS-config loader: {@link buildSessionRuntime}
 *     reads `.pi/steering.ts` from an isolated `$HOME`.
 *
 * The bridge factory's lifecycle wiring + config-loading glue isn't
 * covered by the unit suites; this file is the only end-to-end check.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  fireSessionStart,
  makeCtx,
  useScratchHome,
  writeSteeringSingleFileConfig,
} from "./__test-helpers__.ts";
import register from "./index.ts";

/* -------------------------------------------------------------------------- */
/* Mock ExtensionAPI                                                          */
/* -------------------------------------------------------------------------- */

type EventName = "agent_start" | "session_start" | "tool_call" | "tool_result";

interface Entry {
  kind: string;
  data: unknown;
}

/**
 * In-memory mock of pi's ExtensionAPI. Only implements the surface the
 * steering extension actually consumes:
 *   - `on()` captures handlers keyed by event name.
 *   - `exec()` + `appendEntry()` are recorded for assertion.
 *
 * Everything else throws if touched so accidental reliance on
 * unsupported API surfaces breaks loudly.
 */
interface MockPi {
  api: unknown; // cast at call site to ExtensionAPI
  handlers: Partial<
    Record<EventName, (event: unknown, ctx: unknown) => unknown>
  >;
  entries: Entry[];
  execCalls: Array<{ cmd: string; args: string[] }>;
}

function makeMockPi(): MockPi {
  const handlers: MockPi["handlers"] = {};
  const entries: Entry[] = [];
  const execCalls: MockPi["execCalls"] = [];
  const api = {
    on(event: EventName, handler: (e: unknown, ctx: unknown) => unknown) {
      handlers[event] = handler;
    },
    appendEntry(kind: string, data: unknown) {
      entries.push({ kind, data });
    },
    async exec(cmd: string, args: string[]) {
      execCalls.push({ cmd, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  return { api, handlers, entries, execCalls };
}

function fireAgentStart(mock: MockPi): void {
  const h = mock.handlers.agent_start;
  if (!h) throw new Error("agent_start handler not registered");
  h({ type: "agent_start" }, {});
}

async function fireBashToolCall(
  mock: MockPi,
  command: string,
  cwd: string,
): Promise<ToolCallEventResult | undefined> {
  const h = mock.handlers.tool_call;
  if (!h) throw new Error("tool_call handler not registered");
  const event: ToolCallEvent = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-1",
    input: { command },
  };
  const r = await h(event, makeCtx(cwd));
  return r as ToolCallEventResult | undefined;
}

async function fireWriteToolCall(
  mock: MockPi,
  path: string,
  content: string,
  cwd: string,
): Promise<ToolCallEventResult | undefined> {
  const h = mock.handlers.tool_call;
  if (!h) throw new Error("tool_call handler not registered");
  const event: ToolCallEvent = {
    type: "tool_call",
    toolName: "write",
    toolCallId: "call-2",
    input: { path, content },
  };
  const r = await h(event, makeCtx(cwd));
  return r as ToolCallEventResult | undefined;
}

async function fireEditToolCall(
  mock: MockPi,
  path: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
  cwd: string,
): Promise<ToolCallEventResult | undefined> {
  const h = mock.handlers.tool_call;
  if (!h) throw new Error("tool_call handler not registered");
  const event: ToolCallEvent = {
    type: "tool_call",
    toolName: "edit",
    toolCallId: "call-3",
    input: { path, edits: [...edits] },
  };
  const r = await h(event, makeCtx(cwd));
  return r as ToolCallEventResult | undefined;
}

async function fireBashToolResult(
  mock: MockPi,
  input: Record<string, unknown>,
  exitCode: number,
  cwd: string,
): Promise<void> {
  const h = mock.handlers.tool_result;
  if (!h) throw new Error("tool_result handler not registered");
  const event = {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "bash",
    input,
    content: [],
    isError: exitCode !== 0,
    details: { exitCode },
  } as unknown as ToolResultEvent;
  await h(event, makeCtx(cwd));
}

/* -------------------------------------------------------------------------- */
/* Test harness: isolated $HOME per test                                      */
/* -------------------------------------------------------------------------- */

let tmpHome: string;

/**
 * Bind a fresh `$HOME` per test AND chdir into it via the shared
 * {@link useScratchHome} helper. The runtime builds from `ctx.cwd` at
 * `session_start` — the bridge no longer reads `process.cwd()` at
 * register time — so tests fire the session with `tmpHome` as the
 * cwd; the chdir is kept for parity, not required.
 */
function useRegisterScratchHome(): void {
  useScratchHome("pi-steering-register-", (t) => {
    tmpHome = t;
  });
}

/**
 * Write a TS config file at `.pi/steering.ts` under `dir`. Body is the
 * default-exported object literal body (without the `export default`
 * wrapper) so call sites read as declarative configs.
 */
function writeSteeringConfig(dir: string, body: string): void {
  writeSteeringSingleFileConfig(
    dir,
    `// Generated by index.test.ts\nexport default ${body};\n`,
  );
}

/**
 * Absolute source paths of the shipped plugins, baked into generated
 * config fixtures via plain ESM specifiers. Post-#72 there are no
 * engine-injected defaults, so fixtures that want a rail active must
 * DECLARE its shipping plugin — and a temp-dir config can't resolve
 * bare package names, hence the absolute source paths (jiti loads
 * .ts natively).
 */
const GIT_PLUGIN_PATH = fileURLToPath(
  new URL("./plugins/git/index.ts", import.meta.url),
);
const RM_PLUGIN_PATH = fileURLToPath(
  new URL("./plugins/rm/index.ts", import.meta.url),
);

/**
 * Write a TS config module that imports the shipped plugins and
 * default-exports `body` (an object literal referencing them).
 */
function writeSteeringConfigWithPlugins(
  dir: string,
  imports: string,
  body: string,
): void {
  writeSteeringSingleFileConfig(
    dir,
    `// Generated by index.test.ts\n${imports}\nexport default ${body};\n`,
  );
}

/* -------------------------------------------------------------------------- */
/* session-start-load + tool_call with default rules */
/* -------------------------------------------------------------------------- */

describe("register(): default rules wiring", () => {
  useRegisterScratchHome();

  beforeEach(() => {
    // Post-#72 the rails ship with plugins: declare them the way a
    // real config would so the wiring tests keep exercising them.
    writeSteeringConfigWithPlugins(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(GIT_PLUGIN_PATH)};
import rmPlugin from ${JSON.stringify(RM_PLUGIN_PATH)};`,
      "{ plugins: [gitPlugin, rmPlugin] }",
    );
  });

  it("blocks `git push --force` via declared plugin rule", async () => {
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(mock, "git push --force", tmpHome);
    assert.ok(result, "expected a ToolCallEventResult");
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-force-push/);
  });

  it("blocks `git push --force-with-lease` (sealed rule, #65)", async () => {
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "git push --force-with-lease",
      tmpHome,
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-force-push/);
  });

  it("blocks `git push --force` behind `sh -c` wrapper", async () => {
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "sh -c 'git push --force'",
      tmpHome,
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-force-push/);
  });

  it("blocks `git -C /other/dir push --force` (pre-subcommand flag bypass)", async () => {
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "git -C /other/dir push --force",
      tmpHome,
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-force-push/);
  });

  it("does NOT block `echo 'git push --force'` (echo args are not AST-extracted)", async () => {
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "echo 'git push --force'",
      tmpHome,
    );
    assert.equal(result, undefined);
  });

  it("blocks `rm -rf /` and ignores override (noOverride: true)", async () => {
    // rm plugin declared in this describe's beforeEach config.
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "rm -rf / # steering-override: no-rm-rf-slash — test override",
      tmpHome,
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-rm-rf-slash/);
    // noOverride rules must NOT append an audit entry.
    assert.equal(mock.entries.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Override escape hatch + audit log                                          */
/* -------------------------------------------------------------------------- */

describe("register(): inline override escape hatch", () => {
  useRegisterScratchHome();

  function writeOverridableGitConfig(): void {
    writeSteeringConfigWithPlugins(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(GIT_PLUGIN_PATH)};`,
      "{ plugins: [gitPlugin], defaultNoOverride: false }",
    );
  }

  it("accepts override comment, does not block, appends audit entry", async () => {
    // The v2 default is `defaultNoOverride: true` (fail-closed per
    // ADR). Users who want overridable rules must opt in explicitly —
    // the config here flips the default back to false so the shipped
    // no-force-push rule becomes overridable.
    writeOverridableGitConfig();

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "git push --force # steering-override: no-force-push — coordinated revert",
      tmpHome,
    );
    assert.equal(result, undefined, "accepted override should not block");

    assert.equal(mock.entries.length, 1);
    const entry = mock.entries[0];
    assert.equal(entry?.kind, "steering-override");
    const data = entry?.data as {
      rule: string;
      reason: string;
      command: string;
      timestamp: string;
    };
    assert.equal(data.rule, "no-force-push");
    assert.equal(data.reason, "coordinated revert");
    assert.match(data.command, /git push --force/);
    assert.match(data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("override targeted at a different rule does NOT suppress the block", async () => {
    writeOverridableGitConfig();

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "git push --force # steering-override: some-other-rule — unrelated",
      tmpHome,
    );
    assert.equal(result?.block, true);
    assert.equal(mock.entries.length, 0);
  });

  it("v2 default (fail-closed) blocks override attempts on shipped rules", async () => {
    // Git plugin declared WITHOUT a defaultNoOverride flip → the
    // fail-closed default (`true`) holds. The override comment is
    // ignored and the block fires.
    writeSteeringConfigWithPlugins(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(GIT_PLUGIN_PATH)};`,
      "{ plugins: [gitPlugin] }",
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(
      mock,
      "git push --force # steering-override: no-force-push — hotfix",
      tmpHome,
    );
    assert.equal(result?.block, true);
    // The block reason should NOT include "To override" — rule is
    // non-overridable under fail-closed default.
    assert.doesNotMatch(result?.reason ?? "", /To override/);
    assert.equal(mock.entries.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* User-defined rules via .pi/steering.ts                                     */
/* -------------------------------------------------------------------------- */

describe("register(): user-defined rules via .pi/steering.ts", () => {
  useRegisterScratchHome();

  it("blocks a write to a .env file via a user-defined write rule", async () => {
    writeSteeringConfig(
      tmpHome,
      `{
				rules: [
					{
						name: "no-env-files",
						tool: "write",
						field: "path",
						pattern: /(^|\\/)\\.env(\\.|$)/,
						reason: "never write .env files — contains secrets",
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireWriteToolCall(
      mock,
      join(tmpHome, "project", ".env"),
      "SECRET_KEY=abc",
      tmpHome,
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-env-files/);
  });

  it("blocks an edit that inserts a debugger statement (content rule)", async () => {
    writeSteeringConfig(
      tmpHome,
      `{
				rules: [
					{
						name: "no-debugger",
						tool: "edit",
						field: "content",
						pattern: /\\bdebugger\\b/,
						reason: "don't commit debugger statements",
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireEditToolCall(
      mock,
      join(tmpHome, "project", "a.ts"),
      [{ oldText: "const x = 1;", newText: "const x = 1;\ndebugger;" }],
      tmpHome,
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-debugger/);
  });

  it("when.cwd gates whether the rule fires", async () => {
    writeSteeringConfigWithPlugins(
      tmpHome,
      "",
      `{
				plugins: [{ name: "test-strict", cliDescriptors: { echo: {} } }],
				rules: [
					{
						name: "no-echo-in-special",
						tool: "bash",
						command: "echo",
						reason: "echo not allowed in special tree",
						when: { cwd: /\\/special\\// },
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    // cwd does not match → should NOT block.
    assert.equal(
      await fireBashToolCall(mock, "echo hi", "/home/me/normal"),
      undefined,
    );

    // cwd matches → should block.
    const blocked = await fireBashToolCall(
      mock,
      "echo hi",
      "/home/me/special/sub",
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /no-echo-in-special/);
  });

  it("disabledRules removes a declared plugin's rule", async () => {
    writeSteeringConfigWithPlugins(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(GIT_PLUGIN_PATH)};`,
      "{ plugins: [gitPlugin], disabledRules: ['no-force-push'] }",
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    // Rule disabled → push --force no longer blocked.
    assert.equal(
      await fireBashToolCall(mock, "git push --force", tmpHome),
      undefined,
    );
  });

  it("no plugin declared → former default rails stay inert (issue #72)", async () => {
    // Post-cut there are NO engine-injected rails: without declaring
    // git/rm/async, none of the former defaults block — including the
    // noOverride no-rm-rf-slash.
    writeSteeringConfig(tmpHome, "{}");

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    assert.equal(
      await fireBashToolCall(mock, "git push --force", tmpHome),
      undefined,
    );
    assert.equal(await fireBashToolCall(mock, "rm -rf /", tmpHome), undefined);
  });

  it("declaring a plugin re-arms its rails end-to-end", async () => {
    writeSteeringConfigWithPlugins(
      tmpHome,
      `import rmPlugin from ${JSON.stringify(RM_PLUGIN_PATH)};`,
      "{ plugins: [rmPlugin] }",
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(mock, "rm -rf /", tmpHome);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-rm-rf-slash/);
  });
});

/* -------------------------------------------------------------------------- */
/* Observer wiring via tool_result                                            */
/* -------------------------------------------------------------------------- */

describe("register(): observer dispatcher wiring", () => {
  useRegisterScratchHome();

  it("runs observers on matching tool_result events", async () => {
    // Use a module-scoped sentinel so the dynamically-imported config
    // can signal the test. The loader uses `await import(url)` with a
    // file:// URL; we bake the assertion hook directly into the
    // observer's onResult via a global counter.
    writeSteeringConfig(
      tmpHome,
      `{
				observers: [
					{
						name: "count-bash-success",
						watch: { toolName: "bash", exitCode: "success" },
						onResult: (event, ctx) => {
							ctx.appendEntry("bash-success", { cmd: (event.input as {command: string}).command });
						},
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    await fireBashToolResult(mock, { command: "echo hi" }, 0, tmpHome);

    const recorded = mock.entries.find((e) => e.kind === "bash-success");
    assert.ok(recorded, "observer should have written an entry");
    // The engine auto-injects `_agentLoopIndex` into every observer/
    // predicate write so `when.missing: { in: "agent_loop" }` can
    // filter by scope. First agent_start happens implicitly at
    // session setup time — agentLoopIndex here is 0 because no
    // agent_start events have fired in this test.
    assert.deepEqual(recorded.data, {
      cmd: "echo hi",
      _agentLoopIndex: 0,
    });
  });

  it("observer watch filter gates firing (failure exit code excluded)", async () => {
    writeSteeringConfig(
      tmpHome,
      `{
				observers: [
					{
						name: "count-bash-success",
						watch: { toolName: "bash", exitCode: "success" },
						onResult: (_event, ctx) => {
							ctx.appendEntry("bash-success");
						},
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    await fireBashToolResult(
      mock,
      { command: "exit 1" },
      1, // failure
      tmpHome,
    );

    assert.equal(
      mock.entries.find((e) => e.kind === "bash-success"),
      undefined,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Non-targeted tool calls pass through                                       */
/* -------------------------------------------------------------------------- */

describe("register(): unrelated tool calls pass through", () => {
  useRegisterScratchHome();

  it("returns undefined for a tool call that matches no rule", async () => {
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const result = await fireBashToolCall(mock, "ls -la", tmpHome);
    assert.equal(result, undefined);
  });

  it("returns undefined for a `read` tool call (not in any rule's tool set)", async () => {
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const h = mock.handlers.tool_call;
    assert.ok(h);
    const event = {
      type: "tool_call",
      toolName: "read",
      toolCallId: "call-read",
      input: { path: "/etc/passwd" },
    };
    const result = await h(event, makeCtx(tmpHome));
    assert.equal(result, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Agent-loop index threading                                                 */
/* -------------------------------------------------------------------------- */

describe("register(): agent_start bumps agentLoopIndex threaded into evaluator", () => {
  useRegisterScratchHome();

  it("passes the current agentLoopIndex into predicate context", async () => {
    // Rule uses when.condition to assert agentLoopIndex threading.
    // The condition appends an audit entry the test consults to
    // confirm the agentLoopIndex the evaluator saw.
    writeSteeringConfigWithPlugins(
      tmpHome,
      "",
      `{
				plugins: [{ name: "test-strict", cliDescriptors: { echo: {} } }],
				rules: [
					{
						name: "capture-turn",
						tool: "bash",
						command: "echo",
						reason: "capture",
						when: {
							condition: (ctx) => {
								ctx.appendEntry("captured", { agentLoopIndex: ctx.agentLoopIndex });
								return false; // never fires; only side effect matters
							},
						},
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    // Each agent_start bumps the engine's internal counter by 1.
    // Fire 5 times so the first tool_call sees agentLoopIndex === 5.
    fireAgentStart(mock);
    fireAgentStart(mock);
    fireAgentStart(mock);
    fireAgentStart(mock);
    fireAgentStart(mock);
    await fireBashToolCall(mock, "echo hi", tmpHome);

    const captured = mock.entries.find((e) => e.kind === "captured");
    assert.ok(captured);
    assert.deepEqual(
      (captured.data as { agentLoopIndex: number }).agentLoopIndex,
      5,
    );
  });

  it("tool_call fired before any agent_start sees agentLoopIndex === 0", async () => {
    // Pins the counter's initial value. The counter bumps from 0 to 1
    // on the first agent_start; a tool_call that happens BEFORE any
    // agent_start (background tool, prompt autocompletion, extension
    // smoke test) must see a well-defined — not undefined / NaN /
    // -1 — agentLoopIndex. A later init-bug landing on undefined
    // would pass all other tests but fail this one.
    writeSteeringConfigWithPlugins(
      tmpHome,
      "",
      `{
				plugins: [{ name: "test-strict", cliDescriptors: { echo: {} } }],
				rules: [
					{
						name: "capture-pre-agent-start",
						tool: "bash",
						command: "echo",
						reason: "capture",
						when: {
							condition: (ctx) => {
								ctx.appendEntry("captured", { agentLoopIndex: ctx.agentLoopIndex });
								return false;
							},
						},
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);
    // Intentionally skip fireAgentStart.
    await fireBashToolCall(mock, "echo hi", tmpHome);

    const captured = mock.entries.find((e) => e.kind === "captured");
    assert.ok(captured);
    assert.equal(
      (captured.data as { agentLoopIndex: number }).agentLoopIndex,
      0,
    );
  });

  it("tool_call + tool_result in the same loop share the same agentLoopIndex", async () => {
    // The predicate captures the agentLoopIndex it sees; the
    // observer's auto-tagged write records the loop index the
    // dispatcher saw. Both must agree, end-to-end via register().
    writeSteeringConfigWithPlugins(
      tmpHome,
      "",
      `{
				plugins: [{ name: "test-strict", cliDescriptors: { echo: {} } }],
				rules: [
					{
						name: "capture-predicate",
						tool: "bash",
						command: "echo",
						reason: "r",
						when: {
							condition: (ctx) => {
								ctx.appendEntry("pred", { agentLoopIndex: ctx.agentLoopIndex });
								return false;
							},
						},
					},
				],
				observers: [
					{
						name: "capture-observer",
						watch: { toolName: "bash", exitCode: "success" },
						onResult: (_event, ctx) => {
							ctx.appendEntry("obs", { ok: true });
						},
					},
				],
			}`,
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);
    fireAgentStart(mock); // loop 1
    fireAgentStart(mock); // loop 2
    await fireBashToolCall(mock, "echo hi", tmpHome);
    await fireBashToolResult(mock, { command: "echo hi" }, 0, tmpHome);

    const pred = mock.entries.find((e) => e.kind === "pred");
    const obs = mock.entries.find((e) => e.kind === "obs");
    assert.ok(pred, "predicate should have captured a pred entry");
    assert.ok(obs, "observer should have captured an obs entry");
    const predIdx = (pred.data as { agentLoopIndex: number }).agentLoopIndex;
    const obsIdx = (obs.data as { _agentLoopIndex: number })._agentLoopIndex;
    assert.equal(predIdx, 2);
    assert.equal(obsIdx, 2);
    assert.equal(
      predIdx,
      obsIdx,
      "predicate and observer must observe the same agent_loop index",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* register() coverage — explicit plugin declarations post-#72                */
/*                                                                            */
/* There is no engine-injected defaults pass anymore: whatever blocks  */
/* must come from a declared plugin or an inline rule.                  */
/* -------------------------------------------------------------------------- */

describe("register(): explicit plugin declarations (post-defaults)", () => {
  useRegisterScratchHome();

  it("declared git + rm plugins block their rails", async () => {
    writeSteeringConfigWithPlugins(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(GIT_PLUGIN_PATH)};
import rmPlugin from ${JSON.stringify(RM_PLUGIN_PATH)};`,
      "{ plugins: [gitPlugin, rmPlugin] }",
    );

    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    const pushResult = await fireBashToolCall(
      mock,
      "git push --force",
      tmpHome,
    );
    assert.equal(pushResult?.block, true);
    assert.match(pushResult?.reason ?? "", /no-force-push/);

    const rmResult = await fireBashToolCall(mock, "rm -rf /", tmpHome);
    assert.equal(rmResult?.block, true);
    assert.match(rmResult?.reason ?? "", /no-rm-rf-slash/);
  });

  it("`disabledRules` filters a declared plugin's rule out of the merged config", async () => {
    writeSteeringConfigWithPlugins(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(GIT_PLUGIN_PATH)};
import rmPlugin from ${JSON.stringify(RM_PLUGIN_PATH)};`,
      "{ plugins: [gitPlugin, rmPlugin], disabledRules: ['no-force-push'] }",
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);

    // `no-force-push` is disabled — gone.
    const pushResult = await fireBashToolCall(
      mock,
      "git push --force",
      tmpHome,
    );
    assert.equal(pushResult, undefined);

    // Other declared rails still present.
    const rmResult = await fireBashToolCall(mock, "rm -rf /", tmpHome);
    assert.equal(rmResult?.block, true);
  });
});

/* -------------------------------------------------------------------------- */
/* project-trust gate — bridge three-way (false / true / absent)              */
/* -------------------------------------------------------------------------- */

describe("register(): project-trust gate", () => {
  let infos: string[];
  let origInfo: typeof console.info;
  useRegisterScratchHome();

  beforeEach(() => {
    infos = [];
    origInfo = console.info;
    console.info = (msg: unknown) => {
      infos.push(String(msg));
    };
  });
  afterEach(() => {
    console.info = origInfo;
  });

  /** Distinct project + global blocking rules so each layer's fate is observable. */
  function writeGateFixture(): void {
    writeSteeringConfig(
      tmpHome,
      `{
				rules: [
					{
						name: "no-proj-echo",
						tool: "bash",
						command: "echo",
						reason: "project rule",
						when: { subcommand: "proj" },
					},
				],
			}`,
    );
    // Global layer at `<agentDir>/steering/index.ts` — write directly
    // (writeSteeringDirConfig would nest under `<dir>/.pi/steering`).
    const globalDir = join(tmpHome, ".pi", "agent", "steering");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "index.ts"),
      `export default {
				plugins: [{ name: "glob-facts", cliDescriptors: { echo: {} } }],
				rules: [
					{
						name: "no-glob-echo",
						tool: "bash",
						command: "echo",
						reason: "global rule",
						when: { subcommand: "glob" },
					},
				],
			};`,
      "utf8",
    );
  }

  it("isProjectTrusted → false: project rule skipped, global steers, breadcrumb, no crash", async () => {
    writeGateFixture();
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome, "startup", undefined, false);

    // Project-layer rule must NOT fire.
    const proj = await fireBashToolCall(mock, "echo proj", tmpHome);
    assert.equal(proj, undefined);
    // Global-layer rule still steers.
    const glob = await fireBashToolCall(mock, "echo glob", tmpHome);
    assert.equal(glob?.block, true);
    assert.match(glob?.reason ?? "", /no-glob-echo/);
    // Info breadcrumb emitted exactly once, single-line shape.
    assert.equal(
      infos.filter((m) => m.includes("project layer skipped")).length,
      1,
      `expected one skip breadcrumb; got: ${JSON.stringify(infos)}`,
    );
  });

  it("isProjectTrusted → true: project layer loads (rule fires)", async () => {
    writeGateFixture();
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome, "startup", undefined, true);

    const proj = await fireBashToolCall(mock, "echo proj", tmpHome);
    assert.equal(proj?.block, true);
    assert.match(proj?.reason ?? "", /no-proj-echo/);
    assert.equal(infos.length, 0, "no breadcrumb when trusted");
  });

  it("method absent: gate inert, project layer loads + inertness breadcrumb", async () => {
    writeGateFixture();
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    // No projectTrusted arg → makeCtx leaves isProjectTrusted off.
    await fireSessionStart(mock, tmpHome);

    const proj = await fireBashToolCall(mock, "echo proj", tmpHome);
    assert.equal(proj?.block, true);
    assert.match(proj?.reason ?? "", /no-proj-echo/);
    // The inert fallback must be observable, not silent (old pi).
    assert.equal(
      infos.filter((m) => m.includes("trust gate inert")).length,
      1,
      `expected one inertness breadcrumb; got: ${JSON.stringify(infos)}`,
    );
  });
});
