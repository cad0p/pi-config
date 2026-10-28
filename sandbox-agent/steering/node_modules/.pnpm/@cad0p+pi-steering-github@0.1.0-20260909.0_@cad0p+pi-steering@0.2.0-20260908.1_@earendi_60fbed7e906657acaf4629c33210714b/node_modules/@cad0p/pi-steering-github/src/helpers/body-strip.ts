// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * The byte-pinned perl program that produces a note's BODY: strips a
 * leading YAML frontmatter block (open `---` on line 1 after an
 * optional BOM; close on the next line that is exactly `---` or
 * `...`; CRLF-tolerant) plus any immediately following blank lines,
 * and then strips the leading ATX H1 (`#`, `# `, `# text` — NOT
 * `#foo`, NOT indented) plus any following blank lines. The H1 is
 * the note's title — redundant under the gh PR/issue title — but it
 * is only stripped when frontmatter was present and stripped (the
 * note convention: frontmatter + title + body), so a frontmatter-
 * less body file starting with `# …` passes through untouched.
 * Unterminated or absent frontmatter → input passed through
 * byte-identical. Mid-document `---`, `##`, `#foo` and indented
 * headings are never touched.
 *
 * Leaf module (no imports) so both `rules.ts` (static reason strings
 * interpolate it at module load) and the predicate module (tokenizer
 * byte-pin + keyword-check exec) can import it without a cycle.
 *
 * The rule's tokenizer requires the inner command to be EXACTLY
 * `perl -0777 -pe '<this program>' <path>` (quoting of the program
 * is free — the tokenizer strips it); anything else fails closed.
 * The program's behavior is pinned by `body-strip.test.ts`, which
 * runs it against the full fixture matrix on every CI platform.
 */
export const BODY_STRIP =
  "s/^(?:\\xEF\\xBB\\xBF)?---\\r?\\n(?:.*?\\r?\\n)?(?:---|\\.\\.\\.)\\r?\\n(?:\\r?\\n)*(?:[ \\t]*\\r?\\n)*(?:#(?![\\S])[^\\n]*(?:\\r?\\n)?(?:[ \\t]*\\r?\\n)*)?//s";
