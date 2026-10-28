// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared test-double helpers.
 *
 * `evaluator.test.ts` and `observer-dispatcher.test.ts` both need:
 *
 *   - a minimal {@link ExtensionContext} stub whose `sessionManager`
 *     only exposes `getEntries()` (everything else throws on access),
 *   - a "tracked host" {@link EvaluatorHost} that records every
 *     `exec` / `appendEntry` call plus pushes `appendEntry` payloads
 *     into an entries array shaped like the pi session JSONL, so the
 *     same array can back a `makeCtx` stub and let tests assert
 *     cross-handler `findEntries` visibility.
 *
 * The two former copies diverged only in whether `makeHost` accepted an
 * `exec` override (evaluator tests need it to count child-process
 * invocations for the memoization assertions; observer tests don't).
 * That's now a single option on the unified helper.
 *
 * Kept OUT of the public surface: `__test-helpers__` is a leading-double-
 * underscore convention indicating "test only"; nothing under `src/`
 * imports it at runtime.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import type {
  ExtensionContext,
  ExecResult as PiExecResult,
} from "@earendil-works/pi-coding-agent";
import type { EvaluatorHost } from "./evaluator-internals/context.ts";

// ---------------------------------------------------------------------------
// Isolated $HOME fixture
// ---------------------------------------------------------------------------

/**
 * Per-test scratch `$HOME` fixture. Registers `beforeEach` /
 * `afterEach` that:
 *
 *   - `mkdtempSync` a fresh temp dir using `prefix`,
 *   - save `process.env["HOME"]`, point it at the temp dir,
 *   - restore `process.env["HOME"]` and recursively remove the temp
 *     dir on teardown.
 *
 * Used by every test surface that exercises the loader's two-layer
 * discovery (`index.test.ts`, `loader.test.ts`,
 * `internal/session-runtime.test.ts`) so the per-file scratch-HOME
 * boilerplate stays in one place.
 *
 * The temp dir path is exposed via the optional `onReady` callback,
 * fired inside `beforeEach`; tests typically stash it in a
 * describe-scoped `let` for terser reads.
 */
export function useIsolatedHome(
  prefix: string,
  onReady?: (tmp: string) => void,
): void {
  let tmp: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), prefix));
    priorHome = process.env.HOME;
    process.env.HOME = tmp;
    onReady?.(tmp);
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(tmp, { recursive: true, force: true });
  });
}

/**
 * Like {@link useIsolatedHome} but also chdirs into the scratch dir.
 * The bridge no longer reads `process.cwd()` — the runtime builds
 * from `ctx.cwd` at `session_start` and the loader takes cwd as a
 * parameter — so the chdir is now unnecessary-but-harmless (kept for
 * parity with the old eager-factory tests). `realpathSync` keeps the
 * canonicalized path stable across macOS tmpdir symlinks.
 */
export function useScratchHome(
  prefix: string,
  onReady?: (tmp: string) => void,
): void {
  let tmp: string;
  let priorHome: string | undefined;
  let priorCwd: string;
  beforeEach(() => {
    priorCwd = process.cwd();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    priorHome = process.env.HOME;
    process.env.HOME = tmp;
    process.chdir(tmp);
    onReady?.(tmp);
  });
  afterEach(() => {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(tmp, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// Steering-config fixture writers
// ---------------------------------------------------------------------------

/**
 * Write a single-file steering config to `<dir>/.pi/steering.ts`.
 * `body` is the full module source (must include `export default`).
 * Used by suites whose fixtures embed regex literals or other
 * non-JSON-friendly module shapes inline.
 */
export function writeSteeringSingleFileConfig(dir: string, body: string): void {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "steering.ts"), body, "utf8");
}

/**
 * Write a directory-form steering config to
 * `<dir>/.pi/steering/index.ts`. `body` is the full module source
 * (must include `export default`). Mirrors the layout the bin tests
 * use for their isolated `@cad0p/pi-steering` invocations.
 */
export function writeSteeringDirConfig(dir: string, body: string): void {
  const pi = join(dir, ".pi", "steering");
  mkdirSync(pi, { recursive: true });
  writeFileSync(join(pi, "index.ts"), body, "utf8");
}

// ---------------------------------------------------------------------------
// Session-entry shape
// ---------------------------------------------------------------------------

/**
 * Exact shape pi's `sessionManager.getEntries()` returns for entries
 * produced by `appendEntry`. The evaluator filters to `type: "custom"`,
 * matches by `customType`, and reads `{ data, timestamp }` — other
 * fields (`id`, `parentId`) exist on real entries so we mirror them
 * here to avoid silent type drift.
 */
export interface CustomEntry {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
  readonly timestamp: string;
  readonly id: string;
  readonly parentId: string | null;
}

// ---------------------------------------------------------------------------
// ExtensionContext stub
// ---------------------------------------------------------------------------

/**
 * Minimal stub for pi's `ExtensionContext`. Only the fields the
 * evaluator + observer-dispatcher read are populated; everything else
 * throws if touched so accidental reliance on unsupported surface
 * breaks loudly.
 *
 * The `entries` array mimics `sessionManager.getEntries()` output —
 * tests that want cross-handler `findEntries` visibility pass
 * `host.entries` (from {@link makeTrackedHost}) here so the host's
 * `appendEntry` writes show up on subsequent reads.
 *
 * Optional `projectTrusted`: when provided, `isProjectTrusted()` is
 * attached returning that value (drives the bridge's project-layer
 * trust gate); when absent the method is absent, so the bridge's
 * `ctx.isProjectTrusted?.() ?? true` fallback path (gate inert) is
 * exercised.
 */
export function makeCtx(
  cwd: string,
  entries: ReadonlyArray<CustomEntry> = [],
  notify?: NotifyRecorder,
  projectTrusted?: boolean,
): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getEntries: () => entries,
      // Other SessionManager methods are stubbed to throw via the
      // unknown-cast below; any accidental dependency surfaces as a
      // clear TypeError rather than silently passing.
    } as unknown as ExtensionContext["sessionManager"],
    // Only attach `ui` when a recorder is provided — a plain
    // extension context has one, but suites that don't assert on
    // notifications stay untouched.
    ...(notify
      ? {
          ui: {
            notify: (message: string, type?: "info" | "warning" | "error") => {
              notify.messages.push(message);
              notify.types.push(type ?? "info");
            },
          },
        }
      : {}),
    // Only attach `isProjectTrusted` when a decision is provided —
    // absence exercises the bridge's `?.() ?? true` fallback.
    ...(projectTrusted !== undefined
      ? { isProjectTrusted: () => projectTrusted }
      : {}),
  } as ExtensionContext;
}

