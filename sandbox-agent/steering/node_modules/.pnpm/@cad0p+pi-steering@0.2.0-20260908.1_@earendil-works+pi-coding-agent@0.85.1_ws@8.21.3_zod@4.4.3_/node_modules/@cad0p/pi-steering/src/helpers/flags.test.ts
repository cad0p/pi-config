// SPDX-License-Identifier: MIT
// Part of pi-steering.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Word } from "@cad0p/unbash-walker";
import type {
  CLIFlag as RootCLIFlag,
  SteeringCommand as RootSteeringCommand,
} from "../index.ts";
import type { CLIFlag, PredicateWord } from "../schema.ts";
import {
  getAllFlagValues,
  getFlagValue,
  hasEnvAssignment,
  hasFlag,
  INFO_FLAGS,
  isInfoOnly,
  isValueConsuming,
} from "./flags.ts";

/** Minimal Word for tests — tests don't exercise the walker, just the helpers. */
function W(value: string): Word {
  return { value, text: value, pos: 0, end: value.length } as Word;
}

/** PredicateWord for facade inputs — the minimal word plus its raw source token. */
function PW(value: string): PredicateWord {
  return { ...W(value), rawText: value };
}

/** Entry helpers: single-spelling consumer / bool; alias-set forms. */
function C(...aliases: string[]): CLIFlag {
  return { aliases, takesValue: true };
}
function B(...aliases: string[]): CLIFlag {
  return { aliases, takesValue: false };
}

describe("hasFlag", () => {
  it("finds bare flag", () => {
    assert.equal(hasFlag([W("--profile"), W("dev")], B("--profile")), true);
  });

  it("finds attached-value flag", () => {
    assert.equal(hasFlag([W("--profile=dev")], B("--profile")), true);
  });

  it("does not confuse prefix collisions (--profile-foo vs --profile)", () => {
    assert.equal(hasFlag([W("--profile-foo")], B("--profile")), false);
  });

  it("handles empty args", () => {
    assert.equal(hasFlag([], B("--profile")), false);
  });

  it("handles undefined args", () => {
    assert.equal(hasFlag(undefined, B("--profile")), false);
  });

  it("finds short flag", () => {
    assert.equal(hasFlag([W("-p"), W("dev")], B("-p")), true);
  });

  it("does not match flag appearing as a positional value", () => {
    assert.equal(
      hasFlag(
        [W("--profile-unrelated"), W("--profile"), W("dev")],
        B("--profile"),
      ),
      true,
    );
  });

  it("entry-queries OR aliases identically to alias sets", () => {
    // Single entry with both spellings ORs at every position.
    const entry = C("-t", "--subject");
    assert.equal(hasFlag([W("--subject"), W("x")], entry), true);
    assert.equal(hasFlag([W("-t"), W("x")], entry), true);
    assert.equal(hasFlag([W("--other"), W("x")], entry), false);
  });
});

