// SPDX-License-Identifier: MIT
// Part of unbash-walker.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { getBasename, getCommandArgs } from "./resolve.ts";
import { expandWrapperCommands } from "./wrappers.ts";

/** Parse a script, extract + expand wrappers, return commands as "name arg arg" strings. */
function expanded(raw: string): string[] {
  const ast = parseBash(raw);
  const refs = extractAllCommandsFromAST(ast, raw);
  const { commands } = expandWrapperCommands(refs);
  return commands.map((c) => {
    const name = getBasename(c);
    const args = getCommandArgs(c);
    return [name, ...args].join(" ").trim();
  });
}

describe("expandWrapperCommands", () => {
  describe("sh/bash -c", () => {
    it("expands `sh -c 'git push --force'` to include inner command", () => {
      const out = expanded("sh -c 'git push --force'");
      assert.ok(
        out.includes("git push --force"),
        `got: ${JSON.stringify(out)}`,
      );
    });

    it("expands bash -c with multiple chained commands", () => {
      const out = expanded('bash -c "echo hi && rm -rf /"');
      assert.ok(out.includes("echo hi"), `got: ${JSON.stringify(out)}`);
      assert.ok(out.includes("rm -rf /"), `got: ${JSON.stringify(out)}`);
    });

    it("expands zsh -c like sh -c", () => {
      const out = expanded("zsh -c 'ls -la'");
      assert.ok(out.includes("ls -la"), `got: ${JSON.stringify(out)}`);
    });
  });

  describe("sudo / env", () => {
    it("strips sudo and exposes the inner command", () => {
      const out = expanded("sudo rm /tmp/x");
      assert.ok(out.includes("rm /tmp/x"), `got: ${JSON.stringify(out)}`);
    });

    it("strips env and exposes the inner command", () => {
      const out = expanded("env VAR=x cmd a b");
      assert.ok(out.includes("cmd a b"), `got: ${JSON.stringify(out)}`);
    });

    it("handles sudo flags with value args", () => {
      // -u root consumes a value; sub-command starts after it.
      const out = expanded("sudo -u root rm /tmp/x");
      assert.ok(out.includes("rm /tmp/x"), `got: ${JSON.stringify(out)}`);
    });
  });

  describe("xargs / nice / nohup / strace", () => {
    it("expands xargs", () => {
      const out = expanded("xargs -n 1 rm");
      assert.ok(out.includes("rm"), `got: ${JSON.stringify(out)}`);
    });

    it("expands nice", () => {
      const out = expanded("nice -n 10 make build");
      assert.ok(out.includes("make build"), `got: ${JSON.stringify(out)}`);
    });

    it("expands nohup", () => {
      const out = expanded("nohup node server.js");
      assert.ok(out.includes("node server.js"), `got: ${JSON.stringify(out)}`);
    });

    it("expands strace (passthrough with -e value flag)", () => {
      const out = expanded("strace -e trace=open cmd arg1");
      assert.ok(
        out.some((s) => /^cmd arg1/.test(s)),
        `expected a 'cmd arg1' entry; got: ${JSON.stringify(out)}`,
      );
    });
  });

  describe("find -exec / fd -x", () => {
    it("extracts the -exec body from find", () => {
      const out = expanded("find . -exec rm {} \\;");
      assert.ok(
        out.some((s) => s.startsWith("rm")),
        `got: ${JSON.stringify(out)}`,
      );
    });

    it("extracts the -ok body from find (interactive variant of -exec)", () => {
      const out = expanded("find . -ok rm {} \\;");
      assert.ok(
        out.some((s) => s.startsWith("rm")),
        `got: ${JSON.stringify(out)}`,
      );
    });

    it("extracts the -x body from fd", () => {
      const out = expanded("fd . -e ts -x rm");
      assert.ok(
        out.some((s) => s.startsWith("rm")),
        `got: ${JSON.stringify(out)}`,
      );
    });

    it("extracts the --exec body from fd (long form)", () => {
      const out = expanded("fd . --exec rm {}");
      assert.ok(
        out.some((s) => s.startsWith("rm")),
        `got: ${JSON.stringify(out)}`,
      );
    });

    it("extracts the -X body from fd (capital, batch form)", () => {
      const out = expanded("fd . -X rm {}");
      assert.ok(
        out.some((s) => s.startsWith("rm")),
        `got: ${JSON.stringify(out)}`,
      );
    });

    it("extracts the --exec-batch body from fd (long, batch form)", () => {
      const out = expanded("fd . --exec-batch rm {}");
      assert.ok(
        out.some((s) => s.startsWith("rm")),
        `got: ${JSON.stringify(out)}`,
      );
    });
  });

  describe("nested wrappers", () => {
    it("double-expands `sudo sh -c '...'` to at least reveal the inner shell + git", () => {
      const out = expanded("sudo sh -c 'git push --force'");
      // The outer sudo is kept, the inner sh -c is revealed, and the
      // double-expansion bottoms out in a `git`-named command. Note: the
      // passthrough wrapper re-joins args as a space-separated string before
      // reparsing, which loses the original `'git push --force'` quoting —
      // a known pi-guard-inherited limitation. The guardrail still sees
      // enough structure to match on `sh -c` and inner `git`.
      assert.ok(
        out.some((s) => s.startsWith("sh -c")),
        `expected an 'sh -c ...' entry; got: ${JSON.stringify(out)}`,
      );
      assert.ok(
        out.some((s) => s.startsWith("git")),
        `expected a 'git' entry; got: ${JSON.stringify(out)}`,
      );
    });
  });

  describe("edge cases", () => {
    it("leaves non-wrapper commands unchanged", () => {
      const out = expanded("git push --force");
      assert.deepEqual(out, ["git push --force"]);
    });

    it("silently ignores bare `xargs` with no sub-command", () => {
      const out = expanded("xargs");
      assert.deepEqual(out, ["xargs"]);
    });

    it("keeps the original wrapper command in the output (for rule checks)", () => {
      const out = expanded("sudo rm /tmp/x");
      assert.ok(out.includes("sudo rm /tmp/x"), `got: ${JSON.stringify(out)}`);
      assert.ok(out.includes("rm /tmp/x"), `got: ${JSON.stringify(out)}`);
    });
  });

  describe("false-positive regressions", () => {
    it("does not treat `sudo` appearing in an argument as a wrapper", () => {
      // `echo` is not a wrapper; `sudo` is just an arg here. We must not
      // recurse into "sudo rm /tmp/x" and pretend there's a real `rm`.
      const out = expanded("echo sudo rm /tmp/x");
      assert.equal(
        out.length,
        1,
        `expected one command, got: ${JSON.stringify(out)}`,
      );
      assert.ok(
        out[0]?.startsWith("echo"),
        `expected 'echo ...', got: ${JSON.stringify(out)}`,
      );
    });

    it("does not match wrapper names with prefix/suffix variants", () => {
      // `my-sudo-wrapper` contains "sudo" as a substring but is a
      // different executable. Matching must be whole-basename.
      const out = expanded("my-sudo-wrapper arg");
      assert.equal(
        out.length,
        1,
        `expected one command, got: ${JSON.stringify(out)}`,
      );
      assert.ok(
        out[0]?.startsWith("my-sudo-wrapper"),
        `expected 'my-sudo-wrapper ...', got: ${JSON.stringify(out)}`,
      );
    });

    it("does not match `findutils` or similar as `find`", () => {
      const out = expanded("findutils -exec rm {} \\;");
      // Whole-basename match: `findutils` must not trigger find's exec
      // extraction. Single entry in output.
      assert.equal(
        out.length,
        1,
        `expected one command, got: ${JSON.stringify(out)}`,
      );
    });
  });
});
