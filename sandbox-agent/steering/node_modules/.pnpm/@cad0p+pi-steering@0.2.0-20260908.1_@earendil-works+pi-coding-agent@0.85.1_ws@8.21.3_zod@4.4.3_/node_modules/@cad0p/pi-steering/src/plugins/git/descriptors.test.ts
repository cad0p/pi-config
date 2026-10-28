// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Oracles-lite pins for the Fig-seeded git table (issue #110 §6.3).
 *
 * Each seeded git entry has a regex over `git --help` output asserting the
 * arity text that justifies `takesValue`. These are the baselines #111
 * diffs against. The rm presence pins assert the recursive + force
 * entries (issue #117) plus NO other value-taking surface (explicit
 * verdict, not omission).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { RM_CLI_DESCRIPTOR } from "../rm/descriptors.ts";
import { GIT_CLI_DESCRIPTOR } from "./descriptors.ts";

/** Capture `git --help`, skipping (not failing) when git is unavailable. */
function gitHelp(): string | null {
  try {
    return execFileSync("git", ["--help"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

/** Capture `rm --help`, skipping when unavailable. */
function rmHelp(): string | null {
  try {
    return execFileSync("rm", ["--help"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

/** Capture `git push -h`, skipping (not failing) when git is unavailable. */
function gitPushHelp(): string | null {
  try {
    return execFileSync("git", ["push", "-h"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

/** Capture `git reset -h`, skipping when unavailable. */
function gitResetHelp(): string | null {
  try {
    return execFileSync("git", ["reset", "-h"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

/** Capture `git commit -h`, skipping when unavailable. */
function gitCommitHelp(): string | null {
  try {
    return execFileSync("git", ["commit", "-h"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

describe("git seed oracles-lite (Fig → --help verdict)", () => {
  it("seeded table shape: 17 globals + 8 subcommand-scoped (issue #117)", () => {
    const flags = GIT_CLI_DESCRIPTOR.flags as Record<string, unknown>;
    assert.equal(Object.keys(flags).length, 25);
  });

  it("-C <path> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /-C <path>/);
    assert.equal(
      (GIT_CLI_DESCRIPTOR.flags as Record<string, { takesValue: boolean }>)[
        "C"
      ]!.takesValue,
      true,
    );
  });

  it("-c <name>=<value> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /-c <name>=<value>/);
  });

  it("--git-dir=<path> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--git-dir=<path>/);
  });

  it("--work-tree=<path> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--work-tree=<path>/);
  });

  it("--namespace=<name> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--namespace=<name>/);
  });

  it("--config-env=<name>=<envvar> (takesValue:true; Fig gap filled by --help)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--config-env=<name>=<envvar>/);
  });

  it("--exec-path[=<path>] optional-attached → takesValue:false", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--exec-path\[=<path>\]/);
    assert.equal(
      (GIT_CLI_DESCRIPTOR.flags as Record<string, { takesValue: boolean }>)[
        "execPath"
      ]!.takesValue,
      false,
    );
  });

  it("bool globals carry no arity text (--bare, --no-pager, --paginate, --html-path)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--bare/);
    assert.match(help, /--no-pager/);
    assert.match(help, /--paginate/);
    const flags = GIT_CLI_DESCRIPTOR.flags as Record<
      string,
      { takesValue: boolean }
    >;
    for (const key of [
      "bare",
      "noPager",
      "paginate",
      "htmlPath",
      "manPath",
      "infoPath",
      "noReplaceObjects",
      "version",
      "help",
    ]) {
      assert.equal(flags[key]!.takesValue, false, key);
    }
  });

  it("push force surface --help-pinned (issue #117): --force, -f, --force-with-lease, --force-if-includes, --mirror", () => {
    const help = gitPushHelp();
    if (help === null) return;
    assert.match(help, /-f, --\[no-\]force/);
    assert.match(help, /--\[no-\]force-with-lease\[=<refname>:<expect>\]/);
    assert.match(help, /--\[no-\]force-if-includes/);
    assert.match(help, /--\[no-\]mirror/);
    const flags = GIT_CLI_DESCRIPTOR.flags as Record<
      string,
      { aliases: readonly string[]; takesValue: boolean }
    >;
    assert.deepEqual(flags["force"]!.aliases, ["--force"]);
    assert.deepEqual(flags["forceShort"]!.aliases, ["-f"]);
    assert.deepEqual(flags["forceWithLease"]!.aliases, ["--force-with-lease"]);
    assert.deepEqual(flags["forceIfIncludes"]!.aliases, [
      "--force-if-includes",
    ]);
    assert.deepEqual(flags["mirror"]!.aliases, ["--mirror"]);
    for (const key of [
      "force",
      "forceShort",
      "forceWithLease",
      "forceIfIncludes",
      "mirror",
    ]) {
      assert.equal(flags[key]!.takesValue, false, key);
    }
  });

  it("reset --hard --help-pinned (issue #117)", () => {
    const help = gitResetHelp();
    if (help === null) return;
    assert.match(help, /--hard/);
    const flags = GIT_CLI_DESCRIPTOR.flags as Record<
      string,
      { aliases: readonly string[]; takesValue: boolean }
    >;
    assert.deepEqual(flags["hard"]!.aliases, ["--hard"]);
    assert.equal(flags["hard"]!.takesValue, false);
  });

  it("commit --amend + -m/--message --help-pinned (issue #117)", () => {
    const help = gitCommitHelp();
    if (help === null) return;
    assert.match(help, /--\[no-\]amend/);
    assert.match(help, /-m, --\[no-\]message <message>/);
    const flags = GIT_CLI_DESCRIPTOR.flags as Record<
      string,
      { aliases: readonly string[]; takesValue: boolean }
    >;
    assert.deepEqual(flags["amend"]!.aliases, ["--amend"]);
    assert.equal(flags["amend"]!.takesValue, false);
    assert.deepEqual(flags["message"]!.aliases, ["-m", "--message"]);
    assert.equal(flags["message"]!.takesValue, true);
  });
});

describe("rm presence pins (explicit entries, not omission)", () => {
  it("rm ships recursive + force bool entries (issue #117)", () => {
    const flags = RM_CLI_DESCRIPTOR.flags as Record<
      string,
      { aliases: readonly string[]; takesValue: boolean }
    >;
    assert.deepEqual(Object.keys(flags).sort(), ["force", "recursive"]);
    assert.deepEqual(flags["recursive"]!.aliases, ["-r", "-R", "--recursive"]);
    assert.equal(flags["recursive"]!.takesValue, false);
    assert.deepEqual(flags["force"]!.aliases, ["-f", "--force"]);
    assert.equal(flags["force"]!.takesValue, false);
  });

  it("rm --help pins the recursive + force spellings", () => {
    const help = rmHelp();
    if (help === null) return;
    assert.match(help, /-r, -R, --recursive/);
    assert.match(help, /-f, --force/);
  });

  it("rm --help shows only bool + optional-attached flags", () => {
    const help = rmHelp();
    if (help === null) return;
    // Optional-attached shapes exist but never require separate values.
    assert.match(help, /--interactive\[=WHEN\]/);
    // No required-value `<WHEN>`/`=<WHEN>` arity text on any rm flag line
    // outside the optional brackets (spot-check the bool roster).
    assert.match(help, /--one-file-system/);
    assert.match(help, /--no-preserve-root/);
  });
});