describe("getFlagValue", () => {
  it("returns value for separated form", () => {
    assert.equal(
      getFlagValue([W("--profile"), W("dev")], C("--profile")),
      "dev",
    );
  });

  it("returns value for attached form", () => {
    assert.equal(getFlagValue([W("--profile=dev")], B("--profile")), "dev");
  });

  it("returns empty-string attached form as ''", () => {
    assert.equal(getFlagValue([W("--profile=")], B("--profile")), "");
    assert.equal(getFlagValue([W("--subject=")], B("--subject")), "");
  });

  it("returns null when flag is trailing (no value)", () => {
    assert.equal(getFlagValue([W("--profile")], B("--profile")), null);
  });

  it("issue #12 repro: last alias occurrence wins (--subject after -t)", () => {
    assert.equal(
      getFlagValue(
        [W("-t"), W("see #13"), W("--subject"), W("closes #12")],
        C("-t", "--subject"),
      ),
      "closes #12",
    );
  });

  it("issue #12 repro reversed: -t after --subject wins", () => {
    assert.equal(
      getFlagValue(
        [W("--subject"), W("closes #12"), W("-t"), W("see #13")],
        C("-t", "--subject"),
      ),
      "see #13",
    );
  });

  it("repeated same flag: last occurrence wins", () => {
    assert.equal(
      getFlagValue(
        [W("--profile"), W("a"), W("--profile"), W("b")],
        C("--profile"),
      ),
      "b",
    );
  });

  it("finds an attached form during the reverse scan", () => {
    // Undeclared `-t` is skipped (strict-always), so the earlier
    // attached `--subject=` wins — attached always applies.
    assert.equal(
      getFlagValue(
        [W("--subject=closes #12"), W("-t"), W("x")],
        [B("-t"), B("--subject")],
      ),
      "closes #12",
    );
  });

  it("mixed attached/separated across occurrences: separated-last wins", () => {
    assert.equal(
      getFlagValue([W("--subject=a"), W("--subject"), W("b")], C("--subject")),
      "b",
    );
  });

  it("mixed attached/separated across occurrences: attached-last wins", () => {
    assert.equal(
      getFlagValue([W("--subject"), W("a"), W("--subject=b")], B("--subject")),
      "b",
    );
  });

  it("attached-empty value wins regardless of neighbors", () => {
    assert.equal(
      getFlagValue([W("a"), W("--subject="), W("b")], B("--subject")),
      "",
    );
    assert.equal(
      getFlagValue([W("a"), W("b"), W("--subject=")], B("--subject")),
      "",
    );
  });

  it("single-entry flags arg is equivalent to the array form", () => {
    const args = [W("--profile"), W("dev")];
    assert.equal(getFlagValue(args, C("--profile")), "dev");
    assert.equal(getFlagValue(args, [C("--profile")]), "dev");
  });

  it("trailing flag is fail-closed: null, no fallback", () => {
    assert.equal(getFlagValue([W("--subject")], B("--subject")), null);
    assert.equal(
      getFlagValue([W("--profile"), W("dev"), W("--subject")], B("--subject")),
      null,
    );
    assert.equal(
      getFlagValue([W("--subject"), W("dev"), W("--subject")], C("--subject")),
      null,
    );
  });

  it("returns null when flag is absent", () => {
    assert.equal(getFlagValue([W("other")], B("--profile")), null);
  });

  it("returns null when args is undefined", () => {
    assert.equal(getFlagValue(undefined, B("--profile")), null);
  });

  it("returns null when args is empty", () => {
    assert.equal(getFlagValue([], B("--profile")), null);
  });

  it("returns the next token even if it looks like a flag", () => {
    assert.equal(
      getFlagValue([W("--profile"), W("--other-flag")], C("--profile")),
      "--other-flag",
    );
  });

  it("next-token blind consumption holds for array-form flags too", () => {
    assert.equal(
      getFlagValue([W("--profile"), W("--other")], [C("--profile")]),
      "--other",
    );
  });

  it("separated form with empty next value returns null", () => {
    assert.equal(getFlagValue([W("--subject"), W("")], C("--subject")), null);
  });

  it("does not confuse prefix collisions (--profile-unrelated vs --profile)", () => {
    assert.equal(
      getFlagValue(
        [W("--profile-unrelated"), W("--profile"), W("dev")],
        C("--profile"),
      ),
      "dev",
    );
    assert.equal(getFlagValue([W("--subject-extra=x")], B("--subject")), null);
  });

  it("quote-awareness: reads .value, never unquotes .text", () => {
    const quoted = {
      text: '"closes #12"',
      value: "closes #12",
      pos: 0,
      end: 13,
    } as Word;
    assert.equal(
      getFlagValue([W("--subject"), quoted], C("--subject")),
      "closes #12",
    );
  });

  it("falls back to .text when .value is undefined", () => {
    const rawOnly = {
      text: "--subject=x",
      value: undefined,
      pos: 0,
      end: 11,
    } as unknown as Word;
    assert.equal(getFlagValue([rawOnly], B("--subject")), "x");
  });

  it("returns null on an empty entry array", () => {
    assert.equal(getFlagValue([W("--subject"), W("x")], []), null);
  });

  it("adjacent duplicate bare flags: next token resolves the winner", () => {
    assert.equal(
      getFlagValue([W("--subject"), W("--subject"), W("x")], C("--subject")),
      "x",
    );
  });

  it("adjacent duplicates with a trailing valueless winner fail closed", () => {
    const args = [W("--subject"), W("--subject")];
    assert.equal(getFlagValue(args, C("--subject")), null);
  });
});

