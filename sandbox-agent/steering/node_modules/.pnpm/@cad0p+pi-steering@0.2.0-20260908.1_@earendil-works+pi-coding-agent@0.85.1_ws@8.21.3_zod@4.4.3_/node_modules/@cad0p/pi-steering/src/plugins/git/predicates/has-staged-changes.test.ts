// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `hasStagedChanges` predicate handler
 * (`./has-staged-changes.ts`).
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
import { hasStagedChanges } from "./has-staged-changes.ts";

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
// hasStagedChanges
// ---------------------------------------------------------------------------

describe("predicate: hasStagedChanges", () => {
  it("exit 0 (no staged) matches `false`", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" &&
          args[0] === "diff" &&
          args[1] === "--cached" &&
          args[2] === "--quiet",
        result: execOk(""),
      },
    ]);
    assert.equal(await hasStagedChanges(false, ctx), true);
    assert.equal(await hasStagedChanges(true, ctx), false);
    assert.equal(execCalls.length, 2);
  });

  it("exit 1 (staged) matches `true`", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "diff",
        result: execFail(1),
      },
    ]);
    assert.equal(await hasStagedChanges(true, ctx), true);
  });

  it("unexpected exit code -> false (don't fire)", async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execFail(128) },
    ]);
    assert.equal(await hasStagedChanges(true, ctx), false);
    const { ctx: ctx2 } = makeCtx([
      { match: (cmd) => cmd === "git", result: execFail(128) },
    ]);
    assert.equal(await hasStagedChanges(false, ctx2), false);
  });

  it("thrown exec -> false", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        throwError: new Error("spawn"),
      },
    ]);
    assert.equal(await hasStagedChanges(true, ctx), false);
  });

  it("non-boolean arg -> false", async () => {
    const { ctx } = makeCtx([]);
    assert.equal(
      await hasStagedChanges("yes" as unknown as boolean, ctx),
      false,
    );
  });

  it("spread `{ value: true }` is equivalent to bare `true` (schema-advertised shape)", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" &&
          args[0] === "diff" &&
          args[1] === "--cached" &&
          args[2] === "--quiet",
        result: execFail(1), // staged changes exist
      },
    ]);
    assert.equal(await hasStagedChanges({ value: true }, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("spread `{ value: false, onUnknown: 'allow' }` ignores onUnknown in handler body", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        result: execOk(""), // no staged changes
      },
    ]);
    // onUnknown is read by readLeafOnUnknown at the engine layer;
    // the handler accepts the spread-with-modifier shape directly
    // and unwraps `value:` only.
    assert.equal(
      await hasStagedChanges({ value: false, onUnknown: "allow" }, ctx),
      true,
    );
  });
});
