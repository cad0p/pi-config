// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `upstream` predicate handler
 * (`./upstream.ts`).
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
// upstream
// ---------------------------------------------------------------------------

describe("predicate: upstream", () => {
  it("matches when git rev-parse resolves", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" &&
          args[0] === "rev-parse" &&
          args[1] === "--abbrev-ref" &&
          args[2] === "@{upstream}",
        result: execOk("origin/main\n"),
      },
    ]);
    assert.equal(await upstream(/^origin\/main$/, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("no upstream configured (exit != 0) -> onUnknown block (default)", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
        result: execFail(128, "no upstream configured"),
      },
    ]);
    assert.equal(await upstream(/./, ctx), true);
  });

  it("onUnknown: allow - exec failure skips", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
        result: execFail(128),
      },
    ]);
    assert.equal(
      await upstream({ pattern: /./, onUnknown: "allow" }, ctx),
      false,
    );
  });

  it("pattern doesn't match stdout -> false (rule skips)", async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execOk("origin/feature\n") },
    ]);
    assert.equal(await upstream(/^origin\/main$/, ctx), false);
  });
});

// ---------------------------------------------------------------------------
// Pattern-matcher array form (upstream)
// ---------------------------------------------------------------------------
//
// Pins the array shorthand and `{ pattern: Pattern[]; onUnknown }` form
// for the `upstream` predicate. Array semantics: OR-of-matches. Empty
// arrays are invalid (rule skips); arrays with non-Pattern elements are
// invalid (rule skips).

describe("predicate: upstream (array form)", () => {
  it("matches when upstream matches any pattern in the array", async () => {
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: execOk("origin/develop\n"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(
      await upstream([/^origin\/main$/, /^origin\/develop$/], ctx),
      true,
    );
  });

  it("skips when upstream matches none of the array patterns", async () => {
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: execOk("origin/feature\n"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(
      await upstream([/^origin\/main$/, /^origin\/develop$/], ctx),
      false,
    );
  });

  it("accepts mixed string + RegExp Pattern[]", async () => {
    // Cross-predicate parity: branch's mixed-Pattern[] test pins
    // the same `unwrapPatternArg` narrowing path; mirroring it on
    // upstream catches a regression that inlines a stricter
    // (RegExp-only) narrow at one predicate's call site without
    // updating the others.
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: execOk("origin/main\n"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(
      await upstream(["^origin/main$", /^origin\/develop$/], ctx),
      true,
    );
  });

  it("empty array is invalid (rule skips)", async () => {
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { cwd: "/repo" },
    });
    assert.equal(await upstream([], ctx), false);
    assert.equal(execCalls.length, 0);
  });

  it("array with non-Pattern element is invalid (rule skips)", async () => {
    // Cross-predicate parity with branch + remote: malformed array
    // elements (non-string, non-RegExp) fail-skip uniformly via the
    // shared `unwrapPatternArg` helper. Pinning at the upstream
    // call site catches a regression that inlines the helper at one
    // predicate and lets a typed-array malformed input fall through
    // to a silent regex-coercion path.
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { cwd: "/repo" },
    });
    assert.equal(
      await upstream([/^origin\/main$/, 123 as unknown as string], ctx),
      false,
    );
    assert.equal(execCalls.length, 0);
  });

  it("object form with Pattern[] + onUnknown: 'allow' on no-upstream skips", async () => {
    // No upstream configured (exec exits non-zero). With
    // `onUnknown: "allow"`, the predicate skips regardless of the
    // array shape — mirror of remote's no-origin pin and the
    // branch object-form pin.
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: execFail(128, "no upstream configured"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(
      await upstream(
        {
          pattern: [/^origin\/main$/, /^origin\/develop$/],
          onUnknown: "allow",
        },
        ctx,
      ),
      false,
    );
  });

  it("object form with Pattern[] + default onUnknown blocks on no-upstream", async () => {
    // Cross-predicate parity with branch's object-form default-
    // blocks pin and remote's default-blocks-on-no-origin pin: the
    // default `onUnknown: "block"` posture must fire fail-closed when
    // the predicate can't determine the upstream value (regardless of
    // pattern shape — single or array).
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: execFail(128, "no upstream configured"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(
      await upstream({ pattern: [/^origin\/main$/, /^origin\/develop$/] }, ctx),
      true,
    );
  });
});
