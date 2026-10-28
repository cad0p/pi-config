// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `branch` predicate handler
 * (`./branch.ts`), including the shared walkerString contract.
 *
 * Each handler is tested in isolation with a mock `PredicateContext`
 * whose `exec` records every invocation and returns a stubbed
 * `ExecResult`. This pins the shell-command shape each predicate
 * emits AND the branching logic without spawning real git. Walker-
 * state interactions for `branch` are covered here (the tracker's own
 * modifier semantics live in `../trackers/branch-tracker.test.ts`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandFromInput } from "../../../helpers/command.ts";
import type {
  ExecResult,
  PredicateContext,
  WhenWalkerState,
} from "../../../index.ts";
import { branch } from "./branch.ts";

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
// branch
// ---------------------------------------------------------------------------

describe("predicate: branch", () => {
  it("reads ctx.walkerState.branch when set (no exec)", async () => {
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { branch: "main" },
    });
    const matches = await branch(/^main$/, ctx);
    assert.equal(matches, true);
    assert.equal(execCalls.length, 0);
  });

  it("walkerState misses -> falls back to `git branch --show-current`", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" && args[0] === "branch" && args[1] === "--show-current",
        result: execOk("feature\n"),
      },
    ]);
    const matches = await branch(/^feature$/, ctx);
    assert.equal(matches, true);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0]!.args, ["branch", "--show-current"]);
    assert.equal(execCalls[0]!.cwd, "/repo");
  });

  it('walkerState value `"unknown"` (dynamic checkout) short-circuits: default onUnknown=block fires, no exec fallback', async () => {
    // The walker saw something like `git checkout $VAR` - a write
    // occurred but the target branch can't be resolved statically.
    // Falling through to `git branch --show-current` would return
    // the PRE-checkout branch and silently defeat the walker's
    // whole purpose. Predicate must apply onUnknown without exec.
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { branch: "unknown" },
    });
    const matches = await branch(/^main$/, ctx);
    assert.equal(matches, true);
    assert.equal(
      execCalls.length,
      0,
      "exec must not be called when walker reports unknown",
    );
  });

  it('walkerState value `"unknown"` with onUnknown: "allow" - rule skips, still no exec', async () => {
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { branch: "unknown" },
    });
    const matches = await branch(
      { pattern: /^main$/, onUnknown: "allow" },
      ctx,
    );
    assert.equal(matches, false);
    assert.equal(execCalls.length, 0);
  });

  it("walkerState missing entirely (no in-chain checkout) -> exec fallback", async () => {
    // No `walkerState` on ctx at all: the tracker observed no git
    // checkout in this chain, so the current shell-level branch
    // value IS the predicate's answer. Exec is the right path.
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" && args[0] === "branch" && args[1] === "--show-current",
        result: execOk("trunk\n"),
      },
    ]);
    const matches = await branch(/^trunk$/, ctx);
    assert.equal(matches, true);
    assert.equal(execCalls.length, 1);
  });

  it("onUnknown defaults to block - exec failure fires the predicate", async () => {
    // `git branch --show-current` fails (not a repo). Default
    // `onUnknown: "block"` means "the rule fires" - the predicate
    // reports match=true so the surrounding rule does NOT skip.
    const { ctx } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "branch",
        result: execFail(128, "not a git repository"),
      },
    ]);
    const matches = await branch(/^main$/, ctx);
    assert.equal(matches, true);
  });

  it('onUnknown: "allow" - exec failure skips the rule', async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "branch",
        result: execFail(128),
      },
    ]);
    const matches = await branch(
      { pattern: /^main$/, onUnknown: "allow" },
      ctx,
    );
    assert.equal(matches, false);
  });

  it("empty stdout (detached HEAD) applies onUnknown", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "branch",
        result: execOk(""),
      },
    ]);
    // Default block -> fires.
    assert.equal(await branch(/^main$/, ctx), true);
    // Explicit allow -> skips.
    const { ctx: ctxAllow } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "branch",
        result: execOk(""),
      },
    ]);
    assert.equal(
      await branch({ pattern: /^main$/, onUnknown: "allow" }, ctxAllow),
      false,
    );
  });

  it("string pattern compiles as regex", async () => {
    const { ctx } = makeCtx([], { walkerState: { branch: "feat-new" } });
    assert.equal(await branch("^feat-", ctx), true);
    assert.equal(await branch("^main$", ctx), false);
  });

  it("invalid arg shape returns false", async () => {
    const { ctx } = makeCtx([], { walkerState: { branch: "main" } });
    // Numeric is not a valid pattern - predicate returns false
    // rather than throwing.
    assert.equal(await branch(42 as unknown, ctx), false);
  });

  it("thrown exec error treated as failure + applies onUnknown", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        throwError: new Error("spawn ENOENT"),
      },
    ]);
    // Default block -> fires.
    assert.equal(await branch(/^main$/, ctx), true);
  });
});

// ---------------------------------------------------------------------------
// Pattern-matcher array form (branch)
// ---------------------------------------------------------------------------
//
// Pins the array shorthand and `{ pattern: Pattern[]; onUnknown }` form
// for the `branch` predicate. (`cwd` lives in the engine's
// `evaluator-internals/predicates.ts`; its array-form tests are in
// evaluator.test.ts.)
//
// Array semantics: OR-of-matches. Empty arrays are invalid (rule skips);
// arrays with non-Pattern elements are invalid (rule skips).

describe("predicate: branch (array form)", () => {
  it("matches when walker branch matches any pattern in the array", async () => {
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { branch: "trunk" },
    });
    assert.equal(await branch([/^main$/, /^master$/, /^trunk$/], ctx), true);
    assert.equal(execCalls.length, 0);
  });

  it("skips when walker branch matches none of the array patterns", async () => {
    const { ctx } = makeCtx([], {
      walkerState: { branch: "feature-x" },
    });
    assert.equal(await branch([/^main$/, /^master$/], ctx), false);
  });

  it("accepts mixed string + RegExp Pattern[]", async () => {
    const { ctx } = makeCtx([], {
      walkerState: { branch: "main" },
    });
    assert.equal(await branch(["^main$", /^master$/], ctx), true);
  });

  it("empty array is invalid (rule skips)", async () => {
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { branch: "main" },
    });
    assert.equal(await branch([], ctx), false);
    assert.equal(execCalls.length, 0);
  });

  it("array with non-Pattern element is invalid (rule skips)", async () => {
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { branch: "main" },
    });
    assert.equal(
      await branch([/^main$/, 123 as unknown as string], ctx),
      false,
    );
    assert.equal(execCalls.length, 0);
  });

  it("object form with Pattern[] + onUnknown: 'allow' applies the policy on unknown", async () => {
    const { ctx } = makeCtx([], {
      walkerState: { branch: "unknown" },
    });
    assert.equal(
      await branch(
        { pattern: [/^main$/, /^master$/], onUnknown: "allow" },
        ctx,
      ),
      false,
    );
  });

  it("object form with Pattern[] + default onUnknown blocks on unknown", async () => {
    const { ctx } = makeCtx([], {
      walkerState: { branch: "unknown" },
    });
    assert.equal(await branch({ pattern: [/^main$/, /^master$/] }, ctx), true);
  });
});

// walkerString contract-assertion tests live in `./shared.test.ts`
// alongside the other cross-predicate suites.
