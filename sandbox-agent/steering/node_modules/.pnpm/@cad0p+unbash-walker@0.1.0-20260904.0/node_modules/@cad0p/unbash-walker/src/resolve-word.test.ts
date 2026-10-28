// SPDX-License-Identifier: MIT
// Tests for the env-aware Word resolver. Part of unbash-walker.
//
// These tests exercise `resolveWord` against the full range of
// WordPart types unbash produces, using the unbash parser to
// construct realistic words rather than hand-building AST nodes.
// The parser gives us confidence that the helper handles what
// real agent-emitted commands look like.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Word } from "unbash";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import {
  expandTildeIfLeading,
  resolveWord,
  resolveWordText,
} from "./resolve-word.ts";

/**
 * Parse `cd X` and pluck the `X` word — the simplest reliable
 * way to obtain a fully-formed Word from the parser across every
 * WordPart variant the tests care about. Uses the walker's own
 * `extractAllCommandsFromAST` to traverse the parser's nested AST
 * shape so the test file doesn't depend on the internal Statement
 * vs Command union.
 */
function wordFromCdArg(src: string): Word {
  const raw = `cd ${src}`;
  const script = parseBash(raw);
  const refs = extractAllCommandsFromAST(script, raw);
  const cmd = refs[0]?.node;
  if (!cmd) throw new Error(`no command extracted from \`${raw}\``);
  const word = cmd.suffix[0];
  if (!word) throw new Error(`no suffix word in \`${raw}\``);
  return word;
}

