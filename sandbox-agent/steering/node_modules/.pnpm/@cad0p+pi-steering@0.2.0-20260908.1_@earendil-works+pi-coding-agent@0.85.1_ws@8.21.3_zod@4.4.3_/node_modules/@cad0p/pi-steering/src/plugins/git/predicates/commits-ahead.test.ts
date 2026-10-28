// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `commitsAhead` predicate handler
 * (`./commits-ahead.ts`).
 *
 * Each handler is tested in isolation with a mock `PredicateContext`
 * whose `exec` records every invocation and returns a stubbed
 * `ExecResult`. This pins the shell-command shape each predicate
 * emits AND the branching logic without spawning real git.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandFromInput } from "../../../helpers/command.ts";
import type {
  ExecResult,
  PredicateContext,
  WhenWalkerState,
} from "../../../index.ts";
import { commitsAhead } from "./commits-ahead.ts";

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
// commitsAhead
// ---------------------------------------------------------------------------

describe("predicate: commitsAhead", () => {
  it("eq matches exact count", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" &&
          args[0] === "rev-list" &&
          args[1] === "--count" &&
          args[2] === "@{upstream}..HEAD",
        result: execOk("1\n"),
      },
    ]);
    assert.equal(await commitsAhead({ eq: 1 }, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("eq misses -> false", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "rev-list",
        result: execOk("3\n"),
      },
    ]);
    assert.equal(await commitsAhead({ eq: 1 }, ctx), false);
  });

  it("gt strict greater-than", async () => {
    const { ctx: ctx1 } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        result: execOk("0\n"),
      },
    ]);
    assert.equal(await commitsAhead({ gt: 0 }, ctx1), false);

    const { ctx: ctx2 } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        result: execOk("1\n"),
      },
    ]);
    assert.equal(await commitsAhead({ gt: 0 }, ctx2), true);
  });

  it("gt + lt combined - all comparators must pass (AND)", async () => {
    const { ctx: ctx3 } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("3\n") },
    ]);
    // 3 > 0 AND 3 < 5 -> true
    assert.equal(await commitsAhead({ gt: 0, lt: 5 }, ctx3), true);

    const { ctx: ctx5 } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("5\n") },
    ]);
    // 5 > 0 but 5 < 5 is false -> false
    assert.equal(await commitsAhead({ gt: 0, lt: 5 }, ctx5), false);
  });

  it("custom wrt is forwarded to git rev-list", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" &&
          args[0] === "rev-list" &&
          args[2] === "origin/main..HEAD",
        result: execOk("2\n"),
      },
    ]);
    assert.equal(await commitsAhead({ wrt: "origin/main", eq: 2 }, ctx), true);
    assert.equal(execCalls[0]!.args[2], "origin/main..HEAD");
  });

  it("no comparators specified -> false (invalid config)", async () => {
    // Don't register any responses - the predicate must not call
    // exec when the arg shape is invalid.
    const { ctx, execCalls } = makeCtx([]);
    assert.equal(await commitsAhead({}, ctx), false);
    assert.equal(execCalls.length, 0);
  });

  it("exec failure -> false (no upstream configured)", async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execFail(128) },
    ]);
    assert.equal(await commitsAhead({ eq: 1 }, ctx), false);
  });

  it("non-numeric stdout -> false", async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("not-a-number") },
    ]);
    assert.equal(await commitsAhead({ eq: 0 }, ctx), false);
  });

  it("null / non-object args -> false", async () => {
    const { ctx } = makeCtx([]);
    assert.equal(
      await commitsAhead(null as unknown as { eq: number }, ctx),
      false,
    );
    assert.equal(
      await commitsAhead("bogus" as unknown as { eq: number }, ctx),
      false,
    );
  });

  it("lt standalone - strict less-than boundary", async () => {
    const { ctx: ctxAtLimit } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("5\n") },
    ]);
    assert.equal(await commitsAhead({ lt: 5 }, ctxAtLimit), false);
    const { ctx: ctxBelow } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("4\n") },
    ]);
    assert.equal(await commitsAhead({ lt: 5 }, ctxBelow), true);
  });

  it("bare-number `commitsAhead: N` is sugar for `{ eq: N }` (schema-advertised shape)", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" &&
          args[0] === "rev-list" &&
          args[1] === "--count" &&
          args[2] === "@{upstream}..HEAD",
        result: execOk("1\n"),
      },
    ]);
    assert.equal(await commitsAhead(1, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("bare-number `commitsAhead: 0` matches when count is 0 (sugar for `{ eq: 0 }`)", async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("0\n") },
    ]);
    assert.equal(await commitsAhead(0, ctx), true);
  });

  it("bare-number `commitsAhead: 2` does NOT match when count is 1 (negative case for the bare-number sugar path)", async () => {
    // Pins the bare-number sugar's miss path symmetrically with the
    // `{ eq: 1 }` miss test above. The bare-number sugar dispatches
    // through `eq = args` at the top of the handler, so the
    // comparator-mismatch branch is the same code path, but the
    // authoring shape differs and a regression that special-cased
    // the bare-number entry could mask the miss case.
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("1\n") },
    ]);
    assert.equal(await commitsAhead(2, ctx), false);
  });
});
