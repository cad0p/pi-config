// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Cross-predicate suites for the git plugin's predicate handlers.
 *
 * These describe blocks exercise MULTIPLE handlers at once, so they
 * don't belong in any single per-predicate test file:
 *
 *   - `predicates: explicit onUnknown:block form` — pins that the
 *     explicit `onUnknown: "block"` form is identical to the default
 *     across the pattern-valued predicates.
 *   - `walkerString: rejects initialSentinel === "unknown"` — the
 *     tracker-contract assertion on the shared helper.
 *   - `predicates: inline walker-unknown cwd guard surfaces trinary
 *     unknown` — the walker-unknown-cwd guard matrix exercising ALL
 *     six runtime-cwd handlers.
 *
 * Handlers are imported from the `./index.ts` bundle (the same
 * surface the plugin index re-exports), not the per-item files.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandFromInput } from "../../../helpers/command.ts";
import type {
  ExecResult,
  PredicateContext,
  WhenWalkerState,
} from "../../../index.ts";
import { branch, walkerString } from "./branch.ts";
import { commitsAhead } from "./commits-ahead.ts";
import { hasStagedChanges } from "./has-staged-changes.ts";
import { isClean } from "./is-clean.ts";
import { remote } from "./remote.ts";
import { upstream } from "./upstream.ts";

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string;
  args: string[];
  cwd?: string | undefined;
}

/**
 * Minimal `PredicateContext` stub for predicate unit tests.
 *
 * `exec` dispatches on the FIRST matching key in `responses` (the
 * table is consulted top-to-bottom), letting tests stub different
 * results for different commands. Unmatched calls throw so the test
 * catches accidental shell-out expansions.
 */
function makeCtx(
  responses: ReadonlyArray<{
    match: (cmd: string, args: string[]) => boolean;
    result?: ExecResult;
    throwError?: Error;
  }>,
  opts?: {
    cwd?: string;
    walkerState?: Partial<WhenWalkerState> & Record<string, unknown>;
  },
): { ctx: PredicateContext; execCalls: ExecCall[] } {
  const execCalls: ExecCall[] = [];
  const ctx: PredicateContext = {
    cwd: opts?.cwd ?? "/repo",
    tool: "bash",
    input: { tool: "bash", command: "" },
    command: commandFromInput({ tool: "bash", command: "" }),
    agentLoopIndex: 0,
    exec: async (cmd, args, execOpts) => {
      execCalls.push({ cmd, args: [...args], cwd: execOpts?.cwd });
      for (const entry of responses) {
        if (entry.match(cmd, args)) {
          if (entry.throwError) throw entry.throwError;
          if (entry.result) return entry.result;
        }
      }
      throw new Error(`unexpected exec call: ${cmd} ${args.join(" ")}`);
    },
    appendEntry: () => {},
    findEntries: () => [],
    ...(opts?.walkerState !== undefined
      ? { walkerState: opts.walkerState as Readonly<WhenWalkerState> }
      : {}),
  };
  return { ctx, execCalls };
}

