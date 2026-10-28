// SPDX-License-Identifier: MIT
// Part of pi-steering.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Word } from "@cad0p/unbash-walker";
import { resolveDescriptor } from "../arity.ts";
import type { CLIFlag, PredicateToolInput } from "../schema.ts";
import { commandFromInput, type SteeringCommand } from "./command.ts";
import { getFlagValue, hasEnvAssignment, isInfoOnly } from "./flags.ts";

/** Minimal Word for tests — tests don't exercise the walker, just the facade. */
function W(value: string, text?: string): Word {
  const t = text ?? value;
  return { value, text: t, pos: 0, end: t.length } as Word;
}

/** PredicateWord for facade inputs — the minimal word plus its raw source token. */
function PW(value: string, text?: string) {
  const w = W(value, text);
  return { ...w, rawText: text ?? value };
}

/** Entry helpers. */
function C(...aliases: string[]): CLIFlag {
  return { aliases, takesValue: true };
}
function B(...aliases: string[]): CLIFlag {
  return { aliases, takesValue: false };
}

/** Build a bash-input facade bound via a synthetic table. */
function bashCmd(
  args: ReturnType<typeof PW>[],
  envAssignments?: Word[],
  table?: Record<string, CLIFlag>,
  basename = "mycli",
): SteeringCommand {
  const arity = resolveDescriptor(basename, {
    [basename]: table === undefined ? {} : { flags: table },
  });
  return commandFromInput(
    envAssignments === undefined
      ? { tool: "bash", args }
      : { tool: "bash", args, envAssignments },
    arity,
  );
}

function S(...values: string[]): ReturnType<typeof PW>[] {
  return values.map((v) => PW(v));
}