describe("strict-always arity (issue #107; #110 entries)", () => {
  it("exact-branch consumes next ONLY when an entry takes a value", () => {
    const args = [W("--profile"), W("dev")];
    assert.equal(getFlagValue(args, C("--profile")), "dev");
    assert.deepEqual(getAllFlagValues(args, C("--profile")), ["dev"]);
    // All-bool entries: present-but-valueless, next token scans alone.
    assert.equal(getFlagValue(args, B("--profile")), null);
    assert.deepEqual(getAllFlagValues(args, B("--profile")), []);
  });

  it("undeclared --frobnicate TEXT → scalar null, array []", () => {
    const args = [W("pr"), W("merge"), W("--frobnicate"), W("TEXT")];
    assert.equal(getFlagValue(args, B("--frobnicate")), null);
    assert.deepEqual(getAllFlagValues(args, B("--frobnicate")), []);
    assert.equal(hasFlag(args, B("--frobnicate")), true);
  });

  it("attached --f=v applies even all-bool", () => {
    assert.equal(getFlagValue([W("--frobnicate=v")], B("--frobnicate")), "v");
    assert.deepEqual(
      getAllFlagValues([W("--frobnicate=v")], B("--frobnicate")),
      ["v"],
    );
    assert.equal(getFlagValue([W("--frobnicate=")], B("--frobnicate")), "");
  });

  it("isValueConsuming(entry): takesValue passthrough", () => {
    assert.equal(
      isValueConsuming({ aliases: ["--body"], takesValue: true }),
      true,
    );
    assert.equal(
      isValueConsuming({ aliases: ["--body"], takesValue: false }),
      false,
    );
  });

  it("strict gate pin: ANY takesValue entry makes exact consume", () => {
    const args = [W("-t"), W("see #13")];
    // ANY takesValue entry in the query ⇒ every exact occurrence consumes.
    assert.equal(getFlagValue(args, [B("-t"), C("--subject")]), "see #13");
    assert.deepEqual(getAllFlagValues(args, [B("-t"), C("--subject")]), [
      "see #13",
    ]);
    // All-bool ⇒ separated form valueless.
    assert.equal(getFlagValue(args, [B("-t"), B("--subject")]), null);
  });

  it("push --delete origin: boolean flag never eats origin", () => {
    const args = [W("push"), W("--delete"), W("origin")];
    assert.equal(getFlagValue(args, B("--delete")), null);
    assert.deepEqual(getAllFlagValues(args, B("--delete")), []);
    assert.equal(hasFlag(args, B("--delete")), true);
  });

  it("trailing declared-consuming with no next token → scalar null, array []", () => {
    const args = [W("--body"), W("x"), W("--body")];
    assert.equal(getFlagValue(args, C("--body")), null);
    assert.deepEqual(getAllFlagValues(args, C("--body")), ["x"]);
  });
});

