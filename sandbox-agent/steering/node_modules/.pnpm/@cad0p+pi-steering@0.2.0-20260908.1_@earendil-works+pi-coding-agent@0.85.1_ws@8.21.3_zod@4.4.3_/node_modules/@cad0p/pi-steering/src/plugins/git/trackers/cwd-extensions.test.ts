// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's cwd tracker extension
 * (`./cwd-extensions.ts`).
 *
 * These tests walk scripts against a MANUALLY composed cwd tracker -
 * the core `cwdTracker` with the plugin's `gitCwdExtensions` appended
 * under basename `git`. This mirrors exactly what the plugin merger
 * produces at runtime, without pulling the merger into every test.
 * See `./integration.test.ts` for end-to-end behavior through the
 * evaluator.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CommandRef,
  cwdTracker,
  extractAllCommandsFromAST,
  getBasename,
  getCommandArgs,
  type Modifier,
  parse as parseBash,
  type Tracker,
  walk,
} from "@cad0p/unbash-walker";
import { gitCwdExtensions } from "./cwd-extensions.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build a cwd tracker with the plugin's extensions appended to the
 * core `git` basename slot. The same shape the plugin merger produces
 * at runtime via `composeTracker`.
 */
function composeCwdWithExtensions(): Tracker<string> {
  const existing = cwdTracker.modifiers["git"];
  const existingList: Modifier<string>[] = Array.isArray(existing)
    ? ([...existing] as Modifier<string>[])
    : existing !== undefined
      ? [existing as Modifier<string>]
      : [];
  return {
    ...cwdTracker,
    modifiers: {
      ...cwdTracker.modifiers,
      git: [
        ...existingList,
        ...(gitCwdExtensions as readonly Modifier<string>[]),
      ],
    },
  };
}

interface WalkedCommand {
  ref: CommandRef;
  text: string;
  cwd: string;
}

