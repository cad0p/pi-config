// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// Unit tests for refToText. The function is a thin wrapper around
// unbash-walker's getBasename / getCommandArgs; these tests pin the
// exact rendered shape observer-watch patterns see so a future
// refactor that accidentally changes spacing (e.g. drops the trim)
// doesn't silently break every `watch.inputMatches.command` in the
// wild.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expandWrapperCommands,
  extractAllCommandsFromAST,
  parse,
} from "@cad0p/unbash-walker";
import {
  refToText,
  refToTextResolved,
  resolvePredicateWords,
} from "./ref-text.ts";

function refsFor(command: string) {
  const script = parse(command);
  return extractAllCommandsFromAST(script, command);
}

/** First expanded ref of a command (prefix-bearing commands yield one ref). */
function firstRef(command: string) {
  const script = parse(command);
  const extracted = extractAllCommandsFromAST(script, command);
  const { commands } = expandWrapperCommands(extracted);
  return commands[0]!;
}

describe("refToText", () => {
  it("renders bare command with no args", () => {
    const [ref] = refsFor("alpha");
    assert.equal(refToText(ref!), "alpha");
  });

  it("renders command with single arg", () => {
    const [ref] = refsFor("git push");
    assert.equal(refToText(ref!), "git push");
  });

  it("renders command with multiple args, space-joined", () => {
    const [ref] = refsFor("git push origin main --force");
    assert.equal(refToText(ref!), "git push origin main --force");
  });

  it("trims trailing space from empty args list", () => {
    const [ref] = refsFor("noop");
    assert.equal(
      refToText(ref!),
      "noop",
      "no trailing space when args is empty",
    );
  });

  it("basename strips path prefix", () => {
    const [ref] = refsFor("/usr/local/bin/cr --all");
    assert.equal(
      refToText(ref!),
      "cr --all",
      "rendered command uses basename, not absolute path",
    );
  });
});

describe("refToTextResolved (issue #51)", () => {
  it("static words are byte-identical to raw refToText", () => {
    const ref = firstRef("git commit -m 'conventional: subject'");
    assert.equal(refToTextResolved(ref, new Map()), refToText(ref));
    assert.equal(
      refToTextResolved(ref, new Map()),
      // getCommandArgs' `value ?? text` shape: single-quotes stripped.
      "git commit -m conventional: subject",
    );
  });

  it("quoted $VAR resolves in value-mode (unquoted)", () => {
    const ref = firstRef('gh pr create --title "$T"');
    assert.equal(
      refToTextResolved(ref, new Map([["T", "feat: x (closes #12)"]])),
      "gh pr create --title feat: x (closes #12)",
    );
  });

  it("process substitution resolves via text-mode inner expansion", () => {
    const ref = firstRef(
      "gh pr create --body-file=<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")",
    );
    assert.equal(
      refToTextResolved(ref, new Map([["BODY", "/vault/repo/prs/note.md"]])),
      "gh pr create --body-file= <(perl -0777 -pe '<BODY_STRIP>' \"/vault/repo/prs/note.md\")",
    );
  });

  it("unresolvable word stays raw (fail-closed)", () => {
    const ref = firstRef('echo "$UNDEF" "$(cmd)" "${X:-d}"');
    assert.equal(
      refToTextResolved(ref, new Map()),
      // Raw fallback is `value ?? text` — the lexical (unquoted) form.
      "echo $UNDEF $(cmd) ${X:-d}",
    );
  });

  it("tilde expands via env HOME", () => {
    const ref = firstRef("gh pr create --body-file ~/note.md");
    assert.equal(
      refToTextResolved(ref, new Map([["HOME", "/home/pier"]])),
      "gh pr create --body-file /home/pier/note.md",
    );
  });
});

describe("resolvePredicateWords (issue #51)", () => {
  it("static words keep text/value, rawText === text, parts raw", () => {
    const ref = firstRef("git commit -m 'conventional: subject'");
    const words = resolvePredicateWords(ref, new Map());
    assert.deepEqual(
      words.map((w) => [w.text, w.value, w.rawText]),
      [
        ["commit", "commit", "commit"],
        ["-m", "-m", "-m"],
        [
          "'conventional: subject'",
          "conventional: subject",
          "'conventional: subject'",
        ],
      ],
    );
    assert.equal(words[2]!.parts?.length, 1);
    assert.equal(words[2]!.parts![0]!.type, "SingleQuoted");
  });

  it("quoted $VAR: text quote-preserving resolved, value unquoted resolved, rawText raw", () => {
    const ref = firstRef('gh pr create --title "$T"');
    const words = resolvePredicateWords(ref, new Map([["T", "feat: x"]]));
    const title = words[words.length - 1]!;
    assert.equal(title.text, '"feat: x"');
    assert.equal(title.value, "feat: x");
    assert.equal(title.rawText, '"$T"');
  });

  it("process substitution: text inner-expanded, value raw lexical, rawText raw", () => {
    const ref = firstRef(
      "gh pr create --body-file=<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")",
    );
    const words = resolvePredicateWords(
      ref,
      new Map([["BODY", "/vault/repo/prs/note.md"]]),
    );
    const psWord = words[words.length - 1]!;
    assert.equal(
      psWord.text,
      "<(perl -0777 -pe '<BODY_STRIP>' \"/vault/repo/prs/note.md\")",
    );
    // value-mode is unresolvable for process substitutions — the fd
    // path is unknowable — so value stays the lexical token.
    assert.equal(psWord.value, "<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")");
    assert.equal(psWord.rawText, "<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")");
  });

  it("unresolvable words stay raw: text === raw source, value === lexical", () => {
    const ref = firstRef('gh pr create --title "$UNDEF" --body "${X:-d}"');
    const words = resolvePredicateWords(ref, new Map());
    const undef = words[3]!;
    assert.equal(undef.text, '"$UNDEF"');
    assert.equal(undef.value, "$UNDEF");
    assert.equal(undef.rawText, '"$UNDEF"');
    const modifier = words[5]!;
    assert.equal(modifier.text, '"${X:-d}"');
    assert.equal(modifier.value, "${X:-d}");
    assert.equal(modifier.rawText, '"${X:-d}"');
  });

  it("parts stay RAW even when text/value are resolved", () => {
    const ref = firstRef('echo "$BODY"');
    const [word] = resolvePredicateWords(ref, new Map([["BODY", "/v/x"]]));
    assert.equal(word!.text, '"/v/x"');
    assert.equal(word!.value, "/v/x");
    // DoubleQuoted part with the raw source — `$BODY` unexpanded.
    assert.equal(word!.parts!.length, 1);
    assert.equal(word!.parts![0]!.type, "DoubleQuoted");
    assert.equal(word!.parts![0]!.text, '"$BODY"');
  });
});