describe("SteeringCommand.getAllFlagValues", () => {
  it("collects repeated flags in argv order across mixed aliases", () => {
    const cmd = bashCmd(S("-m", "a", "--message", "b"), undefined, {
      m: C("-m", "--message"),
    });
    assert.deepEqual(cmd.getAllFlagValues(C("-m", "--message")), ["a", "b"]);
  });

  it('reads the attached form, including attached-empty as explicit ""', () => {
    const cmd = bashCmd(S("--subject=docs", "--subject="));
    assert.deepEqual(cmd.getAllFlagValues(B("--subject")), ["docs", ""]);
  });

  it("skips separated-empty (no push), unlike attached-empty", () => {
    const cmd = bashCmd(
      [PW("--subject"), PW("", '""'), PW("--subject"), PW("x")],
      undefined,
      { subject: C("--subject") },
    );
    assert.deepEqual(cmd.getAllFlagValues(C("--subject")), ["x"]);
  });

  it("bound glued pin FLIPS from #107: gh -Rfoo presence TRUE via derived glue", () => {
    const cmd = bashCmd(S("-Rc/d"), undefined, {
      repo: C("-R", "--repo"),
    });
    assert.deepEqual(cmd.getAllFlagValues(C("-R")), ["c/d"]);
    assert.equal(cmd.getFlagValue(C("-R")), "c/d");
    assert.equal(cmd.hasFlag(C("-R")), true);
  });

  it("does not decompose an undeclared bundle lead", () => {
    const cmd = bashCmd(S("-vf", "alpine"));
    assert.deepEqual(cmd.getAllFlagValues(B("-f")), []);
  });

  it("trailing valueless occurrence contributes nothing (scalar poisoned to null)", () => {
    const cmd = bashCmd(S("-m", "a", "-m"), undefined, {
      m: C("-m"),
    });
    assert.deepEqual(cmd.getAllFlagValues(C("-m")), ["a"]);
    assert.equal(cmd.getFlagValue(C("-m")), null);
  });

  it("trailing empty-next-token contributes nothing (scalar poisoned to null)", () => {
    const cmd = bashCmd(
      [PW("-m"), PW("a"), PW("-m"), PW("", '""')],
      undefined,
      {
        m: C("-m"),
      },
    );
    assert.deepEqual(cmd.getAllFlagValues(C("-m")), ["a"]);
    assert.equal(cmd.getFlagValue(C("-m")), null);
  });

  it("trailing valueless after attached-empty preserves the explicit empty", () => {
    const cmd = bashCmd(S("--m=", "--m"));
    assert.deepEqual(cmd.getAllFlagValues(B("--m")), [""]);
    assert.equal(cmd.getFlagValue(B("--m")), null);
  });

  it("is quote-aware via .value-first reads", () => {
    const cmd = bashCmd(
      [PW("-m"), PW("conventional: subject", "'conventional: subject'")],
      undefined,
      { m: C("-m") },
    );
    assert.deepEqual(cmd.getAllFlagValues(C("-m")), ["conventional: subject"]);
  });

  it("returns [] on no match and on undefined args", () => {
    assert.deepEqual(bashCmd(S("status")).getAllFlagValues(B("-m")), []);
    assert.deepEqual(
      commandFromInput({ tool: "bash" }).getAllFlagValues(B("-m")),
      [],
    );
  });

  it("last-element invariant holds for well-formed non-trailing-broken inputs", () => {
    const cases: {
      args: ReturnType<typeof PW>[];
      table: Record<string, CLIFlag>;
      query: CLIFlag;
    }[] = [
      { args: S("-m", "a", "-m", "b"), table: { m: C("-m") }, query: C("-m") },
      {
        args: S("-m", "a", "--message", "b"),
        table: { m: C("-m", "--message") },
        query: C("-m", "--message"),
      },
      {
        args: S("--subject=x"),
        table: { s: B("--subject") },
        query: B("--subject"),
      },
      {
        args: S("--subject=", "--subject=y"),
        table: { s: B("--subject") },
        query: B("--subject"),
      },
      { args: S("status"), table: { m: C("-m") }, query: C("-m") },
    ];
    for (const { args, table, query } of cases) {
      const cmd = bashCmd(args, undefined, table);
      const all = cmd.getAllFlagValues(query);
      assert.equal(
        cmd.getFlagValue(query),
        all.length > 0 ? all[all.length - 1] : null,
      );
    }
    // Bound glued words resolve on both sides now.
    const glued = bashCmd(S("-Rc/d", "-Re/f"), undefined, {
      repo: C("-R", "--repo"),
    });
    assert.deepEqual(glued.getAllFlagValues(C("-R")), ["c/d", "e/f"]);
    assert.equal(glued.getFlagValue(C("-R")), "e/f");
  });

  it("commandFromInput(input) omitted-arity ⇒ explicit-strict pin", () => {
    const cmd = commandFromInput({
      tool: "bash",
      args: S("-R", "c/d"),
    });
    assert.equal(cmd.getFlagValue(C("-R", "--repo")), null);
    assert.deepEqual(cmd.getAllFlagValues(C("-R")), []);
    assert.equal(cmd.hasFlag(B("-R")), true);
  });
});

describe("SteeringCommand bound methods take entries only", () => {
  it("string + opts calls fail tsc (@ts-expect-error pins)", () => {
    const cmd = bashCmd(S("-R", "c/d"), undefined, { repo: C("-R") });
    // @ts-expect-error — bound facade takes entries only, never bare strings
    void cmd.hasFlag("-R");
    // @ts-expect-error — bound facade takes entries only, never opts
    void cmd.getFlagValue("-R", { valueConsumingFlags: ["-R"] });
    // @ts-expect-error — bound facade takes entries only, never opts
    void cmd.getAllFlagValues("-R", { valueConsumingFlags: ["-R"] });
  });

  it("binds the descriptor-resolved table; unlisted flags are valueless", () => {
    const cmd = commandFromInput(
      {
        tool: "bash",
        command: "git push --delete origin",
        basename: "git",
        args: [PW("push"), PW("--delete"), PW("origin")],
      } as PredicateToolInput,
      resolveDescriptor("git", {
        git: { flags: { c: C("-C"), cfg: C("-c") } },
      }),
    );
    assert.equal(cmd.hasFlag(B("--delete")), true);
    assert.equal(cmd.getFlagValue(B("--delete")), null);
    assert.deepEqual(cmd.getAllFlagValues(B("--delete")), []);
    assert.deepEqual(cmd.positionals(), ["push", "--delete", "origin"]);
  });

  it("bound-adapter invariant: entries select spellings only", () => {
    // Hand-literal takesValue:true for an UNLISTED spelling consumes
    // nothing on the bound path (scalar null + token kept positional).
    const cmd = bashCmd(S("--evil", "val", "pos"), undefined, {});
    assert.equal(cmd.getFlagValue(C("--evil")), null);
    assert.deepEqual(cmd.getAllFlagValues(C("--evil")), []);
    assert.deepEqual(cmd.positionals(), ["--evil", "val", "pos"]);
    // Passed-entry takesValue:false for a LISTED consumer still consumes.
    const listed = bashCmd(S("--body", "TEXT"), undefined, {
      body: C("--body"),
    });
    assert.equal(listed.getFlagValue(B("--body")), "TEXT");
  });
});