function execOk(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function execFail(exitCode: number, stderr = ""): ExecResult {
  return { stdout: "", stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Explicit `onUnknown: "block"` form (pins the default behavior is
// identical to the explicit form)
// ---------------------------------------------------------------------------

describe("predicates: explicit onUnknown:block form", () => {
  it('branch { pattern, onUnknown: "block" } behaves like default', async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execFail(128) },
    ]);
    assert.equal(
      await branch({ pattern: /^main$/, onUnknown: "block" }, ctx),
      true,
    );
  });

  it('upstream { pattern, onUnknown: "block" } behaves like default', async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execFail(128) },
    ]);
    assert.equal(
      await upstream({ pattern: /^origin\/main$/, onUnknown: "block" }, ctx),
      true,
    );
  });

  it('remote { pattern, onUnknown: "block" } behaves like default', async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execFail(128) },
    ]);
    assert.equal(
      await remote({ pattern: /my-org/, onUnknown: "block" }, ctx),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// walkerString: tracker contract assertion
// ---------------------------------------------------------------------------

describe('walkerString: rejects initialSentinel === "unknown"', () => {
  // Future tracker authors MUST NOT pass `"unknown"` as the
  // `initialSentinel` argument: that sentinel is reserved for the
  // dynamic-unresolvable signal, and overloading it collapses the
  // three-way discrimination (value / unknown / missing) back to the
  // pre-U1 two-step bug. The function's JSDoc flagged this; the
  // assertion makes the contract un-foot-shootable.
  it('throws a targeted error when called with initialSentinel === "unknown"', () => {
    const { ctx } = makeCtx([]);
    assert.throws(
      () => walkerString(ctx, "branch", "unknown"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /initialSentinel cannot be/);
        assert.match(err.message, /"unknown"/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Walker-unknown cwd inline guard
//
// `isClean`, `hasStagedChanges`, `remote`, `upstream`, `commitsAhead` all
// call `ctx.exec("git", [...], { cwd: ctx.cwd })` at runtime. When the
// walker's cwd tracker couldn't statically resolve the effective cwd
// (e.g. `cd "$VAR/pkg" && git commit`) `ctx.cwd` falls back to the pre-cd
// ambient cwd — the pi session cwd, NOT the intended subpackage. Without
// a guard the predicate silently queries the wrong repo and a gate like
// `isClean: true` would miss the state that matters.
//
// The runtime-cwd predicates inline a `cwdIsWalkerUnknown(ctx)` check at
// the top of each handler and surface trinary `"unknown"` instead of
// fail-CLOSED `true`. The engine projects `"unknown"` to a definite
// verdict via the leaf-level
// (or, inside `not:`, the block-level) `onUnknown:` policy — default
// `"block"` keeps the fail-CLOSED behavior the wrap provided, while
// `onUnknown: "allow"` opts into fail-OPEN handling.
//
// These tests pin that contract: when `ctx.walkerState.cwd === "unknown"`,
// each handler returns the literal string `"unknown"` regardless of what
// the stubbed exec would have returned — in fact exec must not be called
// at all.
// ---------------------------------------------------------------------------

describe("predicates: inline walker-unknown cwd guard surfaces trinary unknown", () => {
  it("isClean returns 'unknown' without calling exec when walker reports cwd unknown", async () => {
    // Even though the stubbed `git status --porcelain` would return
    // empty stdout (i.e. clean → `isClean: true` would MATCH and
    // `isClean: false` would NOT), the inline guard must short-circuit
    // BEFORE dispatch and surface trinary unknown regardless of the
    // args value.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" && args[0] === "status" && args[1] === "--porcelain",
          result: execOk(""),
        },
      ],
      { walkerState: { cwd: "unknown" } },
    );
    assert.equal(await isClean(true, ctx), "unknown");
    assert.equal(await isClean(false, ctx), "unknown");
    assert.equal(
      execCalls.length,
      0,
      "exec must not be called when walker reports cwd unknown",
    );
  });

  it("hasStagedChanges returns 'unknown' without calling exec when walker reports cwd unknown", async () => {
    // Stubbed exit 0 would classify as "no staged changes", so
    // `hasStagedChanges: true` would NOT match under the normal
    // code path. The inline guard must override that and surface
    // unknown for both boolean args.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" &&
            args[0] === "diff" &&
            args[1] === "--cached" &&
            args[2] === "--quiet",
          result: execOk(""),
        },
      ],
      { walkerState: { cwd: "unknown" } },
    );
    assert.equal(await hasStagedChanges(true, ctx), "unknown");
    assert.equal(await hasStagedChanges(false, ctx), "unknown");
    assert.equal(execCalls.length, 0);
  });

  it("remote returns 'unknown' without calling exec when walker reports cwd unknown", async () => {
    // Stubbed stdout matches the test pattern under normal
    // dispatch (→ match = true → fire). Without the inline guard
    // the rule would also fire, so the test is sharpened by
    // asserting that exec is NOT called even once: the unknown
    // verdict must come from the walker short-circuit, not from
    // the stub.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" &&
            args[0] === "config" &&
            args[1] === "--get" &&
            args[2] === "remote.origin.url",
          result: execOk("git@github.com:org/repo.git\n"),
        },
      ],
      { walkerState: { cwd: "unknown" } },
    );
    assert.equal(await remote(/github\.com:org\//, ctx), "unknown");
    // Also pin the inline guard fires even when the pattern would
    // NOT have matched the stubbed stdout — the verdict is
    // walker-driven, not pattern-driven.
    assert.equal(await remote(/never-matches/, ctx), "unknown");
    assert.equal(
      execCalls.length,
      0,
      "exec must not be called when walker reports cwd unknown",
    );
  });

  it("isClean with known cwd still dispatches to the handler (guard is transparent)", async () => {
    // Counter-pin: with walker cwd resolved, the inline guard must
    // NOT interfere — the handler runs and the verdict reflects the
    // git state. Guards against a refactor that over-fires on a
    // walker-known cwd.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" && args[0] === "status" && args[1] === "--porcelain",
          result: execOk(""),
        },
      ],
      { walkerState: { cwd: "/workplace/pkg" } },
    );
    assert.equal(await isClean(true, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("upstream returns 'unknown' without calling exec when walker reports cwd unknown", async () => {
    // Same contract as isClean / hasStagedChanges / remote: the
    // underlying `git rev-parse --abbrev-ref @{upstream}` call runs
    // at `ctx.cwd`. When the walker bails, exec would target the pi
    // session cwd — wrong repo — and a rule with
    // `onUnknown: "allow"` would silently fail-OPEN. Pin that the
    // inline guard surfaces unknown before dispatch.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" &&
            args[0] === "rev-parse" &&
            args[1] === "--abbrev-ref" &&
            args[2] === "@{upstream}",
          result: execOk("origin/main\n"),
        },
      ],
      { walkerState: { cwd: "unknown" } },
    );
    // Walker-unknown short-circuit: the handler surfaces trinary
    // `"unknown"` regardless of the leaf-level `onUnknown:` field;
    // the engine's leaf adapter then projects (default `"block"` =
    // fail-CLOSED) at the call site.
    assert.equal(await upstream(/^origin\/main$/, ctx), "unknown");
    assert.equal(
      await upstream({ pattern: /^origin\/main$/, onUnknown: "allow" }, ctx),
      "unknown",
    );
    assert.equal(
      execCalls.length,
      0,
      "exec must not be called when walker reports cwd unknown",
    );
  });

  it("upstream with known cwd still dispatches to the handler (guard is transparent)", async () => {
    // Counter-pin: walker cwd resolved → handler runs.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" &&
            args[0] === "rev-parse" &&
            args[1] === "--abbrev-ref" &&
            args[2] === "@{upstream}",
          result: execOk("origin/main\n"),
        },
      ],
      { walkerState: { cwd: "/workplace/pkg" } },
    );
    assert.equal(await upstream(/^origin\/main$/, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("commitsAhead returns 'unknown' without calling exec when walker reports cwd unknown", async () => {
    // commitsAhead has no `onUnknown` knob at all; its exec-
    // failure path returns `false` (rule silently skips). That's
    // exactly the silent fail-OPEN class the inline walker-unknown
    // guard exists to close. Pin that the guard surfaces unknown
    // ahead of dispatch for every comparator flavor.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-list",
          result: execOk("3\n"),
        },
      ],
      { walkerState: { cwd: "unknown" } },
    );
    // Under normal dispatch, `3 === 1` would be false; under the
    // guard it returns trinary unknown.
    assert.equal(await commitsAhead({ eq: 1 }, ctx), "unknown");
    // Normal dispatch would fire true for `gt: 0`; guard still
    // returns trinary unknown without running exec.
    assert.equal(await commitsAhead({ gt: 0 }, ctx), "unknown");
    assert.equal(
      execCalls.length,
      0,
      "exec must not be called when walker reports cwd unknown",
    );
  });

  it("commitsAhead with known cwd still dispatches to the handler (guard is transparent)", async () => {
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" && args[0] === "rev-list" && args[1] === "--count",
          result: execOk("2\n"),
        },
      ],
      { walkerState: { cwd: "/workplace/pkg" } },
    );
    assert.equal(await commitsAhead({ eq: 2 }, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("remote surfaces 'unknown' on walker-unknown cwd regardless of leaf-level onUnknown:allow", async () => {
    // Pins the trinary handler contract: the inline
    // walker-unknown-cwd guard surfaces trinary `"unknown"` BEFORE
    // the inner exec or no-origin path runs, and BEFORE the leaf-
    // level `onUnknown:` projection. The handler itself doesn't
    // consume the leaf-level `onUnknown:` modifier on the
    // walker-unknown branch — the engine's leaf adapter applies
    // the leaf-level `onUnknown:` to project unknown → boolean at
    // the call site (or the not-block evaluator applies the block-
    // level `onUnknown:` inside `not:`). A refactor that consumed
    // the leaf's `onUnknown:` inside the handler would double-
    // project and break the inner-vs-outer split that closes the
    // `not: { cwd: P }` silent fail-OPEN class.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd) => cmd === "git",
          result: execOk("url\n"),
        },
      ],
      { walkerState: { cwd: "unknown" } },
    );
    assert.equal(
      await remote({ pattern: /./, onUnknown: "allow" }, ctx),
      "unknown",
      "handler surfaces trinary unknown on walker-unknown cwd; leaf-level `onUnknown:` projection happens at the engine, not the handler",
    );
    assert.equal(execCalls.length, 0);
  });

  it("hasStagedChanges with known cwd dispatches to handler", async () => {
    // Counter-pin: `isClean`'s known-cwd dispatch is pinned above;
    // this mirrors it for `hasStagedChanges` so the "walker-defined,
    // cwd-resolved → delegate" branch of the wrap is exercised on
    // every wrapped predicate, not just isClean.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" &&
            args[0] === "diff" &&
            args[1] === "--cached" &&
            args[2] === "--quiet",
          result: execOk(""),
        },
      ],
      { walkerState: { cwd: "/workplace/pkg" } },
    );
    assert.equal(await hasStagedChanges(false, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("remote with known cwd dispatches to handler", async () => {
    // Counter-pin: mirrors the isClean / hasStagedChanges known-
    // cwd dispatch tests for remote. With walker cwd resolved, the
    // wrap must not interfere — the handler runs and the verdict
    // reflects the git state.
    const { ctx, execCalls } = makeCtx(
      [
        {
          match: (cmd) => cmd === "git",
          result: execOk("git@github.com:org/repo.git\n"),
        },
      ],
      { walkerState: { cwd: "/workplace/pkg" } },
    );
    assert.equal(await remote(/github\.com:org\//, ctx), true);
    assert.equal(execCalls.length, 1);
  });
});