describe("resolveWord", () => {
  describe("literals", () => {
    it("plain literal", () => {
      const w = wordFromCdArg("/tmp/pkg");
      assert.equal(resolveWord(w, new Map()), "/tmp/pkg");
    });

    it("single-quoted literal", () => {
      const w = wordFromCdArg("'/tmp/pkg'");
      assert.equal(resolveWord(w, new Map()), "/tmp/pkg");
    });

    it("single-quoted text is NOT expanded", () => {
      const w = wordFromCdArg("'literal-with-$VAR'");
      assert.equal(
        resolveWord(w, new Map([["VAR", "expanded"]])),
        "literal-with-$VAR",
      );
    });

    it("double-quoted plain text", () => {
      const w = wordFromCdArg('"/tmp/pkg"');
      assert.equal(resolveWord(w, new Map()), "/tmp/pkg");
    });
  });

  describe("simple expansion ($NAME)", () => {
    it("resolves from env map", () => {
      const w = wordFromCdArg("$WS");
      assert.equal(
        resolveWord(w, new Map([["WS", "/workspace"]])),
        "/workspace",
      );
    });

    it("undefined → undefined", () => {
      const w = wordFromCdArg("$UNDEFINED");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("inside double-quoted with suffix literal", () => {
      const w = wordFromCdArg('"$WS/pkg"');
      assert.equal(
        resolveWord(w, new Map([["WS", "/workspace"]])),
        "/workspace/pkg",
      );
    });

    it("inside double-quoted with prefix and suffix", () => {
      const w = wordFromCdArg('"/root/$NAME/child"');
      assert.equal(
        resolveWord(w, new Map([["NAME", "middle"]])),
        "/root/middle/child",
      );
    });

    it("positional parameter $1 → undefined", () => {
      const w = wordFromCdArg("$1");
      assert.equal(resolveWord(w, new Map([["1", "/nope"]])), undefined);
    });
  });

  describe("brace expansion (${NAME})", () => {
    it("resolves from env map", () => {
      const w = wordFromCdArg("${WS}");
      assert.equal(
        resolveWord(w, new Map([["WS", "/workspace"]])),
        "/workspace",
      );
    });

    it("inside double-quoted", () => {
      const w = wordFromCdArg('"${WS}/pkg"');
      assert.equal(
        resolveWord(w, new Map([["WS", "/workspace"]])),
        "/workspace/pkg",
      );
    });

    it("undefined → undefined", () => {
      const w = wordFromCdArg("${UNDEFINED}");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("${VAR:-default} (with operator) → undefined (deferred)", () => {
      const w = wordFromCdArg('"${VAR:-/default}"');
      assert.equal(
        resolveWord(w, new Map([["VAR", "/x"]])),
        undefined,
        "parameter expansion with modifier is deferred per env-tracker-deferred-scope",
      );
    });

    it("${VAR#pattern} → undefined (deferred)", () => {
      const w = wordFromCdArg('"${VAR#/prefix}"');
      assert.equal(resolveWord(w, new Map([["VAR", "/prefix/x"]])), undefined);
    });

    it("${#VAR} length form → undefined (deferred)", () => {
      const w = wordFromCdArg('"${#VAR}"');
      assert.equal(resolveWord(w, new Map([["VAR", "abc"]])), undefined);
    });
  });

  describe("tilde expansion", () => {
    it("bare ~", () => {
      const w = wordFromCdArg("~");
      assert.equal(resolveWord(w, new Map([["HOME", "/home/me"]])), "/home/me");
    });

    it("~/subdir", () => {
      const w = wordFromCdArg("~/proj/app");
      assert.equal(
        resolveWord(w, new Map([["HOME", "/home/me"]])),
        "/home/me/proj/app",
      );
    });

    it("HOME missing → ~ / ~/... become undefined (fail-closed via walker unknown sentinel)", () => {
      // Before the cd~-absent-HOME fix, expandTildeIfLeading fell back
      // to the literal string. Callers then saw `~/proj` as a path,
      // which silently bypassed `when.cwd` guards. Now resolveWord
      // returns undefined — the cd modifier propagates, the walker
      // emits unknown, and engine's onUnknown: "block" fires.
      const w = wordFromCdArg("~/proj");
      assert.equal(resolveWord(w, new Map()), undefined);

      const bare = wordFromCdArg("~");
      assert.equal(resolveWord(bare, new Map()), undefined);
    });

    it("quoted tilde is NOT expanded", () => {
      // Per bash: quoted tildes stay literal. We match that.
      const w = wordFromCdArg('"~/proj"');
      assert.equal(resolveWord(w, new Map([["HOME", "/home/me"]])), "~/proj");
    });

    it("~user — unsupported, returns literal", () => {
      const w = wordFromCdArg("~alice/docs");
      assert.equal(
        resolveWord(w, new Map([["HOME", "/home/me"]])),
        "~alice/docs",
      );
    });

    it("interior ~ is literal (not at word start)", () => {
      const w = wordFromCdArg("/a/~");
      assert.equal(resolveWord(w, new Map([["HOME", "/home/me"]])), "/a/~");
    });

    it("expandTildeIfLeading — exported helper pins (issue #13)", () => {
      // Public-surface pin for the helper the env tracker now uses on
      // assignment RHS values. Semantics identical to word-start use.
      const HOME = new Map([["HOME", "/home/me"]]);
      assert.equal(expandTildeIfLeading("~/x", HOME), "/home/me/x");
      assert.equal(expandTildeIfLeading("~", HOME), "/home/me");
      assert.equal(expandTildeIfLeading("~user", HOME), "~user");
      assert.equal(expandTildeIfLeading("~$X", HOME), "~$X");
      assert.equal(expandTildeIfLeading("/a/~", HOME), "/a/~");
      assert.equal(expandTildeIfLeading("plain", HOME), "plain");
      // HOME absent → undefined for expandable shapes; non-tilde unchanged.
      assert.equal(expandTildeIfLeading("~/x", new Map()), undefined);
      assert.equal(expandTildeIfLeading("~", new Map()), undefined);
      assert.equal(expandTildeIfLeading("~user", new Map()), "~user");
      assert.equal(expandTildeIfLeading("plain", new Map()), "plain");
    });
  });

  describe("intractable forms → undefined", () => {
    it("command substitution $(…)", () => {
      const w = wordFromCdArg("$(pwd)");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("command substitution inside double-quoted", () => {
      const w = wordFromCdArg('"$(pwd)/x"');
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("arithmetic expansion $((…))", () => {
      const w = wordFromCdArg('"/x$((1+1))"');
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("backtick command substitution", () => {
      const w = wordFromCdArg("`pwd`");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("process substitution <(…)", () => {
      const w = wordFromCdArg("<(echo /x)");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("extended glob @(…)", () => {
      const w = wordFromCdArg("@(a|b)");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("brace expansion {…}", () => {
      const w = wordFromCdArg("{a,b}");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("ANSI-C quoted $'…'", () => {
      // `$'...'` parses as an AnsiCQuoted part. Could in principle be
      // resolved statically (the content IS known at parse time, modulo
      // escape-sequence semantics) but resolveWord treats it as
      // intractable for v0.1.0 — a rule author who cares about escape-
      // sequence semantics can extend in a plugin later.
      const w = wordFromCdArg("$'hello\\n'");
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it('locale-aware string $"…"', () => {
      // `$"..."` parses as a LocaleString part. Similarly tractable in
      // principle (the fallback string is static) but treated as
      // intractable here because localization substitution is runtime-
      // dependent on `LC_MESSAGES`.
      const w = wordFromCdArg('$"hello"');
      assert.equal(resolveWord(w, new Map()), undefined);
    });
  });

  describe("empty env", () => {
    it("all expansions miss → undefined on any $VAR", () => {
      const w = wordFromCdArg('"$FOO/bar"');
      assert.equal(resolveWord(w, new Map()), undefined);
    });

    it("static word still resolves", () => {
      const w = wordFromCdArg("/literal");
      assert.equal(resolveWord(w, new Map()), "/literal");
    });
  });

  describe("multi-part words", () => {
    it("Literal + ${VAR} + Literal", () => {
      // Bash treats `/a${VAR}/b` as a single word with 3 parts.
      const w = wordFromCdArg("/a${VAR}/b");
      assert.equal(resolveWord(w, new Map([["VAR", "MID"]])), "/aMID/b");
    });

    it("concatenated $VAR$VAR2", () => {
      const w = wordFromCdArg("$A$B");
      assert.equal(
        resolveWord(
          w,
          new Map([
            ["A", "one"],
            ["B", "two"],
          ]),
        ),
        "onetwo",
      );
    });

    it("one undefined part makes the whole word intractable", () => {
      const w = wordFromCdArg("$A$B");
      assert.equal(resolveWord(w, new Map([["A", "one"]])), undefined);
    });
  });
});

describe("resolveWordText", () => {
  const BODY_ENV = new Map([["BODY", "/vault/repo/prs/note.md"]]);
  const EXPECTED_PERL = `<(perl -0777 -pe '<BODY_STRIP>' "/vault/repo/prs/note.md")`;

  describe("process substitution — acceptance case", () => {
    it("expands $BODY inside <(…), keeping inner quoting", () => {
      // The guardrail acceptance case: predicates need the TEXT of a
      // process-substitution word with variables inside it expanded.
      const w = wordFromCdArg(`<(perl -0777 -pe '<BODY_STRIP>' "$BODY")`);
      assert.equal(resolveWordText(w, BODY_ENV), EXPECTED_PERL);
    });

    it("expands ${BODY} form identically", () => {
      const w = wordFromCdArg(`<(perl -0777 -pe '<BODY_STRIP>' "\${BODY}")`);
      assert.equal(resolveWordText(w, BODY_ENV), EXPECTED_PERL);
    });

    it("inner $VAR absent from env → whole word undefined", () => {
      const w = wordFromCdArg(`<(perl -0777 -pe '<BODY_STRIP>' "$BODY")`);
      assert.equal(resolveWordText(w, new Map()), undefined);
    });

    it("acceptance-shaped end-to-end: gh pr create --body-file=<(…)", () => {
      // `--body-file=` and the process substitution parse as separate
      // suffix words; the PS word must resolve to the expanded text.
      const raw = `gh pr create --body-file=<(perl -0777 -pe '<BODY_STRIP>' "$BODY")`;
      const script = parseBash(raw);
      const refs = extractAllCommandsFromAST(script, raw);
      const gh = refs.find((r) => r.node.name?.text === "gh");
      assert.ok(gh, "gh command extracted");
      const word = gh.node.suffix.find((w) => w.text.startsWith("<("));
      assert.ok(word, "process-substitution suffix word found");
      assert.equal(resolveWordText(word, BODY_ENV), EXPECTED_PERL);
    });
  });

  describe("process substitution — variants", () => {
    it(">( … ) operator", () => {
      const w = wordFromCdArg(`>(cat "$BODY")`);
      assert.equal(
        resolveWordText(w, BODY_ENV),
        `>(cat "/vault/repo/prs/note.md")`,
      );
    });

    it("nested process substitution recurses", () => {
      const w = wordFromCdArg(`<(cat <(echo "$BODY"))`);
      assert.equal(
        resolveWordText(w, BODY_ENV),
        `<(cat <(echo "/vault/repo/prs/note.md"))`,
      );
    });

    it("spaces inside inner double-quoted words survive (quotes kept)", () => {
      const w = wordFromCdArg(`<(echo "a b" c)`);
      assert.equal(resolveWordText(w, new Map()), `<(echo "a b" c)`);
    });

    it("inner bare ~/… expands via HOME", () => {
      const w = wordFromCdArg(`<(echo ~/x)`);
      assert.equal(
        resolveWordText(w, new Map([["HOME", "/home/me"]])),
        `<(echo /home/me/x)`,
      );
    });

    it("command substitution in an inner word → undefined", () => {
      const w = wordFromCdArg(`<(echo "$BODY" "$(pwd)")`);
      assert.equal(resolveWordText(w, BODY_ENV), undefined);
    });

    it("pipeline inner script (2+ top-level commands) → undefined", () => {
      const w = wordFromCdArg(`<(cmd1 | cmd2)`);
      assert.equal(resolveWordText(w, new Map()), undefined);
    });

    it("`;`-separated inner script (2+ top-level commands) → undefined", () => {
      const w = wordFromCdArg(`<(a; b)`);
      assert.equal(resolveWordText(w, new Map()), undefined);
    });

    it("inner name that doesn't resolve → undefined", () => {
      const w = wordFromCdArg(`<($CMD x)`);
      assert.equal(resolveWordText(w, new Map()), undefined);
    });
  });

  describe("plain words — quote-preserving parity with resolveWord", () => {
    it(`"$BODY" keeps its quotes`, () => {
      const w = wordFromCdArg(`"$BODY"`);
      assert.equal(resolveWordText(w, BODY_ENV), `"/vault/repo/prs/note.md"`);
      // value-mode parity: same string, quotes stripped
      assert.equal(resolveWord(w, BODY_ENV), "/vault/repo/prs/note.md");
    });

    it(`"feat: x" keeps its quotes (spaces survive tokenizers)`, () => {
      const w = wordFromCdArg(`"feat: x"`);
      assert.equal(resolveWordText(w, new Map()), `"feat: x"`);
    });

    it("bare $BODY resolves unquoted", () => {
      const w = wordFromCdArg("$BODY");
      assert.equal(resolveWordText(w, BODY_ENV), "/vault/repo/prs/note.md");
      assert.equal(resolveWord(w, BODY_ENV), "/vault/repo/prs/note.md");
    });

    it("static literals unchanged (parity)", () => {
      const w = wordFromCdArg("/tmp/pkg");
      assert.equal(resolveWordText(w, new Map()), "/tmp/pkg");
      assert.equal(resolveWord(w, new Map()), "/tmp/pkg");
    });

    it("single-quoted text preserved verbatim (never expanded)", () => {
      const w = wordFromCdArg("'literal-with-$VAR'");
      assert.equal(
        resolveWordText(w, new Map([["VAR", "expanded"]])),
        "'literal-with-$VAR'",
      );
    });
  });

  describe("tilde expansion and fail-closed forms", () => {
    it("~ / ~/subdir expand via HOME (first part, bare literal)", () => {
      const home = new Map([["HOME", "/home/me"]]);
      assert.equal(resolveWordText(wordFromCdArg("~"), home), "/home/me");
      assert.equal(
        resolveWordText(wordFromCdArg("~/proj/app"), home),
        "/home/me/proj/app",
      );
    });

    it("HOME missing → ~/… undefined (fail-closed)", () => {
      assert.equal(
        resolveWordText(wordFromCdArg("~/proj"), new Map()),
        undefined,
      );
    });

    it("quoted tilde is NOT expanded", () => {
      const w = wordFromCdArg(`"~/proj"`);
      assert.equal(
        resolveWordText(w, new Map([["HOME", "/home/me"]])),
        `"~/proj"`,
      );
    });

    it("${X:-default} (modifier) → undefined", () => {
      const w = wordFromCdArg(`"\${X:-d}"`);
      assert.equal(resolveWordText(w, new Map([["X", "/x"]])), undefined);
    });

    it("command substitution in a plain word → undefined", () => {
      const w = wordFromCdArg("$(pwd)");
      assert.equal(resolveWordText(w, new Map()), undefined);
    });

    it("bare $UNDEFINED → undefined", () => {
      const w = wordFromCdArg("$UNDEFINED");
      assert.equal(resolveWordText(w, new Map()), undefined);
    });

    // Review-verified escapes: `value` (unescaped) vs `text` (raw) for
    // double-quoted literal children. Regression tests for the fix.
    it("escaped quote inside double quotes survives (raw source kept)", () => {
      const w = wordFromCdArg(`"a\\"b"`);
      assert.equal(resolveWordText(w, new Map()), `"a\\"b"`);
    });

    it("escaped dollar stays literal — no live expansion in rebuilt text", () => {
      const w = wordFromCdArg(`"\\$X"`);
      assert.equal(resolveWordText(w, new Map([["X", "LIVE"]])), `"\\$X"`);
    });

    it("mixed real expansion + escaped content inside double quotes", () => {
      const w = wordFromCdArg(`"a $X \\" b"`);
      assert.equal(
        resolveWordText(w, new Map([["X", "LIVE"]])),
        `"a LIVE \\" b"`,
      );
    });

    it("top-level unquoted ${X} resolves (value-mode parity)", () => {
      const w = wordFromCdArg("${X}");
      assert.equal(resolveWordText(w, new Map([["X", "/x"]])), "/x");
      assert.equal(resolveWord(w, new Map([["X", "/x"]])), "/x");
    });

    it("top-level unquoted ${X:-d} (modifier) → undefined", () => {
      const w = wordFromCdArg("${X:-d}");
      assert.equal(resolveWordText(w, new Map([["X", "/x"]])), undefined);
    });

    it("~user — unsupported, returns literal unchanged", () => {
      const w = wordFromCdArg("~alice/docs");
      assert.equal(
        resolveWordText(w, new Map([["HOME", "/home/me"]])),
        "~alice/docs",
      );
    });

    it("special params $? / $$ → undefined (not identifier names)", () => {
      const w1 = wordFromCdArg("$?");
      assert.equal(resolveWordText(w1, new Map()), undefined);
      const w2 = wordFromCdArg("$$");
      assert.equal(resolveWordText(w2, new Map()), undefined);
    });

    it("process substitution with script === undefined keeps raw part text", () => {
      // Hand-built word: the parser always yields a Script for valid
      // input, so this arm is defensive — pin it with a synthetic part.
      const w: Word = {
        text: "<(echo hi)",
        value: "<(echo hi)",
        pos: 0,
        end: 10,
        parts: [
          {
            type: "ProcessSubstitution",
            text: "<(echo hi)",
            operator: "<",
            script: undefined,
            inner: undefined,
          },
        ],
      };
      assert.equal(resolveWordText(w, new Map()), "<(echo hi)");
    });
  });
});
