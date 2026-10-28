// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Unit tests for `bodyHasClosingKeyword`. It execs the pinned perl
 * one-liner through a stubbed exec.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { PredicateContext, PredicateWord } from "@cad0p/pi-steering";
import { mockContext } from "@cad0p/pi-steering/testing";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
import { bodyHasClosingKeyword } from "./body-keyword.ts";
import { BODY_STRIP } from "./body-strip.ts";

// ---------------------------------------------------------------------------
// Test scaffolding: hand-built ctx
// ---------------------------------------------------------------------------

type ExecStub = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Hand-built predicate ctx. `args` are walker words in `{ text }`
 * form (the shape `argText` reads); `exec` defaults to a stub that
 * answers `perl -0777 -pe <BODY_STRIP> <file>` by reading the
 * file and stripping its frontmatter with the SAME pinned program
 * semantics (a JS mirror used only to keep these tests hermetic —
 * the real behavior is pinned by `body-strip.test.ts`, which
 * spawns actual perl). `env` seeds the walker's tracked env at the
 * command ref (tilde expansion reads it first, falling back to
 * `process.env` when absent).
 */
function makeCtx(
  args: readonly { text: string }[],
  cwd: string,
  exec?: ExecStub,
  env?: ReadonlyMap<string, string>,
): PredicateContext {
  // mockContext binds the `ctx.command` facade through the owned gh
  // descriptor (the inline `--body` fallback reads via the facade
  // now); `"…"` words unwrap to their resolved value, exactly as
  // the walker reports them.
  const words: PredicateWord[] = args.map(({ text }) => {
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      const value = text.slice(1, -1);
      return { value, text, rawText: text, pos: 0, end: text.length };
    }
    return { value: text, text, rawText: text, pos: 0, end: text.length };
  });
  return mockContext({
    cwd,
    input: {
      tool: "bash",
      command: "gh pr create",
      basename: "gh",
      args: words,
    },
    descriptors: { gh: GH_CLI_DESCRIPTOR },
    exec:
      exec ??
      (async (_cmd, _args) => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
    ...(env !== undefined ? { walkerState: { cwd, env } } : {}),
  });
}

/** The pinned substitution form the rules require. */
function stripSubstitution(file: string): string {
  return `<(perl -0777 -pe '${BODY_STRIP}' ${file})`;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A home dir holding a keyword-bearing direct file at `~/Goldmine/note.md`. */
function makeHomeWithDirectNote(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "github-plugin-kw-home-"));
  fixtures.push(home);
  const note = join(home, "Goldmine", "note.md");
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, "Closes #12\n\nDirect body.\n");
  const cwd = mkdtempSync(join(tmpdir(), "github-plugin-kw-cwd-"));
  fixtures.push(cwd);
  return { home, cwd };
}

