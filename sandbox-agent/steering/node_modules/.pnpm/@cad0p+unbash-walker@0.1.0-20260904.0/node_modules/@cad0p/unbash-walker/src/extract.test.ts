// SPDX-License-Identifier: MIT
// Part of unbash-walker.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { getBasename, getCommandArgs, getCommandName } from "./resolve.ts";
import type { CommandRef } from "./types.ts";

/** Strip source/node for deepEqual assertions that only care about name/args. */
function summarize(raw: string): Array<{ name: string; args: string[] }> {
  return extractAllCommandsFromAST(parseBash(raw), raw).map((cmd) => ({
    name: getCommandName(cmd),
    args: getCommandArgs(cmd),
  }));
}

describe("extractAllCommandsFromAST", () => {
  it("extracts a simple command", () => {
    assert.deepEqual(summarize("ls -la"), [{ name: "ls", args: ["-la"] }]);
  });

  it("extracts multiple commands from AndOr (&&)", () => {
    assert.deepEqual(summarize("git commit -m 'foo' && git push"), [
      { name: "git", args: ["commit", "-m", "foo"] },
      { name: "git", args: ["push"] },
    ]);
  });

  it("extracts commands from pipes (|)", () => {
    assert.deepEqual(summarize("cat file.txt | grep 'foo' | wc -l"), [
      { name: "cat", args: ["file.txt"] },
      { name: "grep", args: ["foo"] },
      { name: "wc", args: ["-l"] },
    ]);
  });

  it("extracts commands from $() command substitution", () => {
    assert.deepEqual(summarize("echo $(git status)"), [
      { name: "echo", args: ["$(git status)"] },
      { name: "git", args: ["status"] },
    ]);
  });

  it("extracts commands from backtick substitution", () => {
    assert.deepEqual(summarize("FOO=`rm -rf /` node app.js"), [
      { name: "node", args: ["app.js"] },
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  it("extracts from nested subshells", () => {
    assert.deepEqual(
      summarize(
        "echo $(cat file.txt | grep $(rm -rf /)) && curl http://evil.com",
      ),
      [
        { name: "echo", args: ["$(cat file.txt | grep $(rm -rf /))"] },
        { name: "cat", args: ["file.txt"] },
        { name: "grep", args: ["$(rm -rf /)"] },
        { name: "rm", args: ["-rf", "/"] },
        { name: "curl", args: ["http://evil.com"] },
      ],
    );
  });

  it("extracts commands from subshell grouping", () => {
    assert.deepEqual(summarize("(rm -rf /; echo done)"), [
      { name: "rm", args: ["-rf", "/"] },
      { name: "echo", args: ["done"] },
    ]);
  });

  it("extracts commands from if/then/else", () => {
    assert.deepEqual(summarize("if true; then rm -rf /; else echo safe; fi"), [
      { name: "true", args: [] },
      { name: "rm", args: ["-rf", "/"] },
      { name: "echo", args: ["safe"] },
    ]);
  });

  it("tags every CommandRef with a numeric group id", () => {
    const refs = extractAllCommandsFromAST(parseBash("a && b"), "a && b");
    assert.equal(refs.length, 2);
    for (const ref of refs) assert.equal(typeof ref.group, "number");
  });

  it("tags chained commands with joiners ('&&', '||', ';', '|')", () => {
    const refs = extractAllCommandsFromAST(
      parseBash("a && b || c ; d | e"),
      "a && b || c ; d | e",
    );
    // a, b, c, d, e — last in each connected chain has no joiner
    const joiners = refs.map((r: CommandRef) => r.joiner);
    // Expected: a→&&, b→||, c→;, d→|, e→undefined
    assert.deepEqual(joiners, ["&&", "||", ";", "|", undefined]);
  });

  it("returns empty list for empty script", () => {
    assert.deepEqual(summarize(""), []);
  });

  it("handles bare assignments (TOKEN=$(...))", () => {
    // Bare assignments show up as commands with no name but a prefix.
    const refs = extractAllCommandsFromAST(
      parseBash("TOKEN=$(curl https://example.com)"),
      "TOKEN=$(curl https://example.com)",
    );
    // First command is the assignment itself (prefix present, no name).
    // Second is curl (inside the $(...)).
    const names = refs.map((r) => getBasename(r));
    assert.ok(names.includes("TOKEN"));
    assert.ok(names.includes("curl"));
  });
});