describe("SteeringCommand.positionals (issue #107)", () => {
  it("includes the subcommand run", () => {
    const cmd = bashCmd(S("push", "origin", ":branch"));
    assert.deepEqual(cmd.positionals(), ["push", "origin", ":branch"]);
  });

  it("skips declared-consuming flags + values via the bound descriptor", () => {
    const gh = (args: ReturnType<typeof PW>[]) =>
      bashCmd(args, undefined, { body: C("--body") });
    assert.deepEqual(gh(S("pr", "merge", "--body", "TEXT")).positionals(), [
      "pr",
      "merge",
    ]);
    assert.deepEqual(
      gh(S("pr", "merge", "--frobnicate", "TEXT")).positionals(),
      ["pr", "merge", "--frobnicate", "TEXT"],
    );
  });

  it("push --delete origin keeps both (registry-only pin)", () => {
    const cmd = bashCmd(S("push", "--delete", "origin"));
    assert.equal(cmd.getFlagValue(B("--delete")), null);
    assert.deepEqual(cmd.getAllFlagValues(B("--delete")), []);
    assert.deepEqual(cmd.positionals(), ["push", "--delete", "origin"]);
  });

  it("-- terminates: everything after is positional verbatim", () => {
    assert.deepEqual(bashCmd(S("checkout", "--", ".")).positionals(), [
      "checkout",
      ".",
    ]);
    assert.deepEqual(bashCmd(S("exec", "<pod>", "--", "<cmd>")).positionals(), [
      "exec",
      "<pod>",
      "<cmd>",
    ]);
    assert.deepEqual(bashCmd(S("push", "--", "--force")).positionals(), [
      "push",
      "--force",
    ]);
  });

  it("attached forms never surface", () => {
    assert.deepEqual(bashCmd(S("--subject=x")).positionals(), []);
    assert.deepEqual(
      bashCmd(S("pr", "merge", "--subject=x"), undefined, {
        subject: C("--subject"),
      }).positionals(),
      ["pr", "merge"],
    );
  });

  it("bundles surface zero letters (never decomposed)", () => {
    assert.deepEqual(bashCmd(S("-fdx")).positionals(), []);
    assert.deepEqual(bashCmd(S("clean", "-fdx")).positionals(), ["clean"]);
    assert.deepEqual(bashCmd(S("-vf", "alpine")).positionals(), ["alpine"]);
  });

  it("is quote-aware via .value-first reads", () => {
    assert.deepEqual(
      bashCmd([PW("see --help", '"see --help"')]).positionals(),
      ["see --help"],
    );
    const declared = bashCmd(
      [PW("--body", '"--body"'), PW("TEXT")],
      undefined,
      {
        body: C("--body"),
      },
    );
    assert.deepEqual(declared.positionals(), []);
  });

  it("empty args → []", () => {
    assert.deepEqual(bashCmd([]).positionals(), []);
    assert.deepEqual(commandFromInput({ tool: "bash" }).positionals(), []);
  });

  it("::weird / copy-refspec shapes pass through", () => {
    assert.deepEqual(bashCmd(S("push", "origin", "::weird")).positionals(), [
      "push",
      "origin",
      "::weird",
    ]);
    assert.deepEqual(
      bashCmd(
        S("fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"),
      ).positionals(),
      ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
    );
  });

  it("trailing declared-consuming is skipped", () => {
    assert.deepEqual(
      bashCmd(S("--body"), undefined, { body: C("--body") }).positionals(),
      [],
    );
  });

  it("bare - surfaces (stdin convention)", () => {
    assert.deepEqual(bashCmd(S("-")).positionals(), ["-"]);
  });

  it("snapshots the input (no post-construction leak)", () => {
    const args = [PW("push"), PW("origin")];
    const cmd = commandFromInput({ tool: "bash", args });
    args.push(PW(":branch"));
    assert.deepEqual(cmd.positionals(), ["push", "origin"]);
  });
});