describe("bodyHasClosingKeyword", () => {
  /** Exec stub that answers the pinned perl call with stripped content. */
  function perlExec(bodyAfterFrontmatter: string): ExecStub {
    return async (cmd, args: readonly string[]) => {
      if (cmd === "perl" && args[0] === "-0777" && args[1] === "-pe") {
        assert.equal(args[2], BODY_STRIP, "pinned program must be used");
        return {
          stdout: bodyAfterFrontmatter,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
  }

  it("is true when the STRIPPED body (perl output) has the keyword", async () => {
    const ctx = makeCtx(
      [{ text: "--body-file" }, { text: stripSubstitution("/vault/note.md") }],
      "/work/repo",
      perlExec("Closes #12\n\nBody.\n"),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), true);
  });

  it("is false when the keyword ONLY appears in frontmatter (stripped input is canonical)", async () => {
    const ctx = makeCtx(
      [{ text: "--body-file" }, { text: stripSubstitution("/vault/note.md") }],
      "/work/repo",
      perlExec("No keyword here.\n"),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), false);
  });

  it("is false when perl fails (fail-closed)", async () => {
    const failing: ExecStub = async () => ({
      stdout: "",
      stderr: "perl error",
      exitCode: 2,
    });
    const ctx = makeCtx(
      [{ text: "--body-file" }, { text: stripSubstitution("/vault/note.md") }],
      "/work/repo",
      failing,
    );
    assert.equal(await bodyHasClosingKeyword(ctx), false);
  });

  it("is false for an unparsable --body-file value (fail-closed)", async () => {
    const ctx = makeCtx(
      [{ text: "--body-file" }, { text: "<(cat /vault/note.md)" }],
      "/work/repo",
      perlExec("Closes #12\n"),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), false);
  });

  it("falls back to the inline --body text", async () => {
    const ctx = makeCtx(
      [{ text: "--body" }, { text: "Fixes #7" }],
      "/work/repo",
    );
    assert.equal(await bodyHasClosingKeyword(ctx), true);
  });

  it("is false for a missing body (fail-closed)", async () => {
    const ctx = makeCtx([{ text: "--title" }, { text: "x" }], "/work/repo");
    assert.equal(await bodyHasClosingKeyword(ctx), false);
  });

  it("hands perl the expanded path for a bare ~/… file", async () => {
    // `ctx.exec` bypasses the shell, so the helper replicates the
    // shell handoff: the pinned perl receives what bash would hand
    // it. The stub asserts the file arg is the expanded path.
    const seen: string[] = [];
    const exec: ExecStub = async (cmd, args: readonly string[]) => {
      if (cmd === "perl") seen.push(args[3] ?? "");
      return { stdout: "Closes #12\n", stderr: "", exitCode: 0 };
    };
    const ctx = makeCtx(
      [
        { text: "--body-file" },
        { text: stripSubstitution("~/Goldmine/note.md") },
      ],
      "/work/repo",
      exec,
      new Map([["HOME", "/home/u"]]),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), true);
    assert.deepEqual(seen, ["/home/u/Goldmine/note.md"]);
  });

  it('hands perl the literal path for a quoted "~/…" file', async () => {
    // Bash-exact: the quoted tilde stays literal — perl receives
    // `~/…` verbatim (and would fail to open it, fail-closed).
    const seen: string[] = [];
    const exec: ExecStub = async (cmd, args: readonly string[]) => {
      if (cmd === "perl") seen.push(args[3] ?? "");
      return { stdout: "Closes #12\n", stderr: "", exitCode: 0 };
    };
    const ctx = makeCtx(
      [
        { text: "--body-file" },
        { text: stripSubstitution('"~/Goldmine/note.md"') },
      ],
      "/work/repo",
      exec,
      new Map([["HOME", "/home/u"]]),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), true);
    assert.deepEqual(seen, ["~/Goldmine/note.md"]);
  });

  it("reads an unquoted direct ~/… path through expansion", async () => {
    // Control for the pin below: the bare direct word expands and
    // the keyword is found.
    const { home, cwd } = makeHomeWithDirectNote();
    const ctx = makeCtx(
      [{ text: "--body-file" }, { text: "~/Goldmine/note.md" }],
      cwd,
      perlExec("unused\n"),
      new Map([["HOME", home]]),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), true);
  });

  it('reads a quoted direct "~/…" path literally (never expands)', async () => {
    // The shell leaves a quoted leading `~` alone — expanding it
    // here would read the home file and flip a BLOCK into an ALLOW.
    // The literal `~/…` joins onto the cwd, misses, and fails closed.
    const { home, cwd } = makeHomeWithDirectNote();
    const ctx = makeCtx(
      [{ text: "--body-file" }, { text: '"~/Goldmine/note.md"' }],
      cwd,
      perlExec("unused\n"),
      new Map([["HOME", home]]),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), false);
  });

  it("is false for ~/… when HOME is unknown (fail-closed)", async () => {
    const ctx = makeCtx(
      [
        { text: "--body-file" },
        { text: stripSubstitution("~/Goldmine/note.md") },
      ],
      "/work/repo",
      perlExec("Closes #12\n"),
      new Map(),
    );
    assert.equal(await bodyHasClosingKeyword(ctx), false);
  });
});
