// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `remote` predicate handler
 * (`./remote.ts`).
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
import { remote } from "./remote.ts";

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
// remote
// ---------------------------------------------------------------------------

describe("predicate: remote", () => {
  it("matches origin URL via regex", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (cmd, args) =>
          cmd === "git" &&
          args[0] === "config" &&
          args[1] === "--get" &&
          args[2] === "remote.origin.url",
        result: execOk("git@github.com:org/repo.git\n"),
      },
    ]);
    assert.equal(await remote(/github\.com:org\//, ctx), true);
    assert.equal(execCalls.length, 1);
  });

  it("no origin configured -> onUnknown block (default) fires", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        result: execFail(1),
      },
    ]);
    assert.equal(await remote(/./, ctx), true);
  });

  it("onUnknown: allow skips on failure", async () => {
    const { ctx } = makeCtx([
      { match: (cmd) => cmd === "git", result: execFail(1) },
    ]);
    assert.equal(
      await remote({ pattern: /./, onUnknown: "allow" }, ctx),
      false,
    );
  });

  it("pattern doesn't match stdout -> false", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        result: execOk("git@github.com:other-org/repo.git\n"),
      },
    ]);
    assert.equal(await remote(/my-org\//, ctx), false);
  });

  it("matches https:// origin URL", async () => {
    const { ctx } = makeCtx([
      {
        match: (cmd) => cmd === "git",
        result: execOk("https://github.com/org/repo.git\n"),
      },
    ]);
    assert.equal(await remote(/github\.com\/org\//, ctx), true);
  });
});

// ---------------------------------------------------------------------------
// Pattern-matcher array form (remote)
// ---------------------------------------------------------------------------
//
// Pins the array shorthand and `{ pattern: Pattern[]; onUnknown }` form
// for the `remote` predicate. Array semantics: OR-of-matches. Empty
// arrays are invalid (rule skips); arrays with non-Pattern elements are
// invalid (rule skips).

describe("predicate: remote (array form)", () => {
  it("matches when remote URL matches any pattern in the array", async () => {
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" && args[0] === "config" && args[1] === "--get",
          result: execOk("https://github.com/cad0p/repo.git\n"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(await remote([/github\.com\//, /gitlab\.com\//], ctx), true);
  });

  it("skips when remote URL matches none of the array patterns", async () => {
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" && args[0] === "config" && args[1] === "--get",
          result: execOk("git@self-hosted.example.com:Foo/Bar.git\n"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(await remote([/github\.com\//, /gitlab\.com\//], ctx), false);
  });

  it("object form with Pattern[] + onUnknown: 'allow' on no-origin skips", async () => {
    // Remote URL fetch fails (no origin). With onUnknown: "allow",
    // the predicate skips regardless of array shape.
    const { ctx } = makeCtx(
      [
        {
          match: (cmd) => cmd === "git",
          result: execFail(1),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(
      await remote(
        { pattern: [/github\.com\//, /gitlab\.com\//], onUnknown: "allow" },
        ctx,
      ),
      false,
    );
  });

  it("array with non-Pattern element (e.g. number) is invalid (rule skips)", async () => {
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { cwd: "/repo" },
    });
    assert.equal(
      await remote([/github\.com\//, 123 as unknown as string], ctx),
      false,
    );
    assert.equal(execCalls.length, 0);
  });

  it("accepts mixed string + RegExp Pattern[]", async () => {
    // Cross-predicate parity with branch + upstream's mixed-Pattern[]
    // pins: the same `unwrapPatternArg` narrowing path runs at all
    // three predicates' call sites. Mirroring the test on remote
    // catches a regression that inlines a stricter (RegExp-only)
    // narrow at one predicate without updating the others.
    const { ctx } = makeCtx(
      [
        {
          match: (cmd, args) =>
            cmd === "git" && args[0] === "config" && args[1] === "--get",
          result: execOk("https://github.com/cad0p/repo.git\n"),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(await remote(["github.com/", /gitlab\.com\//], ctx), true);
  });

  it("empty array is invalid (rule skips)", async () => {
    // Cross-predicate parity with branch + upstream: empty arrays are
    // invalid uniformly across the three pattern-valued predicates,
    // short-circuiting before the predicate shells out.
    const { ctx, execCalls } = makeCtx([], {
      walkerState: { cwd: "/repo" },
    });
    assert.equal(await remote([], ctx), false);
    assert.equal(execCalls.length, 0);
  });

  it("object form with Pattern[] + default onUnknown blocks on no-origin", async () => {
    // Cross-predicate parity with branch's object-form default-blocks
    // pin and upstream's default-blocks-on-no-upstream pin: the
    // default `onUnknown: "block"` posture must fire fail-closed when
    // the predicate can't determine the remote value (no origin
    // configured), regardless of pattern shape (single or array).
    const { ctx } = makeCtx(
      [
        {
          match: (cmd) => cmd === "git",
          result: execFail(1),
        },
      ],
      { walkerState: { cwd: "/repo" } },
    );
    assert.equal(
      await remote({ pattern: [/github\.com\//, /gitlab\.com\//] }, ctx),
      true,
    );
  });
});
