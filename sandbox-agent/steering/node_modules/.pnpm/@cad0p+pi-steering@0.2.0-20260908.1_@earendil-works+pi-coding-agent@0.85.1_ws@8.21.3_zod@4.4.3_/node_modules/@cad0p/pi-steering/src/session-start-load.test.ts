// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Session-start load + lazy-runtime integration tests.
 *
 * Direct unit-level tests for `buildSessionRuntime` live in
 * `internal/session-runtime.test.ts`; the bridge-glue tests
 * (lifecycle wiring, default-rules, agent_loop threading) live in
 * `index.test.ts`. This file covers 21 integration scenarios where
 * the bridge's lazy `session_start` build through
 * `buildSessionRuntime` exercises the strict-mode error surface
 * end-to-end:
 *
 *   - tracker-name-collision error throws even with
 *     `failOnWarnings: false`,
 *   - per-layer import failure escalates,
 *   - predicate / observer / rule plugin-merger collisions
 *     escalate (proves merger warnings are now plumbed),
 *   - `failOnWarnings: false` falls through to `console.warn` for
 *     warning-class only,
 *   - `disabledPlugins` resolves a would-be plugin-name-collision
 *     before the collision check runs,
 *   - `failOnWarnings` undefined coerces to true (default),
 *   - the aggregated diagnostic surfaces on `console.error` AND an
 *     in-chat `ui.notify` (full body, type "error") at session start;
 *     the session runs unsteered (tool_call returns undefined),
 *   - non-aggregate build errors are RETHROWN (engine bugs stay
 *     loud), not notified,
 *   - broken config → unsteered; fix + `/reload`-equivalent re-fires
 *     → steered again,
 *   - per-instance builds anchor on the fired `ctx.cwd`,
 *   - tool_call gates on the built runtime (pre-build undefined;
 *     second session_start no-op; agent_start before build fine),
 *   - deleted `ctx.cwd` loads cleanly (loader existsSync gates).
 *
 * The build is deferred to the first `session_start` on each
 * instance, anchored on the session's `ctx.cwd` — tests write their
 * fixture config under a fresh scratch `$HOME` and fire the session
 * with that cwd; no `chdir` is required anymore.
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
} from "@earendil-works/pi-coding-agent";
import {
  fireSessionStart,
  makeCtx,
  makeNotifyRecorder,
  useScratchHome,
  writeSteeringSingleFileConfig,
} from "./__test-helpers__.ts";
import register from "./index.ts";

/* -------------------------------------------------------------------------- */
/* Mock ExtensionAPI                                                          */
/* -------------------------------------------------------------------------- */

type EventName = "agent_start" | "session_start" | "tool_call" | "tool_result";

interface MockPi {
  api: unknown;
  handlers: Partial<
    Record<EventName, (event: unknown, ctx: unknown) => unknown>
  >;
}