describe("SteeringCommand delegation", () => {
  it("getFlagValue / hasEnvAssignment / isInfoOnly match the bare mechanism; hasFlag is the shared table-derived scan", () => {
    const args = [PW("--profile"), PW("dev"), PW("--profile=prod")];
    const env = [W("AWS_PROFILE=dev")];
    const table = { profile: C("--profile") };
    const cmd = bashCmd(args, env, table);
    // Facade `hasFlag` runs the shared `flagPresenceScan` (issue #123) —
    // the SAME code path as the `when.flag` leaf — not the bare
    // entry-based mechanism, so the two can disagree on bundles and
    // consumed values. On this exact-token fixture they coincide.
    assert.equal(cmd.hasFlag(B("--profile")), true);
    const views = [{ aliases: ["--profile"], takesValue: true }];
    assert.equal(cmd.getFlagValue(C("--profile")), getFlagValue(args, views));
    assert.equal(
      cmd.hasEnvAssignment("AWS_PROFILE"),
      hasEnvAssignment(env, "AWS_PROFILE"),
    );
    assert.equal(cmd.isInfoOnly(), isInfoOnly(args));
  });

  it("hasEnvAssignment is literal-name only", () => {
    const cmd = bashCmd([], [W("AWS_PROFILE=dev")]);
    assert.equal(cmd.hasEnvAssignment("AWS_PROFILE"), true);
    assert.equal(cmd.hasEnvAssignment("AWS"), false);
  });

  it("isInfoOnly honors the default set plus additive extras", () => {
    assert.equal(bashCmd(S("--help")).isInfoOnly(), true);
    assert.equal(bashCmd(S("see --help")).isInfoOnly(), false);
    assert.equal(bashCmd(S("-v")).isInfoOnly(), false);
    assert.equal(bashCmd(S("-v")).isInfoOnly(["-v"]), true);
  });

  it("write-tool input normalizes to the empty facade", () => {
    const cmd = commandFromInput({ tool: "write", path: "x", content: "y" });
    assert.equal(cmd.hasFlag(B("--help")), false);
    assert.equal(cmd.getFlagValue(B("--help")), null);
    assert.deepEqual(cmd.getAllFlagValues(B("--help")), []);
    assert.deepEqual(cmd.positionals(), []);
    assert.equal(cmd.hasEnvAssignment("A"), false);
    assert.equal(cmd.isInfoOnly(), false);
  });
});

describe("commandFromInput totality + COPY", () => {
  it("is total over undefined / null input (no throw, empty facade)", () => {
    for (const bad of [undefined, null] as unknown as PredicateToolInput[]) {
      const cmd = commandFromInput(bad);
      assert.equal(cmd.hasFlag(B("-m")), false);
      assert.equal(cmd.getFlagValue(B("-m")), null);
      assert.deepEqual(cmd.getAllFlagValues(B("-m")), []);
      assert.deepEqual(cmd.positionals(), []);
      assert.equal(cmd.hasEnvAssignment("A"), false);
      assert.equal(cmd.isInfoOnly(), false);
    }
  });

  it("snapshots (COPYs) the caller's arrays — later mutation cannot leak", () => {
    const args = [PW("-m"), PW("a")];
    const env = [W("A=1")];
    const cmd = commandFromInput(
      { tool: "bash", args, envAssignments: env },
      resolveDescriptor("mycli", { mycli: { flags: { m: C("-m") } } }),
    );
    args.push(PW("-m"), PW("b"));
    env.push(W("B=2"));
    assert.deepEqual(cmd.getAllFlagValues(C("-m")), ["a"]);
    assert.equal(cmd.getFlagValue(C("-m")), "a");
    assert.equal(cmd.hasEnvAssignment("B"), false);
    assert.equal(cmd.hasEnvAssignment("A"), true);
  });
});

