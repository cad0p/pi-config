// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git-ops helpers (`./git-ops.ts`).
 *
 * Each helper is a thin `ctx.exec` wrapper that collapses all failure
 * modes (non-zero exit, spawn error, thrown exception) to `null`. We
 * pin the exact command-and-args shape each helper emits, the `cwd`
 * routing (default → `ctx.cwd`; explicit arg wins), and the
 * null-on-failure contract.
 *
 * Predicate-layer concerns (`onUnknown`, pattern matching, walker-state
 * short-circuits) live in `../predicates/*.test.ts` and are deliberately
 * not re-tested here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandFromInput } from "../../../helpers/command.ts";
import type { ExecResult, PredicateContext } from "../../../index.ts";
import {
  getBranch,
  getCommitsAhead,
  getRemoteUrl,
  getStagedChanges,
  getUpstream,
  getWorkingTreeClean,
} from "./git-ops.ts";

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string;
  args: string[];
  cwd?: string | undefined;
}

function makeCtx(
  responses: ReadonlyArray<{
    match: (cmd: string, args: string[]) => boolean;
    result?: ExecResult;
    throwError?: Error;
  }>,
  opts?: { cwd?: string },
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
    walkerState: { cwd: opts?.cwd ?? "/repo", env: new Map() },
  };
  return { ctx, execCalls };
}

const OK = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});
const EXIT = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({
  stdout,
  stderr,
  exitCode,
});

// ---------------------------------------------------------------------------
// getBranch
// ---------------------------------------------------------------------------