function makeMockPi(): MockPi {
  const handlers: MockPi["handlers"] = {};
  const api = {
    on(event: EventName, handler: (e: unknown, ctx: unknown) => unknown) {
      handlers[event] = handler;
    },
    appendEntry() {},
    async exec() {
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  return { api, handlers };
}

/* -------------------------------------------------------------------------- */
/* Scratch home fixture                                                       */
/* -------------------------------------------------------------------------- */

let tmpHome: string;
function useSessionStartScratchHome(): void {
  useScratchHome("pi-steering-session-start-", (t) => {
    tmpHome = t;
  });
}

/* -------------------------------------------------------------------------- */
/* console.warn / console.error capture                                       */
/* -------------------------------------------------------------------------- */

let capturedWarns: string[];
let priorWarn: typeof console.warn;
function captureWarns(): void {
  beforeEach(() => {
    capturedWarns = [];
    priorWarn = console.warn;
    console.warn = (msg: unknown) => {
      capturedWarns.push(String(msg));
    };
  });
  afterEach(() => {
    console.warn = priorWarn;
  });
}

let capturedErrors: string[];
let priorError: typeof console.error;
function captureErrors(): void {
  beforeEach(() => {
    capturedErrors = [];
    priorError = console.error;
    console.error = (msg: unknown) => {
      capturedErrors.push(String(msg));
    };
  });
  afterEach(() => {
    console.error = priorError;
  });
}

/* -------------------------------------------------------------------------- */
/* Event-firing helpers                                                       */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* session_start error-surface assertion helper                               */
/* -------------------------------------------------------------------------- */

/**
 * Asserts the strict-mode aggregate surface after a failed build.
 *
 * `register()` must already have been called (and `captureErrors()`
 * registered in the enclosing describe). Fires `session_start` with
 * `cwd` and asserts:
 *
 *   - the fired handler RESOLVES (D3: the bridge catches aggregate
 *     throws — the session stays unsteered, the failure surfaces via
 *     `console.error` + `ui.notify`, it does not propagate),
 *   - exactly one `[pi-steering] <aggregated body>` line on
 *     console.error, where `<aggregated body>` matches every regex in
 *     `matchers` (the same matchers the old factory-throw tests wrote
 *     against the thrown `err.message` — the body IS that message),
 *   - an in-chat notify of type "error" carrying the same body.
 *
 * Optional `extraChecks` runs additional assertions against the body
 * (e.g. count matches, structured fields).
 */
async function expectSessionStartThrow(
  mock: MockPi,
  cwd: string,
  matchers: RegExp[],
  extraChecks?: (body: string) => void,
): Promise<void> {
  const notifications = makeNotifyRecorder();
  await fireSessionStart(mock, cwd, "startup", notifications);
  assert.equal(
    notifications.types[0],
    "error",
    `expected a notify of type "error"; got: ${JSON.stringify(notifications.types)}`,
  );
  const errorLine = capturedErrors.find((m) => m.startsWith("[pi-steering] "));
  assert.ok(
    errorLine,
    `expected aggregated diagnostic on console.error; got: ${JSON.stringify(capturedErrors)}`,
  );
  // `assert.ok` above narrows `errorLine` to string — the strict-mode
  // error surface always carries the body, or the assert would have
  // failed already.
  const body = errorLine.slice("[pi-steering] ".length);
  for (const m of matchers) {
    assert.match(body, m);
  }
  assert.equal(
    notifications.messages[0],
    `pi-steering disabled (strict mode): ${body}`,
    "notify must carry the full aggregated body, not a count",
  );
  extraChecks?.(body);
}

/* -------------------------------------------------------------------------- */
/* Session start throws on each diagnostic kind                               */
/* -------------------------------------------------------------------------- */

describe("session_start: throws on diagnostics", () => {
  useSessionStartScratchHome();
  captureWarns();
  captureErrors();

  it("throws on tracker-name-collision (error-class, failOnWarnings default)", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(
      mock,
      tmpHome,
      [/\[error\]/, /tracker name collision/, /"branch"/],
      (body) => {
        // Integration mirror of O2 single-emission lock; see
        // internal/session-runtime.test.ts.
        const collisionMatches = body.match(/tracker name collision/g);
        assert.equal(
          collisionMatches?.length,
          1,
          "tracker-name-collision must appear exactly once",
        );
      },
    );
  });

  it("throws on reserved-tracker-name (error-class)", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "pa", trackers: { events: t } },
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[error\]/,
      /tracker name "events" is reserved/,
    ]);
  });

  it("throws on reserved-predicate-key (error-class)", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				plugins: [
					{
						name: "pa",
						predicates: {
							onUnknown: () => () => true,
						},
					},
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[error\]/,
      /reserved predicate key "onUnknown"/,
    ]);
  });

  it("throws on tracker-name-collision EVEN WITH failOnWarnings: false", async () => {
    // Errors override the opt-out; the engine cannot operate
    // safely with two plugins claiming the same state dimension.
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
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[error\]/,
      /tracker name collision/,
    ]);
  });

  it("throws on plugin-name-collision (warning-class, failOnWarnings default)", async () => {
    // Project and global layers ship the same plugin name. The
    // collision is warning-class but escalates under the default
    // `failOnWarnings: true`.
    const inner = join(tmpHome, "inner");
    mkdirSync(inner, { recursive: true });
    writeSteeringSingleFileConfig(
      inner,
      `export default {
				plugins: [{ name: "shared" }],
			};`,
    );
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "agent", "steering.ts"),
      `export default {
				plugins: [{ name: "shared" }],
			};`,
      "utf8",
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    // cwd flows via the fired ctx — the project layer is `inner`.
    await expectSessionStartThrow(mock, inner, [
      /\[warning\]/,
      /plugin "shared"/,
    ]);
  });

  it("throws on per-layer import failure", async () => {
    mkdirSync(join(tmpHome, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "steering.ts"),
      "export default this is not valid typescript;\n",
      "utf8",
    );
    // Narrow on the actual parse-failure detail so a future loader
    // change that swallows the underlying error message (and leaves
    // only "failed to import") trips this assertion. The loader now
    // evaluates configs via jiti, which emits `ParseError: …` with a
    // code frame for syntax errors; accept `Expected`, `SyntaxError`,
    // or `Unexpected` too.
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[warning\]/,
      /failed to import/i,
      /Expected|SyntaxError|Unexpected|ParseError/i,
    ]);
  });

  it("throws on predicate-collision (proves resolvePlugins warnings are plumbed)", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				plugins: [
					{
						name: "pa",
						predicates: { sharedKey: () => () => true },
					},
					{
						name: "pb",
						predicates: { sharedKey: () => () => true },
					},
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[warning\]/,
      /duplicate predicate "when\.sharedKey"/,
    ]);
  });

  it("throws on observer-collision", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				plugins: [
					{
						name: "pa",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
					{
						name: "pb",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[warning\]/,
      /duplicate observer "obs-x"/,
    ]);
  });

  it("throws on exemption-orphan (warning-class, failOnWarnings default)", async () => {
    // An exemption targeting a rule name absent from the merged
    // universe is warning-class but escalates under the default
    // `failOnWarnings: true` — a typo'd carve-out must not ship
    // silently as a dead exemption.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				exemptions: [
					{ rule: "no-such-rule", when: { cwd: "/vault/" } },
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[warning\]/,
      /exemption for rule "no-such-rule" \(config\)/,
    ]);
  });

  it("exemption-orphan with failOnWarnings: false falls through to console.warn", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				failOnWarnings: false,
				exemptions: [
					{ rule: "no-such-rule", when: { cwd: "/vault/" } },
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);
    const warn = capturedWarns.find((m) =>
      /exemption for rule "no-such-rule"/.test(m),
    );
    assert.ok(
      warn !== undefined,
      `expected exemption-orphan on console.warn, got: ${JSON.stringify(capturedWarns)}`,
    );
  });

  it("throws on plugin-shipped exemption-orphan even with failOnWarnings: false (error-class)", async () => {
    // The severity split: a plugin explicitly shipping a carve-out
    // that targets a rule missing from the merged universe is
    // error-class, so the runtime ALWAYS throws — `failOnWarnings`
    // only softens warning-class diagnostics. The fail-soft
    // console.warn path applies solely to config-written orphans
    // (pinned by the two tests above).
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				failOnWarnings: false,
				plugins: [
					{
						name: "napkin",
						exemptions: [
							{ rule: "no-such-rule", when: { cwd: "/vault/" } },
						],
					},
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[error\]/,
      /exemption for rule "no-such-rule" \(plugin "napkin"\)/,
    ]);
  });

  it("throws on rule-collision", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				plugins: [
					{
						name: "pa",
						rules: [{
							name: "dup",
							tool: "bash",
							command: "never",
							reason: "from pa",
						}],
					},
					{
						name: "pb",
						rules: [{
							name: "dup",
							tool: "bash",
							command: "never",
							reason: "from pb",
						}],
					},
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[warning\]/,
      /duplicate rule "dup"/,
    ]);
  });

  it("throws on inline-user-rule vs plugin-shipped-rule collision", async () => {
    // The cross-bucket variant of the test above: the colliding name
    // comes from the user's inline `rules:` (not another plugin).
    // User rules evaluate first, so the plugin's copy is dropped with
    // a warning-class `rule-collision` diagnostic — this pins that
    // the diagnostic survives aggregation into buildSessionRuntime's
    // warning path at session-start level, not just at unit level.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				rules: [
					{
						name: "dup",
						tool: "bash",
						command: "never",
						reason: "inline user rule",
					},
				],
				plugins: [
					{
						name: "pa",
						rules: [{
							name: "dup",
							tool: "bash",
							command: "never",
							reason: "from pa",
						}],
					},
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [
      /\[warning\]/,
      /rule-collision|duplicate rule "dup" — the user-config rule \(kept\)/,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Session start does NOT throw                                               */
/* -------------------------------------------------------------------------- */

describe("session_start: does NOT throw", () => {
  useSessionStartScratchHome();
  captureWarns();
  captureErrors();

  it("warning-class with failOnWarnings: false falls through to console.warn", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				failOnWarnings: false,
				plugins: [
					{
						name: "pa",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
					{
						name: "pb",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
				],
			};`,
    );
    const mock = makeMockPi();
    // Should resolve without throwing.
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome);
    // At least one captured warn matches the unified single-line
    // shape: `[pi-steering] [warning] <message>`. The aggregated-throw
    // format (with `<count> config issue` header) only renders for
    // thrown errors; this opt-out path goes through console.warn.
    const observerWarn = capturedWarns.find((m) =>
      /\[pi-steering\].*observer.*obs-x/i.test(m),
    );
    assert.ok(
      observerWarn !== undefined,
      `expected observer-collision warn on console.warn; got: ${JSON.stringify(capturedWarns)}`,
    );
    assert.match(observerWarn, /\[warning\]/);
    assert.doesNotMatch(observerWarn, /config issue/);
  });

  it("disabledPlugins resolves plugin-name-collision before the check runs", async () => {
    // The global layer's `disabledPlugins: ["shared"]` removes
    // the would-be collision before cross-layer detection,
    // matching the disable-then-detect ordering. No throw, no
    // warn.
    const inner = join(tmpHome, "inner");
    mkdirSync(inner, { recursive: true });
    writeSteeringSingleFileConfig(
      inner,
      `export default {
				plugins: [{ name: "shared" }],
			};`,
    );
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "agent", "steering.ts"),
      `export default {
				disabledPlugins: ["shared"],
				plugins: [{ name: "shared" }],
			};`,
      "utf8",
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, inner);
    const collisionWarn = capturedWarns.find((m) => /plugin "shared"/i.test(m));
    assert.equal(
      collisionWarn,
      undefined,
      `expected NO plugin-collision warn; got: ${JSON.stringify(capturedWarns)}`,
    );
  });

  it("failOnWarnings undefined coerces to true (default-on)", async () => {
    // No `failOnWarnings` field at all; the runtime treats the
    // absence as `true` and escalates the warning.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				plugins: [
					{
						name: "pa",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
					{
						name: "pb",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
				],
			};`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await expectSessionStartThrow(mock, tmpHome, [/\[warning\]/]);
  });
});

/* -------------------------------------------------------------------------- */
/* Aggregated render snapshot — 1 error + 2 warnings                          */
/* -------------------------------------------------------------------------- */

describe("session_start: aggregated render snapshot", () => {
  useSessionStartScratchHome();
  captureErrors();

  it("renders 1 error + 2 warnings with errors-first ordering and the multi-line shape", async () => {
    // Layout matches the 05-aggregated-render-mixed e2e
    // fixture: plugin-a registers reserved tracker `events`
    // (error), and both plugins ship `obs-x` (warning) + `dup`
    // (warning).
    writeSteeringSingleFileConfig(
      tmpHome,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{
						name: "plugin-a",
						trackers: { events: t },
						observers: [{ name: "obs-x", onResult: () => {} }],
						rules: [{
							name: "dup",
							tool: "bash",
							command: "never",
							reason: "from plugin-a",
						}],
					},
					{
						name: "plugin-b",
						observers: [{ name: "obs-x", onResult: () => {} }],
						rules: [{
							name: "dup",
							tool: "bash",
							command: "never",
							reason: "from plugin-b",
						}],
					},
				],
			};`,
    );
    const notifications = makeNotifyRecorder();
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome, "startup", notifications);

    // The aggregate throw is caught at session_start: the full body
    // lands on console.error (TUI-clobbered surface) AND in the
    // in-chat notification (the visible surface).
    const errorLine = capturedErrors.find((m) =>
      m.startsWith("[pi-steering] "),
    );
    assert.ok(
      errorLine,
      `expected console.error; got: ${JSON.stringify(capturedErrors)}`,
    );
    // `assert.ok` above narrows `errorLine` to string.
    const body = errorLine.slice("[pi-steering] ".length);

    // Header: plural form ("issues"), no leading prefix (pi adds
    // "Failed to load extension: " automatically downstream).
    assert.match(body, /^3 config issues:\n/);

    // Bullet shape: two-space indent, dash, space, severity in
    // brackets, no padding for column alignment.
    const lines = body.split("\n");
    assert.equal(lines.length, 4, `expected header + 3 bullets; got: ${body}`);
    // Indexing with noUncheckedIndexedAccess yields `string | undefined`;
    // the length assert above makes every index valid — narrow through
    // a helper instead of non-null assertions.
    const bullet = (i: number): string => {
      const line = lines[i];
      assert.ok(line !== undefined, `expected bullet at line ${i}`);
      return line;
    };
    // Errors-first ordering: line 1 is the [error] bullet. Tighten
    // to enforce that no path prefix slips between the severity
    // tag and the message text — a future change adding a path
    // prefix to `reserved-tracker-name` would surface here.
    assert.match(
      bullet(1),
      /^ {2}- \[error\] tracker name "events" is reserved/,
    );
    assert.match(bullet(2), /^ {2}- \[warning\] /);
    assert.match(bullet(3), /^ {2}- \[warning\] /);

    // Warnings preserve declaration order from `resolvePlugins`
    // (observer pass before rule pass).
    assert.match(bullet(2), /duplicate observer "obs-x"/);
    assert.match(bullet(3), /duplicate rule "dup"/);

    // No padding (severity tag flush against the next token).
    assert.doesNotMatch(body, /\[error\] {2,}/);
    assert.doesNotMatch(body, /\[warning\] {2,}/);

    // No footer (the message ends at the last bullet).
    assert.equal(bullet(3).startsWith("  - "), true);

    // The in-chat notification carries the FULL body (not a count),
    // prefixed by the disabled banner, with type "error".
    assert.deepEqual(notifications.types, ["error"]);
    assert.equal(notifications.messages.length, 1);
    assert.equal(
      notifications.messages[0],
      `pi-steering disabled (strict mode): ${body}`,
    );

    // Unsteered session: tool_call afterwards returns undefined.
    const result = await fireBashToolCall(mock, "git push --force", tmpHome);
    assert.equal(result, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Notify content pin — full aggregated body in notify + console.error        */
/* -------------------------------------------------------------------------- */

describe("session_start: notify content pin", () => {
  useSessionStartScratchHome();
  captureErrors();

  it("notify carries the FULL aggregated body (not a count); session unsteered", async () => {
    // Warning-class observer-collision with the default
    // `failOnWarnings: true` → aggregate throw at session_start.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				plugins: [
					{
						name: "pa",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
					{
						name: "pb",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
				],
			};`,
    );
    const notifications = makeNotifyRecorder();
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, tmpHome, "startup", notifications);

    // console.error carries the full aggregated body.
    const errorLine = capturedErrors.find((m) =>
      m.startsWith("[pi-steering] "),
    );
    assert.ok(
      errorLine,
      `expected console.error; got: ${JSON.stringify(capturedErrors)}`,
    );
    // `assert.ok` above narrows `errorLine` to string.
    const body = errorLine.slice("[pi-steering] ".length);
    assert.match(
      body,
      /^1 config issue:\n {2}- \[warning\] duplicate observer "obs-x"/,
    );

    // The in-chat notification carries the SAME full body (header +
    // bullets, not a count), type "error".
    assert.deepEqual(notifications.types, ["error"]);
    assert.equal(notifications.messages.length, 1);
    assert.equal(
      notifications.messages[0],
      `pi-steering disabled (strict mode): ${body}`,
    );

    // Unsteered: the failed build left the runtime null.
    const result = await fireBashToolCall(mock, "git push --force", tmpHome);
    assert.equal(result, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Rethrow path — non-aggregate errors stay loud                              */
/* -------------------------------------------------------------------------- */

describe("session_start: rethrow path", () => {
  useSessionStartScratchHome();
  captureErrors();

  it("rethrows non-aggregate build errors (no notify, no console.error swallow)", async () => {
    // The non-aggregate rethrow path is unreachable via real configs
    // (the loader funnels every failure into diagnostics), so the
    // test-only `deps.buildSessionRuntime` seam injects the failure.
    const notifications = makeNotifyRecorder();
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI, {
      buildSessionRuntime: async () => {
        throw new Error("boom");
      },
    });
    const h = mock.handlers.session_start;
    assert.ok(h, "session_start handler not registered");
    // The handler rejects — pi renders it as an `Extension "..." error:`
    // line with the stack. NOT caught, NOT notified, NOT console.error'd.
    await assert.rejects(
      () =>
        h(
          { type: "session_start", reason: "startup" },
          makeCtx(tmpHome, [], notifications),
        ) as Promise<unknown>,
      /boom/,
    );
    assert.equal(notifications.messages.length, 0, "notify must NOT fire");
    assert.equal(capturedErrors.length, 0, "console.error must NOT fire");
  });
});

/* -------------------------------------------------------------------------- */
/* Unsteered → reload recovery (D4)                                           */
/* -------------------------------------------------------------------------- */

describe("session_start: unsteered → reload recovery", () => {
  useSessionStartScratchHome();

  it("broken config → unsteered; fix + /reload-equivalent re-fire → steered", async () => {
    // Instance 1: broken config (exemption-orphan, failOnWarnings
    // default) → aggregate throw at session_start → notify fired,
    // session unsteered.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				exemptions: [{ rule: "no-such-rule", when: { cwd: "/vault/" } }],
			};`,
    );
    const notifications1 = makeNotifyRecorder();
    const mock1 = makeMockPi();
    await register(mock1.api as ExtensionAPI);
    await fireSessionStart(mock1, tmpHome, "startup", notifications1);

    assert.equal(notifications1.types[0], "error");
    assert.match(
      notifications1.messages[0] ?? "",
      /exemption for rule "no-such-rule"/,
    );
    assert.equal(
      await fireBashToolCall(mock1, "git push --force", tmpHome),
      undefined,
      "failed build must leave the session unsteered",
    );

    // Fix the config (declare the git plugin so no-force-push is
    // active post-#72), then simulate `/reload`: a FRESH instance
    // whose session_start fires with reason "reload".
    const gitPluginPath = fileURLToPath(
      new URL("./plugins/git/index.ts", import.meta.url),
    );
    writeSteeringSingleFileConfig(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(gitPluginPath)};
export default { plugins: [gitPlugin] };`,
    );
    const mock2 = makeMockPi();
    await register(mock2.api as ExtensionAPI);
    await fireSessionStart(mock2, tmpHome, "reload");

    const result = await fireBashToolCall(mock2, "git push --force", tmpHome);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no-force-push/);
  });
});

/* -------------------------------------------------------------------------- */
/* Per-cwd rebuild — the anchor is ctx.cwd (D2/D5)                            */
/* -------------------------------------------------------------------------- */

describe("session_start: per-cwd rebuild", () => {
  useSessionStartScratchHome();

  it("each instance builds from its own fired ctx.cwd", async () => {
    const dirA = join(tmpHome, "dirA");
    const dirB = join(tmpHome, "dirB");
    writeSteeringSingleFileConfig(
      dirA,
      `export default {
				plugins: [{ name: "echo-facts", cliDescriptors: { echo: {} } }],
				rules: [{
					name: "no-a-probe",
					tool: "bash",
					command: "echo",
					reason: "blocked by dirA rule",
					when: { subcommand: "A_PROBE" },
				}],
			};`,
    );
    writeSteeringSingleFileConfig(
      dirB,
      `export default {
				plugins: [{ name: "echo-facts", cliDescriptors: { echo: {} } }],
				rules: [{
					name: "no-b-probe",
					tool: "bash",
					command: "echo",
					reason: "blocked by dirB rule",
					when: { subcommand: "B_PROBE" },
				}],
			};`,
    );

    // Instance A anchored on dirA.
    const mockA = makeMockPi();
    await register(mockA.api as ExtensionAPI);
    await fireSessionStart(mockA, dirA);
    const aProbe = await fireBashToolCall(mockA, "echo A_PROBE", dirA);
    assert.equal(aProbe?.block, true);
    assert.match(aProbe?.reason ?? "", /no-a-probe/);
    // dirB's rule must NOT be in instance A's runtime.
    const crossA = await fireBashToolCall(mockA, "echo B_PROBE", dirA);
    assert.equal(crossA, undefined);

    // Instance B anchored on dirB.
    const mockB = makeMockPi();
    await register(mockB.api as ExtensionAPI);
    await fireSessionStart(mockB, dirB);
    const bProbe = await fireBashToolCall(mockB, "echo B_PROBE", dirB);
    assert.equal(bProbe?.block, true);
    assert.match(bProbe?.reason ?? "", /no-b-probe/);
    // dirA's rule must NOT be in instance B's runtime.
    const crossB = await fireBashToolCall(mockB, "echo A_PROBE", dirB);
    assert.equal(crossB, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Pre-build gating (D6)                                                      */
/* -------------------------------------------------------------------------- */

describe("session_start: pre-build gating", () => {
  useSessionStartScratchHome();

  it("tool_call gated on built runtime; second session_start no-op; agent_start before build fine", async () => {
    const gitPluginPath = fileURLToPath(
      new URL("./plugins/git/index.ts", import.meta.url),
    );
    writeSteeringSingleFileConfig(
      tmpHome,
      `import gitPlugin from ${JSON.stringify(gitPluginPath)};
export default { plugins: [gitPlugin] };`,
    );
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);

    // Before any session_start the runtime is unbuilt → tool_call
    // returns undefined (identical to pi's own behavior when an
    // extension fails to load).
    assert.equal(
      await fireBashToolCall(mock, "git push --force", tmpHome),
      undefined,
    );

    // agent_start BEFORE the build must not break routing (the loop
    // counter is threaded independently of the runtime).
    fireAgentStart(mock);

    await fireSessionStart(mock, tmpHome);
    const r1 = await fireBashToolCall(mock, "git push --force", tmpHome);
    assert.equal(r1?.block, true);
    assert.match(r1?.reason ?? "", /no-force-push/);

    // Same-instance second session_start is a no-op (already built) —
    // still steered, no observable double-build side effects.
    await fireSessionStart(mock, tmpHome);
    const r2 = await fireBashToolCall(mock, "git push --force", tmpHome);
    assert.equal(r2?.block, true);
    assert.match(r2?.reason ?? "", /no-force-push/);
  });
});

/* -------------------------------------------------------------------------- */
/* Deleted ctx.cwd edge                                                       */
/* -------------------------------------------------------------------------- */

describe("session_start: deleted ctx.cwd edge", () => {
  useSessionStartScratchHome();
  captureErrors();

  it("deleted ctx.cwd loads cleanly — no throw, no notify; declared rails only", async () => {
    // A session whose directory was deleted: the loader's existsSync
    // gates (loader.ts) make the project + global layer discovery a
    // clean no-op — no config found, no diagnostics, no crash.
    const missing = join(tmpHome, "does-not-exist");
    const notifications = makeNotifyRecorder();
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    await fireSessionStart(mock, missing, "startup", notifications);

    assert.equal(notifications.messages.length, 0, "notify must NOT fire");
    assert.equal(capturedErrors.length, 0, "console.error must NOT fire");

    // No config under the missing cwd → an empty merged config.
    // Post-#72 nothing is engine-injected, so former default rails
    // stay inert; the load itself stays clean either way.
    const result = await fireBashToolCall(mock, "git push --force", missing);
    assert.equal(result, undefined);
  });
});