// ---------------------------------------------------------------------------
// session_start firing + notification recorder
// ---------------------------------------------------------------------------

/**
 * Records `ctx.ui.notify` calls (message bodies + types) so tests can
 * assert the in-chat notification surface of the lazy session_start
 * build. Create one with {@link makeNotifyRecorder} and pass it to
 * {@link makeCtx} / {@link fireSessionStart}.
 */
export interface NotifyRecorder {
  readonly messages: string[];
  readonly types: string[];
}

export function makeNotifyRecorder(): NotifyRecorder {
  return { messages: [], types: [] };
}

/**
 * Structural slice of a mock pi that has registered a `session_start`
 * handler — enough for {@link fireSessionStart} to drive it.
 */
export interface SessionStartMock {
  handlers: Partial<
    Record<"session_start", (event: unknown, ctx: unknown) => unknown>
  >;
}

/**
 * Fire the registered `session_start` handler with `cwd`, awaiting it
 * (the lazy design builds the runtime inside the handler, so the
 * promise must settle before firing tool calls). Pass an optional
 * {@link NotifyRecorder} to capture `ui.notify` calls from the
 * strict-mode error surface, and an optional `projectTrusted` to
 * drive the bridge's project-layer trust gate (absent → `makeCtx`
 * leaves `isProjectTrusted` off, exercising the fallback).
 */
export async function fireSessionStart(
  mock: SessionStartMock,
  cwd: string,
  reason = "startup",
  notify?: NotifyRecorder,
  projectTrusted?: boolean,
): Promise<void> {
  const h = mock.handlers.session_start;
  if (!h) throw new Error("session_start handler not registered");
  await h(
    { type: "session_start", reason },
    makeCtx(cwd, [], notify, projectTrusted),
  );
}

// ---------------------------------------------------------------------------
// Tracked EvaluatorHost
// ---------------------------------------------------------------------------

/**
 * Tracked {@link EvaluatorHost} recording every exec / appendEntry
 * call so tests can assert memoization + audit logging.
 *
 * `entries` is the backing array `makeCtx` wraps when tests want the
 * host's `appendEntry` writes visible to a later `findEntries` read.
 * Timestamps are monotonically-incrementing second-level ISO strings
 * so ordering asserts stay stable inside the same millisecond.
 */
export interface TrackedHost extends EvaluatorHost {
  readonly execCalls: Array<{ cmd: string; args: string[]; cwd: string }>;
  readonly appended: Array<{ type: string; data: unknown }>;
  readonly entries: CustomEntry[];
}

/**
 * Build a {@link TrackedHost}. Optional `exec` override lets evaluator
 * tests count real invocations against the cache (the default exec
 * returns `{ stdout: "", stderr: "", code: 0, killed: false }`).
 */
export function makeTrackedHost(options?: {
  exec?: (cmd: string, args: string[], cwd: string) => Promise<PiExecResult>;
}): TrackedHost {
  const execCalls: TrackedHost["execCalls"] = [];
  const appended: TrackedHost["appended"] = [];
  const entries: CustomEntry[] = [];
  let idCounter = 0;
  return {
    execCalls,
    appended,
    entries,
    exec: async (cmd, args, opts) => {
      const cwd = opts?.cwd ?? "/";
      execCalls.push({ cmd, args: [...args], cwd });
      if (options?.exec) {
        return options.exec(cmd, args, cwd);
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    appendEntry: (type, data) => {
      appended.push({ type, data });
      entries.push({
        type: "custom",
        customType: type,
        data,
        timestamp: new Date(
          Date.UTC(2026, 0, 1, 0, 0, idCounter++),
        ).toISOString(),
        id: `entry-${idCounter}`,
        parentId: null,
      });
    },
  };
}
