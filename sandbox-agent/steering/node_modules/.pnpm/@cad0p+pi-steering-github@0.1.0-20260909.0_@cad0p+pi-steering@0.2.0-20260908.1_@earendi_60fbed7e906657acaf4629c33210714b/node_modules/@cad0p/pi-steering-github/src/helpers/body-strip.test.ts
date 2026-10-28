// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Behavior pins for the pinned perl body-strip one-liner
 * (`BODY_STRIP`).
 *
 * The body-file rules accept EXACTLY `<(perl -0777 -pe '<program>'
 * <path>)` — the program token is byte-pinned by the predicate, and
 * THIS suite pins what that fixed byte-string DOES: it spawns perl
 * with the pinned program against a fixture matrix and asserts the
 * exact output. Perl is one interpreter across platforms, so the
 * behavior pins hold identically on Linux and macOS CI.
 *
 * The strip contract (the note's BODY: frontmatter + title removed):
 *   - frontmatter = an opening `---` on line 1 (after an optional
 *     BOM) closed by the next line that is exactly `---` or `...`
 *   - the block AND any immediately following blank/whitespace-only
 *     lines are removed
 *   - then the leading ATX H1 (`#`, `# `, `# text` — NOT `#foo`,
 *     NOT indented) is removed, plus any following blank lines —
 *     ONLY when frontmatter was present and stripped (the note
 *     convention); a frontmatter-less file passes through untouched
 *   - CRLF input keeps its line endings on the remaining lines
 *   - unterminated frontmatter / no frontmatter / mid-document `---`
 *     → output byte-identical to input
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BODY_STRIP } from "./body-strip.ts";

const fixtures: string[] = [];

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "body-strip-"));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the pinned program against `input` (same argv shape the predicate uses). */
function strip(input: string): string {
  const dir = makeFixtureDir();
  const file = join(dir, "note.md");
  writeFileSync(file, input);
  const res = spawnSync("perl", ["-0777", "-pe", BODY_STRIP, file], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `perl failed: ${res.stderr}`);
  return res.stdout;
}

describe("BODY_STRIP — pinned perl one-liner behavior", () => {
  it("strips frontmatter + H1 + following blanks (basic note)", () => {
    assert.equal(strip("---\ntags: [a]\n---\n# Title\n\nBody.\n"), "Body.\n");
  });

  it("strips frontmatter only when there is no H1", () => {
    assert.equal(strip("---\na: 1\n---\nBody only.\n"), "Body only.\n");
  });

  it("passes a frontmatter-less note through byte-identical (H1 kept)", () => {
    const input = "# Title\n\nNo frontmatter.\n";
    assert.equal(strip(input), input);
  });

  it("passes unterminated frontmatter through byte-identical", () => {
    const input = "---\ntags: [a]\n";
    assert.equal(strip(input), input);
  });

  it("strips CRLF frontmatter + H1 and preserves CRLF on the remaining lines", () => {
    assert.equal(
      strip("---\r\ntags: [a]\r\n---\r\n# Title\r\n\r\nBody.\r\n"),
      "Body.\r\n",
    );
  });

  it("strips a BOM along with the frontmatter + H1", () => {
    assert.equal(strip("\uFEFF---\ntags: [a]\n---\n# T\n\nBody.\n"), "Body.\n");
  });

  it("accepts the ... YAML closer before the H1", () => {
    assert.equal(strip("---\na: 1\n...\n# T\n\nBody.\n"), "Body.\n");
  });

  it("leaves a mid-document --- alone (not on line 1)", () => {
    const input = "# T\n\n---\nnot frontmatter\n---\n";
    assert.equal(strip(input), input);
  });

  it("passes an empty file through", () => {
    assert.equal(strip(""), "");
  });

  it("leaves a leading blank line before --- alone (not frontmatter)", () => {
    const input = "\n---\na: 1\n---\n# T\nBody.\n";
    assert.equal(strip(input), input);
  });

  it("skips blank lines between the closer and the H1", () => {
    assert.equal(strip("---\na: 1\n---\n\n\n# T\n\nBody.\n"), "Body.\n");
  });

  it("skips whitespace-only frontmatter lines and strips the H1", () => {
    assert.equal(strip("---\n   \n---\n# T\nBody.\n"), "Body.\n");
  });

  it("handles an empty frontmatter block (closer on line 2) + H1", () => {
    assert.equal(strip("---\n---\n# T\nBody.\n"), "Body.\n");
  });

  it("keeps #foo (not a heading) in a frontmatter-less file", () => {
    const input = "#foo\n\nBody.\n";
    assert.equal(strip(input), input);
  });

  it("keeps ## headings in a frontmatter-less file", () => {
    const input = "## Section\n\nBody.\n";
    assert.equal(strip(input), input);
  });

  it("keeps an indented # in a frontmatter-less file", () => {
    const input = "  # indented\nBody.\n";
    assert.equal(strip(input), input);
  });

  it("strips a bare # line after frontmatter (empty H1)", () => {
    assert.equal(strip("---\na: 1\n---\n#\nBody.\n"), "Body.\n");
  });

  it("strips frontmatter + H1 at EOF with no trailing newline", () => {
    assert.equal(strip("---\na: 1\n---\n# T"), "");
  });

  it("leaves an H1 BEFORE a mid-document frontmatter alone", () => {
    const input = "# T\n\n---\na: 1\n---\nBody.\n";
    assert.equal(strip(input), input);
  });

  it("handles empty frontmatter + CRLF + H1", () => {
    assert.equal(strip("---\r\n---\r\n# T\r\n\r\nX\r\n"), "X\r\n");
  });

  it("keeps ## headings inside a frontmatter-bearing note", () => {
    assert.equal(
      strip("---\na: 1\n---\n# Title\n\n## Section\n\nBody.\n"),
      "## Section\n\nBody.\n",
    );
  });

  it("keeps #foo inside a frontmatter-bearing note", () => {
    assert.equal(strip("---\na: 1\n---\n# Title\n\n#foo\n"), "#foo\n");
  });
});