describe("SteeringCommand.hasFlag derives bundles (issue #123)", () => {
  it("-uf counts for -f (bundled bool shorts are present)", () => {
    const cmd = bashCmd(S("-uf"), undefined, {
      u: B("-u"),
      force: B("-f"),
    });
    assert.equal(cmd.hasFlag({ aliases: ["-f"], takesValue: false }), true);
    assert.equal(cmd.hasFlag({ aliases: ["-u"], takesValue: false }), true);
    assert.equal(cmd.hasFlag({ aliases: ["-x"], takesValue: false }), false);
  });

  it("sees bundled bool shorts (-Rf counts for -R and -f)", () => {
    const cmd = bashCmd(S("-Rf"), undefined, {
      recursive: { aliases: ["-r", "-R", "--recursive"], takesValue: false },
      force: { aliases: ["-f", "--force"], takesValue: false },
    });
    assert.equal(cmd.hasFlag({ aliases: ["-R"], takesValue: false }), true);
    assert.equal(cmd.hasFlag({ aliases: ["-f"], takesValue: false }), true);
    assert.equal(cmd.hasFlag({ aliases: ["-x"], takesValue: false }), false);
  });

  it("truncates at table glue (-Rfoo counts R, never f)", () => {
    const cmd = bashCmd(S("-Rfoo"), undefined, {
      repo: { aliases: ["-R"], takesValue: true },
    });
    assert.equal(cmd.hasFlag({ aliases: ["-R"], takesValue: false }), true);
    assert.equal(cmd.hasFlag({ aliases: ["-f"], takesValue: false }), false);
  });

  it("keeps the non-glued prefix present (-xRfoo counts x and R, never f)", () => {
    const cmd = bashCmd(S("-xRfoo"), undefined, {
      xray: B("-x"),
      repo: { aliases: ["-R"], takesValue: true },
    });
    assert.equal(cmd.hasFlag(B("-x")), true);
    assert.equal(cmd.hasFlag({ aliases: ["-R"], takesValue: false }), true);
    assert.equal(cmd.hasFlag({ aliases: ["-f"], takesValue: false }), false);
  });

  it("skips declared consuming-flag values by position", () => {
    const cmd = bashCmd(S("-m", "-f"), undefined, {
      m: C("-m"),
      force: B("-f"),
    });
    // `-f` is `-m`'s value here, not a flag — position-skipped.
    assert.equal(cmd.hasFlag(B("-f")), false);
    // The consuming flag itself IS present.
    assert.equal(cmd.hasFlag(B("-m")), true);
  });

  it("longs never bundle-match", () => {
    const cmd = bashCmd(S("--force"), undefined, {
      force: { aliases: ["-f", "--force"], takesValue: false },
    });
    assert.equal(
      cmd.hasFlag({ aliases: ["--force"], takesValue: false }),
      true,
    );
    assert.equal(cmd.hasFlag({ aliases: ["-f"], takesValue: false }), false);
  });

  it("still matches exact and attached forms", () => {
    const cmd = bashCmd(S("--force", "--mirror=x"), undefined, {
      force: { aliases: ["--force"], takesValue: false },
      mirror: { aliases: ["--mirror"], takesValue: false },
    });
    assert.equal(
      cmd.hasFlag({ aliases: ["--force"], takesValue: false }),
      true,
    );
    assert.equal(
      cmd.hasFlag({ aliases: ["--mirror"], takesValue: false }),
      true,
    );
  });

  it("malformed spellings select nothing (leaf fail-skip parity)", () => {
    const cmd = bashCmd(S("-foo"), undefined, {});
    assert.equal(cmd.hasFlag({ aliases: ["-foo"], takesValue: false }), false);
  });
});