describe("getBranch", () => {
  it("returns trimmed stdout on exit 0", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: (c, a) => c === "git" && a[0] === "branch",
        result: OK("feature/foo\n"),
      },
    ]);
    const out = await getBranch(ctx);
    assert.equal(out, "feature/foo");
    assert.deepEqual(execCalls[0], {
      cmd: "git",
      args: ["branch", "--show-current"],
      cwd: "/repo",
    });
  });

  it("returns null on non-zero exit", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: EXIT(128) }]);
    assert.equal(await getBranch(ctx), null);
  });

  it("returns null on empty stdout (detached HEAD)", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: OK("\n") }]);
    assert.equal(await getBranch(ctx), null);
  });

  it("returns null when exec throws", async () => {
    const { ctx } = makeCtx([
      { match: () => true, throwError: new Error("spawn ENOENT") },
    ]);
    assert.equal(await getBranch(ctx), null);
  });

  it("does NOT consult walkerState.branch (predicate-layer concern)", async () => {
    // Helper always shells out. Walker-state shortcut is the
    // predicate's responsibility. See git-ops.ts file header.
    const { ctx, execCalls } = makeCtx([
      { match: () => true, result: OK("on-disk") },
    ]);
    ctx.walkerState = { cwd: "/repo", env: new Map(), branch: "walker-says" };
    const out = await getBranch(ctx);
    assert.equal(out, "on-disk");
    assert.equal(execCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// getUpstream
// ---------------------------------------------------------------------------

describe("getUpstream", () => {
  it("returns the upstream name on exit 0", async () => {
    const { ctx, execCalls } = makeCtx([
      { match: () => true, result: OK("origin/main\n") },
    ]);
    assert.equal(await getUpstream(ctx), "origin/main");
    assert.deepEqual(execCalls[0]?.args, [
      "rev-parse",
      "--abbrev-ref",
      "@{upstream}",
    ]);
  });

  it("returns null when no upstream configured (non-zero exit)", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: EXIT(128) }]);
    assert.equal(await getUpstream(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// getCommitsAhead
// ---------------------------------------------------------------------------

describe("getCommitsAhead", () => {
  it("parses rev-list count on exit 0", async () => {
    const { ctx, execCalls } = makeCtx([
      { match: () => true, result: OK("3\n") },
    ]);
    assert.equal(await getCommitsAhead(ctx), 3);
    assert.deepEqual(execCalls[0]?.args, [
      "rev-list",
      "--count",
      "@{upstream}..HEAD",
    ]);
  });

  it("accepts a custom wrt reference", async () => {
    const { ctx, execCalls } = makeCtx([
      { match: () => true, result: OK("1") },
    ]);
    await getCommitsAhead(ctx, "origin/main");
    assert.deepEqual(execCalls[0]?.args, [
      "rev-list",
      "--count",
      "origin/main..HEAD",
    ]);
  });

  it("returns null when rev-list fails (e.g. wrt not resolvable)", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: EXIT(128) }]);
    assert.equal(await getCommitsAhead(ctx, "nonexistent/ref"), null);
  });

  it("returns null on non-numeric stdout (corrupt output)", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: OK("NaN-ish\n") }]);
    assert.equal(await getCommitsAhead(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// getStagedChanges
// ---------------------------------------------------------------------------

describe("getStagedChanges", () => {
  it("returns false when `git diff --cached --quiet` exits 0 (clean index)", async () => {
    const { ctx, execCalls } = makeCtx([
      { match: () => true, result: EXIT(0) },
    ]);
    assert.equal(await getStagedChanges(ctx), false);
    assert.deepEqual(execCalls[0]?.args, ["diff", "--cached", "--quiet"]);
  });

  it("returns true when exit 1 (staged changes present)", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: EXIT(1) }]);
    assert.equal(await getStagedChanges(ctx), true);
  });

  it("returns null on unexpected exit codes", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: EXIT(128) }]);
    assert.equal(await getStagedChanges(ctx), null);
  });

  it("returns null when exec throws", async () => {
    const { ctx } = makeCtx([
      { match: () => true, throwError: new Error("boom") },
    ]);
    assert.equal(await getStagedChanges(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// getWorkingTreeClean
// ---------------------------------------------------------------------------

describe("getWorkingTreeClean", () => {
  it("returns true on empty stdout (clean tree)", async () => {
    const { ctx, execCalls } = makeCtx([{ match: () => true, result: OK("") }]);
    assert.equal(await getWorkingTreeClean(ctx), true);
    assert.deepEqual(execCalls[0]?.args, ["status", "--porcelain"]);
  });

  it("returns false when stdout is non-empty (dirty tree)", async () => {
    const { ctx } = makeCtx([
      { match: () => true, result: OK(" M README.md\n") },
    ]);
    assert.equal(await getWorkingTreeClean(ctx), false);
  });

  it("returns null on non-zero exit", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: EXIT(128) }]);
    assert.equal(await getWorkingTreeClean(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// getRemoteUrl
// ---------------------------------------------------------------------------

describe("getRemoteUrl", () => {
  it("returns the origin URL on exit 0", async () => {
    const { ctx, execCalls } = makeCtx([
      {
        match: () => true,
        result: OK("git@github.com:org/repo.git\n"),
      },
    ]);
    assert.equal(await getRemoteUrl(ctx), "git@github.com:org/repo.git");
    assert.deepEqual(execCalls[0]?.args, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
  });

  it("returns null when no origin configured", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: EXIT(1) }]);
    assert.equal(await getRemoteUrl(ctx), null);
  });

  it("returns null on empty stdout", async () => {
    const { ctx } = makeCtx([{ match: () => true, result: OK("\n") }]);
    assert.equal(await getRemoteUrl(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// Shared cwd-routing contract (parameterized across all helpers)
// ---------------------------------------------------------------------------

/**
 * Every helper accepts an optional trailing `cwd` override. When omitted,
 * it routes to `ctx.cwd`; when passed, it routes to the explicit value.
 * These two axes used to live as ad-hoc tests inside each helper's
 * describe block; consolidating here guarantees the contract is uniform
 * and prevents one helper's routing from drifting silently.
 */
const cwdRoutingCases: ReadonlyArray<{
  name: string;
  fixture: ExecResult;
  call: (ctx: PredicateContext, cwd?: string) => Promise<unknown>;
}> = [
  {
    name: "getBranch",
    fixture: OK("main"),
    call: (c, cwd) => getBranch(c, cwd),
  },
  {
    name: "getUpstream",
    fixture: OK("origin/main"),
    call: (c, cwd) => getUpstream(c, cwd),
  },
  {
    name: "getCommitsAhead",
    fixture: OK("0"),
    call: (c, cwd) => getCommitsAhead(c, "origin/main", cwd),
  },
  {
    name: "getStagedChanges",
    fixture: EXIT(0),
    call: (c, cwd) => getStagedChanges(c, cwd),
  },
  {
    name: "getWorkingTreeClean",
    fixture: OK(""),
    call: (c, cwd) => getWorkingTreeClean(c, cwd),
  },
  {
    name: "getRemoteUrl",
    fixture: OK("git@github.com:org/repo.git"),
    call: (c, cwd) => getRemoteUrl(c, cwd),
  },
];

describe("cwd routing (shared across all helpers)", () => {
  for (const { name, fixture, call } of cwdRoutingCases) {
    it(`${name}: routes to ctx.cwd by default (omitted cwd arg)`, async () => {
      const { ctx, execCalls } = makeCtx([
        { match: () => true, result: fixture },
      ]);
      await call(ctx);
      assert.equal(execCalls[0]?.cwd, "/repo");
    });

    it(`${name}: routes to an explicit cwd override when given`, async () => {
      const { ctx, execCalls } = makeCtx([
        { match: () => true, result: fixture },
      ]);
      await call(ctx, "/other");
      assert.equal(execCalls[0]?.cwd, "/other");
    });
  }
});

// ---------------------------------------------------------------------------
// Downstream-composition smoke test
// ---------------------------------------------------------------------------

describe("downstream-composition: iterating per-directory", () => {
  it("per-dir iteration works as a `cr --all`-style multi-package scan", async () => {
    // This is the motivating use case for exporting the helpers:
    // downstream plugins (e.g. RDS) query git state per subpackage
    // dir without re-implementing shell invocations. Pin the shape
    // so future refactors don't accidentally break the contract.
    const perDirUpstreams = new Map<string, string>([
      ["/ws/pkg-a", "origin/main"],
      ["/ws/pkg-b", "origin/feature-x"],
    ]);
    const { ctx, execCalls } = makeCtx([
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: OK(""), // overridden below per-cwd
      },
    ]);
    // Replace exec with a cwd-aware stub.
    ctx.exec = async (cmd, args, opts) => {
      execCalls.push({ cmd, args: [...args], cwd: opts?.cwd });
      if (cmd === "git" && args[0] === "rev-parse") {
        const u = perDirUpstreams.get(opts?.cwd ?? "");
        if (u !== undefined)
          return { stdout: `${u}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 128 };
    };

    const results: Array<{ dir: string; upstream: string | null }> = [];
    for (const dir of ["/ws/pkg-a", "/ws/pkg-b", "/ws/no-git"]) {
      results.push({ dir, upstream: await getUpstream(ctx, dir) });
    }

    assert.deepEqual(results, [
      { dir: "/ws/pkg-a", upstream: "origin/main" },
      { dir: "/ws/pkg-b", upstream: "origin/feature-x" },
      { dir: "/ws/no-git", upstream: null },
    ]);
    // Three calls, one per dir, with the right cwd.
    assert.equal(execCalls.length, 3);
    assert.equal(execCalls[0]?.cwd, "/ws/pkg-a");
    assert.equal(execCalls[1]?.cwd, "/ws/pkg-b");
    assert.equal(execCalls[2]?.cwd, "/ws/no-git");
  });
});