describe("hasEnvAssignment", () => {
  it("finds AWS_PROFILE= prefix in envAssignments", () => {
    assert.equal(hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS_PROFILE"), true);
  });

  it("does not match partial variable names (AWS vs AWS_PROFILE)", () => {
    assert.equal(hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS"), false);
  });

  it("finds one of several assignments", () => {
    assert.equal(
      hasEnvAssignment(
        [W("PATH=/usr/bin"), W("AWS_PROFILE=dev"), W("DEBUG=1")],
        "AWS_PROFILE",
      ),
      true,
    );
  });

  it("returns false on empty envAssignments", () => {
    assert.equal(hasEnvAssignment([], "AWS_PROFILE"), false);
  });

  it("returns false on undefined envAssignments", () => {
    assert.equal(hasEnvAssignment(undefined, "AWS_PROFILE"), false);
  });
});

describe("INFO_FLAGS", () => {
  it("is exactly the minimal safe default set (--help / --version only)", () => {
    assert.deepEqual([...INFO_FLAGS], ["--help", "--version"]);
  });

  it("does NOT include the -h / -v short forms (adversarial ops)", () => {
    const flags = INFO_FLAGS as readonly string[];
    assert.ok(!flags.includes("-h"));
    assert.ok(!flags.includes("-v"));
  });
});

describe("isInfoOnly", () => {
  it("returns true for bare --help", () => {
    assert.equal(isInfoOnly([W("--help")]), true);
  });

  it("returns true for bare --version", () => {
    assert.equal(isInfoOnly([W("--version")]), true);
  });

  it("returns false for -h (not in the default set)", () => {
    assert.equal(isInfoOnly([W("-h")]), false);
  });

  it("returns false for -v (not in the default set)", () => {
    assert.equal(isInfoOnly([W("-v")]), false);
  });

  it("does NOT match --help inside a quoted VALUE (issue #13 repro)", () => {
    assert.equal(
      isInfoOnly([W("--squash"), W("--subject"), W("see --help")]),
      false,
    );
  });

  it("does NOT match --helpful (token equality, not substring)", () => {
    assert.equal(isInfoOnly([W("--helpful")]), false);
  });

  it("does NOT match glued short forms like -hx", () => {
    assert.equal(isInfoOnly([W("-hx")]), false);
  });

  it("matches attached-value forms --help=x AND --version=1", () => {
    assert.equal(isInfoOnly([W("--help=x")]), true);
    assert.equal(isInfoOnly([W("--version=1")]), true);
  });

  it("extraFlags: ['-h'] makes -h count but -v still does NOT", () => {
    const extra = ["-h"];
    assert.equal(isInfoOnly([W("-h")], extra), true);
    assert.equal(isInfoOnly([W("-v")], extra), false);
  });

  it("returns false on undefined args", () => {
    assert.equal(isInfoOnly(undefined), false);
  });

  it("returns false on empty args", () => {
    assert.equal(isInfoOnly([]), false);
  });
});

describe("glued short flags (issue #11; #110 derived)", () => {
  // `gh -Rc/d` — the walker keeps `-Rc/d` as ONE argv word.

  describe("bool shorts never glue (blind default is now takesValue:false)", () => {
    it("getFlagValue does NOT decompose -Rcad0p/x with a bool entry", () => {
      assert.equal(getFlagValue([W("-Rcad0p/x")], B("-R")), null);
      assert.equal(getFlagValue([W("-Rcad0p/x")], B("-R", "--repo")), null);
    });

    it("hasFlag does NOT match -Rcad0p/x with a bool entry", () => {
      assert.equal(hasFlag([W("-Rcad0p/x")], B("-R")), false);
      assert.equal(hasFlag([W("-Rcad0p/x")], B("-R", "--repo")), false);
    });
  });

  describe("glue-enabled resolution (takesValue:true derives glue)", () => {
    const repo = C("-R", "--repo");

    it("resolves the glued form -Rx/y", () => {
      assert.equal(
        getFlagValue([W("gh"), W("-Rcad0p/x"), W("pr"), W("create")], repo),
        "cad0p/x",
      );
    });

    it("attached-empty -R= still resolves to the empty string", () => {
      assert.equal(getFlagValue([W("-R=")], C("-R")), "");
    });

    it("exact -R + next token unchanged with a takesValue entry", () => {
      assert.equal(getFlagValue([W("-R"), W("c/d")], C("-R")), "c/d");
    });

    it("trailing valueless -R stays fail-closed null", () => {
      assert.equal(getFlagValue([W("pr"), W("merge"), W("-R")], C("-R")), null);
    });

    it("single-entry flags arg works too", () => {
      assert.equal(getFlagValue([W("-Rc/d")], C("-R")), "c/d");
    });

    it("longs never glue even takesValue:true", () => {
      assert.equal(getFlagValue([W("--repox/y")], C("--repo")), null);
      assert.equal(hasFlag([W("--repox/y")], C("--repo")), false);
    });
  });

  describe("per-position precedence: exact > attached > glued", () => {
    it("attached-empty beats glued rest (-R= is '', not '=')", () => {
      assert.equal(getFlagValue([W("-R=")], C("-R")), "");
    });

    it("multi-char aliases are invalid entries: glued on -R wins", () => {
      // Entries validate aliases (`--long` / `-x` only); `-Rx` is
      // malformed → the entry is ignored. The token `-Rx=y` then
      // resolves via glued `-R` + rest `x=y` (not attached `y`).
      // This retires the old string-alias pathological pin: degenerate
      // alias sets are now construction-time invalid, not precedence.
      const bad = {
        aliases: ["-Rx", "-R"],
        takesValue: true,
      } as unknown as CLIFlag;
      assert.equal(getFlagValue([W("-Rx=y")], bad), null);
      assert.equal(getFlagValue([W("-Rx=y")], C("-R")), "x=y");
    });
  });

  describe("last-wins across mixed forms", () => {
    const flags = C("-R", "--repo");

    it("separated then glued: last occurrence wins", () => {
      assert.equal(
        getFlagValue(
          [W("gh"), W("-R"), W("a/b"), W("pr"), W("merge"), W("-Rc/d")],
          flags,
        ),
        "c/d",
      );
    });

    it("long separated then glued short: glued wins", () => {
      assert.equal(
        getFlagValue(
          [W("gh"), W("--repo"), W("a/b"), W("pr"), W("merge"), W("-Rc/d")],
          flags,
        ),
        "c/d",
      );
    });

    it("ambiguity ruling: trailing bare -R over earlier --repo a/b -> null", () => {
      assert.equal(
        getFlagValue(
          [W("gh"), W("--repo"), W("a/b"), W("pr"), W("merge"), W("-R")],
          flags,
        ),
        null,
      );
    });
  });

  describe("bundling safety", () => {
    it("undeclared lead letter never decomposes (docker -vf alpine, f declared)", () => {
      const args = [W("run"), W("-vf"), W("alpine")];
      // Lead is -v (bool here); f's glue does not apply from the tail.
      assert.equal(getFlagValue(args, [B("-v"), C("-f")]), null);
      assert.equal(hasFlag(args, [B("-v"), B("-f")]), false);
      assert.equal(hasFlag(args, C("-f")), false);
    });

    it("irrelevant declared letter leaves -vf untouched", () => {
      const args = [W("-vf"), W("alpine")];
      assert.equal(getFlagValue(args, C("-R")), null);
      assert.equal(hasFlag(args, [B("-v"), B("-f")]), false);
    });

    it("declared lead letter consumes its remainder (-fv, f declared)", () => {
      assert.equal(getFlagValue([W("-fv")], C("-f")), "v");
    });

    it("two declared letters: FIRST letter owns the rest (-vf, v+f)", () => {
      assert.equal(getFlagValue([W("-vf")], C("-v", "-f")), "f");
    });
  });

  describe("eligibility guards", () => {
    const flags = C("-R", "--repo");

    it("--repo=cad0p/x still attached-resolves", () => {
      assert.equal(getFlagValue([W("--repo=cad0p/x")], flags), "cad0p/x");
    });

    it("--repo cad0p/x separated unchanged", () => {
      assert.equal(getFlagValue([W("--repo"), W("cad0p/x")], flags), "cad0p/x");
    });

    it("double-dash tokens are never glued (--Rx/y)", () => {
      assert.equal(getFlagValue([W("--Rx/y")], flags), null);
      assert.equal(hasFlag([W("--Rx/y")], flags), false);
    });

    it("glue needs its own -X alias in the queried entry: no glue", () => {
      // Only --repo queried (bool long): -Ra/b stays opaque.
      assert.equal(getFlagValue([W("--repo"), W("a/b")], B("--repo")), null);
      // TakesValue long still consumes separate, but never glues.
      assert.equal(getFlagValue([W("--repo"), W("a/b")], C("--repo")), "a/b");
      assert.equal(getFlagValue([W("-Ra/b")], C("--repo")), null);
    });

    it("multi-char shorts never become glue-eligible", () => {
      assert.equal(getFlagValue([W("-xyz")], C("-xy")), null);
    });
  });

  describe("quote-awareness", () => {
    it("glued token resolves via .value when .value differs from .text", () => {
      const quoted = {
        text: '-R"c/x"',
        value: "-Rc/x",
        pos: 0,
        end: 8,
      } as Word;
      assert.equal(getFlagValue([quoted], C("-R")), "c/x");
      assert.equal(hasFlag([quoted], C("-R")), true);
    });

    it("falls back to .text when .value is undefined (glued too)", () => {
      const rawOnly = {
        text: "-Rc/d",
        value: undefined,
        pos: 0,
        end: 5,
      } as unknown as Word;
      assert.equal(getFlagValue([rawOnly], C("-R")), "c/d");
    });
  });

  describe("malformed entries fail open (ignored ⇒ no match, no consume)", () => {
    const args = [W("-Rc/d")];
    const flags = C("-R", "--repo");

    it("empty entry array behaves like absent", () => {
      assert.equal(getFlagValue(args, []), null);
      assert.equal(hasFlag(args, []), false);
    });

    it("bool entry behaves blind (no glue)", () => {
      assert.equal(getFlagValue(args, B("-R", "--repo")), null);
      assert.equal(hasFlag(args, B("-R", "--repo")), false);
    });

    it("non-object entries are ignored", () => {
      const bad = ["-R"] as unknown as CLIFlag;
      assert.equal(getFlagValue(args, bad), null);
      assert.equal(hasFlag(args, bad), false);
    });

    it("runtime garbage entries are ignored (house fail-open precedent)", () => {
      const bad = { aliases: ["-R"], takesValue: 123 } as unknown as CLIFlag;
      assert.equal(getFlagValue(args, flags && bad), null);
      assert.equal(
        hasFlag(args, [flags, bad].filter(Boolean) as CLIFlag[]),
        true,
      );
    });

    it("empty-alias entries are ignored", () => {
      const bad = { aliases: [], takesValue: true } as unknown as CLIFlag;
      assert.equal(getFlagValue(args, bad), null);
      assert.equal(hasFlag(args, bad), false);
    });
  });

  describe("hasFlag mirrors", () => {
    it("true for the glued form with a takesValue entry (scalar and alias set)", () => {
      assert.equal(hasFlag([W("-Rc/d")], C("-R")), true);
      assert.equal(hasFlag([W("-Rc/d")], C("-R", "--repo")), true);
    });

    it("false for undeclared-letter bundles even when another letter takes a value", () => {
      assert.equal(hasFlag([W("-vf")], [B("-v"), B("-f")]), false);
    });

    it("false with a bool entry (blind mirror)", () => {
      assert.equal(hasFlag([W("gh"), W("-Rc/d")], B("-R", "--repo")), false);
    });

    it("attached-empty -R= still counts as flag presence", () => {
      assert.equal(hasFlag([W("-R=")], C("-R")), true);
    });
  });
});

describe("entry-only type pins (typo class is now a compile error)", () => {
  it("bare-string query arg FAILS tsc", () => {
    const args = [W("--profile"), W("dev")];
    // @ts-expect-error — strings are no longer queries; pass entries.
    assert.equal(hasFlag(args, "--delet"), false);
    // @ts-expect-error — strings are no longer queries; pass entries.
    assert.equal(getFlagValue(args, "--delet"), null);
  });

  it("FlagLookupOptions import FAILS tsc (deleted export)", async () => {
    const flagsMod = await import("./flags.ts");
    assert.equal("FlagLookupOptions" in flagsMod, false);
    const root = await import("../index.ts");
    assert.equal("FlagLookupOptions" in root, false);
  });

  it("root type surface carries SteeringCommand + CLIFlag (not FlagLookupOptions)", () => {
    const cmd: RootSteeringCommand | null = null;
    const flag: RootCLIFlag | null = null;
    assert.equal(cmd, null);
    assert.equal(flag, null);
  });
});

describe("command facade: package-root surface pin (#101; #110 entries)", () => {
  it("commandFromInput is on the root; the 4 bare helpers are not", async () => {
    const root = await import("../index.ts");
    assert.equal(typeof root.commandFromInput, "function");
    assert.ok(Array.isArray(root.INFO_FLAGS));
    for (const name of [
      "hasFlag",
      "getFlagValue",
      "hasEnvAssignment",
      "isInfoOnly",
    ] as const) {
      assert.equal(name in root, false, `${name} must not be on the root`);
    }
  });

  it("root commandFromInput binds hasFlag (attached form)", async () => {
    const root = await import("../index.ts");
    const { resolveDescriptor } = await import("../arity.ts");
    const cmd = root.commandFromInput(
      {
        tool: "bash",
        args: [PW("--profile=dev")],
      },
      resolveDescriptor("npm", { npm: { flags: { p: C("--profile") } } }),
    );
    assert.equal(cmd.hasFlag(B("--profile")), true);
  });

  it("root commandFromInput getFlagValue is last-wins", async () => {
    const root = await import("../index.ts");
    const { resolveDescriptor } = await import("../arity.ts");
    const cmd = root.commandFromInput(
      {
        tool: "bash",
        args: [PW("--profile"), PW("a"), PW("--profile"), PW("b")],
      },
      resolveDescriptor("npm", { npm: { flags: { p: C("--profile") } } }),
    );
    assert.equal(cmd.getFlagValue(C("--profile")), "b");
  });

  it("root commandFromInput getAllFlagValues keeps argv order", async () => {
    const root = await import("../index.ts");
    const { resolveDescriptor } = await import("../arity.ts");
    const cmd = root.commandFromInput(
      {
        tool: "bash",
        args: [PW("-m"), PW("a"), PW("--message"), PW("b")],
      },
      resolveDescriptor("npm", { npm: { flags: { m: C("-m", "--message") } } }),
    );
    assert.equal(cmd.getAllFlagValues(C("-m", "--message")).join("|"), "a|b");
  });

  it("root commandFromInput hasEnvAssignment matches on the literal name", async () => {
    const root = await import("../index.ts");
    const cmd = root.commandFromInput({
      tool: "bash",
      envAssignments: [W("AWS_PROFILE=dev")],
    });
    assert.equal(cmd.hasEnvAssignment("AWS_PROFILE"), true);
    assert.equal(cmd.hasEnvAssignment("AWS"), false);
  });

  it("root commandFromInput isInfoOnly honors the default set", async () => {
    const root = await import("../index.ts");
    assert.equal(
      root
        .commandFromInput({ tool: "bash", args: [PW("--help")] })
        .isInfoOnly(),
      true,
    );
    assert.equal(
      root.commandFromInput({ tool: "bash", args: [PW("-h")] }).isInfoOnly(),
      false,
    );
  });

  it("root INFO_FLAGS is the minimal safe default set", async () => {
    const root = await import("../index.ts");
    assert.deepEqual([...root.INFO_FLAGS], ["--help", "--version"]);
  });
});