function walkCwd(script: string, initialCwd = "/initial"): WalkedCommand[] {
  const tracker = composeCwdWithExtensions();
  const ast = parseBash(script);
  const refs = extractAllCommandsFromAST(ast, script);
  const result = walk(ast, { cwd: initialCwd }, { cwd: tracker }, refs);
  return refs.map((ref) => {
    const snap = result.get(ref);
    return {
      ref,
      text: `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim(),
      cwd: (snap?.cwd as string | undefined) ?? "<missing>",
    };
  });
}

function cwdOf(walked: WalkedCommand[], prefix: string): string {
  const hit = walked.find((w) => w.text.startsWith(prefix));
  if (!hit) {
    throw new Error(
      `no command starting with "${prefix}" in walked set: ` +
        walked.map((w) => w.text).join(" | "),
    );
  }
  return hit.cwd;
}

// ---------------------------------------------------------------------------
// --git-dir=
// ---------------------------------------------------------------------------

describe("gitCwdExtensions: --git-dir=PATH", () => {
  it("absolute path replaces the effective cwd", () => {
    const walked = walkCwd("git --git-dir=/b status");
    assert.equal(cwdOf(walked, "git --git-dir"), "/b");
  });

  it("relative path joins against the current cwd", () => {
    const walked = walkCwd("git --git-dir=subrepo status", "/work");
    assert.equal(cwdOf(walked, "git --git-dir"), "/work/subrepo");
  });

  it("per-command semantics - does not propagate to the next command", () => {
    // Per-command scope: the modifier applies to THIS command only.
    // The next sibling command sees the pre-modifier cwd.
    const walked = walkCwd("git --git-dir=/b status && git log", "/initial");
    assert.equal(cwdOf(walked, "git --git-dir"), "/b");
    assert.equal(cwdOf(walked, "git log"), "/initial");
  });

  it("non-static target collapses cwd to unknown", () => {
    // `--git-dir=$V` - the overall Word is non-static via
    // SimpleExpansion. Extension returns undefined; walker emits
    // the cwd tracker's `"unknown"` sentinel.
    const walked = walkCwd("git --git-dir=$V status");
    assert.equal(cwdOf(walked, "git --git-dir"), "unknown");
  });
});

// ---------------------------------------------------------------------------
// --work-tree=
// ---------------------------------------------------------------------------

describe("gitCwdExtensions: --work-tree=PATH", () => {
  it("absolute path replaces the effective cwd", () => {
    const walked = walkCwd("git --work-tree=/c status");
    assert.equal(cwdOf(walked, "git --work-tree"), "/c");
  });

  it("relative path joins against the current cwd", () => {
    const walked = walkCwd("git --work-tree=tree status", "/repo");
    assert.equal(cwdOf(walked, "git --work-tree"), "/repo/tree");
  });

  it("`git --work-tree=$V status` collapses cwd to unknown", () => {
    const walked = walkCwd("git --work-tree=$V status");
    assert.equal(cwdOf(walked, "git --work-tree"), "unknown");
  });

  it("`--work-tree=/t` is per-command (doesn't propagate)", () => {
    const walked = walkCwd("git --work-tree=/t status && git log", "/initial");
    assert.equal(cwdOf(walked, "git --work-tree"), "/t");
    assert.equal(cwdOf(walked, "git log"), "/initial");
  });

  it("multiple --git-dir= / --work-tree= flags compose (last absolute wins)", () => {
    const walked = walkCwd("git --git-dir=/a --work-tree=/b status");
    assert.equal(cwdOf(walked, "git --git-dir"), "/b");
  });
});

// ---------------------------------------------------------------------------
// Composition with the core `-C` modifier
// ---------------------------------------------------------------------------

describe("gitCwdExtensions: composition with core -C", () => {
  // Pins the "extension wins" precedence. The walker runs per-command
  // modifiers left-to-right; the plugin merger registers the extension
  // AFTER the core modifier, so the extension's value is applied last.
  // This matches git's documented precedence for --git-dir / --work-tree
  // over -C.
  it("`git -C /a --git-dir=/b status` -> /b (extension wins on absolute)", () => {
    const walked = walkCwd("git -C /a --git-dir=/b status");
    assert.equal(cwdOf(walked, "git -C"), "/b");
  });

  it("`git --git-dir=/b -C /a status` -> /b (same verdict regardless of source order)", () => {
    // Token order in the source doesn't change the modifier
    // composition order - that's determined by registration in the
    // plugin merger. Both orders produce the same final cwd here.
    const walked = walkCwd("git --git-dir=/b -C /a status");
    assert.equal(cwdOf(walked, "git --git-dir"), "/b");
  });

  it("`git -C /a --git-dir=b status` -> /a/b (extension joins relative against -C result)", () => {
    // The extension's modifier runs SECOND with the core modifier's
    // output (/a) as its running cwd. A relative --git-dir joins
    // against that, producing /a/b.
    const walked = walkCwd("git -C /a --git-dir=b status");
    assert.equal(cwdOf(walked, "git -C"), "/a/b");
  });

  it("`git -C /a status` (no extension flag) still routes through the core -C", () => {
    // Regression guard: adding the extension must not disturb
    // bare `-C` behavior.
    const walked = walkCwd("git -C /a status");
    assert.equal(cwdOf(walked, "git -C"), "/a");
  });
});

// ---------------------------------------------------------------------------
// Non-interference
// ---------------------------------------------------------------------------

describe("gitCwdExtensions: non-interference", () => {
  it("`git status` (no cwd flags) preserves the current cwd", () => {
    const walked = walkCwd("git status", "/work");
    assert.equal(cwdOf(walked, "git status"), "/work");
  });

  it("`git log --grep='--git-dir=foo'` does NOT match inside a quoted arg", () => {
    // The grep value is a SINGLE token whose text starts with
    // `--grep=`, not `--git-dir=`. Regression guard against the
    // naive scan-all-args trap.
    const walked = walkCwd("git log --grep='--git-dir=foo'", "/initial");
    assert.equal(cwdOf(walked, "git log"), "/initial");
  });
});

// ---------------------------------------------------------------------------
// Accepted false-positives
// ---------------------------------------------------------------------------

describe("cwd extensions: accepted false-positives", () => {
  it("`git log --git-dir=/repo` over-matches (post-subcommand flag)", () => {
    // Documented accepted false-positive: we scan all args; real git
    // treats post-subcommand --git-dir= as a pathspec. Over-match rate
    // is low; stopping at subcommand would break -C composition.
    const walked = walkCwd("git log --git-dir=/repo", "/start");
    assert.equal(cwdOf(walked, "git log"), "/repo");
  });

  it("`git diff -- --git-dir=/x` over-matches (after `--` should be pathspec)", () => {
    const walked = walkCwd("git diff -- --git-dir=/x", "/start");
    assert.equal(cwdOf(walked, "git diff"), "/x");
  });
});
