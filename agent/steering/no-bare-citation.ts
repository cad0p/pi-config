// SPDX-License-Identifier: MIT
/**
 * no-bare-citation — a PR/issue body or comment may not cite code by a
 * bare `path:NN` (owner rule R4, approved 2026-11-15).
 *
 * The incident shape: dozens of lens findings pointed at
 * `tools/merge-pr.sh:2081`, `reconcile.sh:183-258`, `docs/image.md:238`.
 * The file did not move, the LINE moved, and every one of those
 * pointers became a lie the reader had to re-derive. A citation is
 * either pinned to a commit (a permalink: the bytes cannot drift) or
 * it names a symbol (a function, a unit, a rule id: the reader
 * re-locates it). A bare `path:NN` is neither.
 *
 * This module is a DRAFT (v2): v1 is INSTALLED in the owner's config;
 * v2 is NOT. The install diff is in README.md; the blast-radius
 * measurement that decides the open toggles came from
 * `blast-radius.mjs` in this same directory.
 *
 * v2 adds the SECOND form of the same defect: the `:NNN` shorthand written
 * after a path was already named in the same block
 * (`the S5 tasks cite (:365-434)`, `base `c2254003`'s `:563`). v1 left 925 of
 * those in the measured window: the shorthand is the same stale pointer
 * with the file name factored out, so the reader has to scroll back to
 * learn WHAT `:563` points at — and by then the number has drifted.
 *
 * WHAT IT MATCHES (documented, because a matcher's edges are the rule)
 *
 *   (1) `path:N` and `path:N-M` where `path` is
 *       (a) any token whose last segment carries a file extension
 *           (`tools/merge-pr.sh:2081`, `seedreq.go:558`,
 *           `docs/image.md:238`, `.github/workflows/ci.yml:12`), or
 *       (b) a known extensionless file name (`Dockerfile:38`,
 *           `Makefile:12`), or
 *       (c) an extensionless path under a known tool directory
 *           (`tools/pc-ops:120`, `bin/pc-wt:44`).
 *   (2) `:N` and `:N-M` with NO path, when a path was named EARLIER IN THE
 *       SAME BLOCK (see "Blocks" below) — the shorthand citation. The
 *       colon must stand alone: the character before it is the start of
 *       the block, whitespace, or one of `([{` `<,;/`, and the character after
 *       the number may not be a letter, a digit, `_` or a dash. That
 *       one boundary rule is what keeps clocks (`02:41Z`), ratios (`3:1`),
 *       IPv6 (`fe80::1`), host:port (`localhost:8080`), YAML keys
 *       (`line:12`), lens labels (`Lens: 2: CLEAN`) and emoji shortcodes
 *       (`:100:`) out — each one is pinned by a test.
 *   - NOT matched, deliberately: a `path#L12` anchor with no commit (a
 *     separate decision, see README "residual gaps"); a `:N` whose block
 *     names no path (the rule cannot know what it belongs to); a `:N`
 *     whose anchor path sits in a DIFFERENT block (a heading, the
 *     previous paragraph, the previous table row, the previous list
 *     item: the anchor is out of scope, so the shorthand is not
 *     graded); a `:N` inside a URL (`https://console.piercloud.net:0` is a
 *     port, and a URL is a link, not a bare citation); a bare hostname
 *     with a TLD-shaped extension (`console.piercloud.net:0` in prose).
 *
 * BLOCKS — what "the same paragraph" means
 *
 *   A block is one of: a paragraph (consecutive non-blank prose lines),
 *   a list item (its marker line plus its continuation lines), a table
 *   row (one line: a cell is a row), an ATX heading (one line), a
 *   fenced code block, or a 4-space-indented code block that follows a
 *   blank line. A blank line, a heading, a table row, a new list
 *   marker or a fence delimiter ends the current block. A path named in
 *   one block never licenses a shorthand in another: that is the
 *   documented edge, not an accident.
 *
 * WHAT IS ALLOWED
 *
 *   (a) A GitHub permalink pinned to a 40-hex commit
 *       (`/blob/<40hex>/path#L12`, `#L12-L20`). URLs are not scanned
 *       at all, so this form always passes; the permalink check exists
 *       so the exemption is explicit, documented and testable.
 *   (b) A body whose FIRST non-blank line names a 40-hex head: lens
 *       verdicts (`Lens: functional @ <40hex>`), design checks
 *       (`Design check: round 3 @ <40hex>`), maintainer passes and
 *       gate records. Those bodies are bound to one commit, so their
 *       line numbers cannot drift. The check is mechanical (a
 *       standalone 40-hex token on the first non-blank line), not a
 *       label allowlist: a new verdict kind needs no code change.
 *   (c) PROPOSED, owner-toggled: a fenced code block. Quoted tool
 *       output is verbatim evidence and rewriting it would falsify the
 *       quote. `EXEMPT_FENCED_CODE` defaults to "exempt" (blast
 *       radius: see README); flip it to "scan" to grade fences too.
 *
 * TRANSITION (one constant)
 *
 *   `ACTIVATION_DATE`: a body file whose frontmatter `date:` is BEFORE
 *   that date is exempt. In-flight PRs refresh their bodies many times
 *   per round; refusing them mid-round would stall every lane over
 *   text that was already written. A body with NO frontmatter date is
 *   gated (fail-closed — the exemption is for a dated note, not for an
 *   undated file).
 *
 * SURFACES
 *
 *   `gh pr create|new|edit|comment`, `gh issue create|new|edit|comment`,
 *   and `gh api .../comments` POSTs (`-f/--raw-field body=...`,
 *   `-F/--field body=@file`, `--input <json>`). The body text is read
 *   from `--body`, or from `--body-file` — both the plain path and the
 *   pinned vault substitution
 *   `<(perl -0777 -pe '<BODY_STRIP>' <note>)`, whose note path is
 *   resolved and read (the note is what gh uploads, stripped).
 *
 * KNOWN GAPS (pinned in the test file)
 *
 *   - An unreadable body (missing file, `--body-file -`, walker-unknown
 *     cwd) is ALLOWED here: the shipped `pr-body-from-vault-file` /
 *     `issue-body-from-vault-file` rules refuse it with the right
 *     message, and a citation refusal would name the wrong problem.
 *   - `gh pr create --fill` (body from the commits), `gh api --input -`
 *     (stdin) and a body typed into `$EDITOR` are not inspectable.
 *   - `gh pr review --body`, `gh release` and doc writes are out of
 *     scope for this draft (the owner rule also names docs; see
 *     README "open toggles").
 */

import { readFileSync } from "node:fs";
import type { PredicateContext, PredicateShape, Rule } from "@cad0p/pi-steering";
import {
	findBodyFileRawValue,
	parseBodyFileArg,
	resolveAgainstCwd,
} from "@cad0p/pi-steering-github";

declare global {
	interface PiSteeringPredicates {
		/**
		 * `when.bodyHasBareCitation` — this `gh` body/comment carries a
		 * bare `path:NN` citation that is not exempt (permalink,
		 * first-line head, fenced code, pre-activation note date).
		 *
		 * Bare `true` uses the module defaults; the object form
		 * overrides the two toggles for this leaf only.
		 */
		bodyHasBareCitation: PredicateShape<boolean, CitationGateArgs>;
	}
}

/** Per-leaf overrides of the two open toggles. */
export interface CitationGateArgs {
	/** "exempt" (default) skips fenced code; "scan" grades it. */
	fencedCode?: "exempt" | "scan";
	/** ISO date; a note dated BEFORE it is exempt. Defaults to the constant. */
	activationDate?: string;
}

/**
 * The activation date: a body file whose frontmatter `date:` is before
 * this day is exempt (in-flight PRs). One constant, so the owner bumps
 * ONE line when the rule is installed.
 */
export const ACTIVATION_DATE = "2026-11-16";

/**
 * PROPOSED toggle: "exempt" skips citations inside a fenced code block
 * (quoted tool output is verbatim), "scan" grades them.
 */
export const EXEMPT_FENCED_CODE: "exempt" | "scan" = "exempt";

/** How many offending lines a refusal names. */
export const MAX_REPORTED = 5;

// ---------------------------------------------------------------------------
// What counts as a cited path
// ---------------------------------------------------------------------------

/**
 * Extensions that are also ccTLDs, so a BARE hostname
 * (`console.piercloud.net:0`) is not read as a file. Deliberately
 * excludes every extension that is ALSO a code extension and a ccTLD —
 * `.sh` (shell), `.md` (markdown), `.tf` (terraform), `.py`, `.pl`,
 * `.rs`, `.cc` — because `merge-pr.sh:2081` must match.
 */
const TLD_DENY: ReadonlySet<string> = new Set([
	"com", "net", "org", "io", "dev", "app", "cloud", "xyz", "page", "site",
	"tech", "info", "biz", "edu", "gov", "mil", "int", "eu", "uk", "de", "fr",
	"nl", "se", "no", "fi", "dk", "ch", "at", "be", "ca", "us", "au", "jp",
	"cn", "br", "ru", "es", "local", "internal", "lan", "test", "example",
	"invalid", "localhost", "home", "corp",
]);

/** File names with no extension that are still files. */
const EXTENSIONLESS_FILES: ReadonlySet<string> = new Set([
	"Makefile", "makefile", "GNUmakefile", "Dockerfile", "Containerfile",
	"Justfile", "justfile", "Caddyfile", "Jenkinsfile", "Rakefile", "Gemfile",
	"Brewfile", "Procfile", "Vagrantfile", "CODEOWNERS", "OWNERS", "LICENSE",
	"LICENCE", "CHANGELOG", "README", "NOTICE",
]);

/** Tool directories whose scripts may have no extension (`tools/pc-ops`). */
const TOOL_DIRS: ReadonlySet<string> = new Set([
	"tools", "bin", "scripts", "hack", "dev", "ci", "ops", "deploy",
]);

/** A last segment that carries a file extension (`.sh`, `.go`, `.tar.gz`). */
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * `path:N` / `path:N-M`. The lookbehind refuses to start a match
 * mid-word or right after `:`, `/` or `.` — the `/` keeps `//host:port`
 * authorities out, and the `.` keeps a URL's host from becoming the head
 * of a match (`github.com/x/y/blob/main/tools/x.sh:12` starts at `com`
 * without it). A citation that legitimately begins with `.` (`./tools/x.sh:12`)
 * still matches: the character BEFORE the dot is a space.
 */
const CITATION =
	/(?<![A-Za-z0-9_:/.])([A-Za-z0-9_.~+@-]+(?:\/[A-Za-z0-9_.~+@-]+)*):(\d+)(?:-(\d+))?/g;

/**
 * `:N` / `:N-M` with no path: the shorthand. Group 1 is the boundary
 * character that licenses the colon (start of block, whitespace, or a
 * bracket, backtick, comma or semicolon), so a colon glued to a word, a
 * digit, a slash, a quote or another colon is never a shorthand — a
 * quoted `"line":12` is a JSON/YAML key, not a citation. The
 * trailing guard rejects a letter, a digit, `_` or a dash after the number,
 * which is what keeps `:12-` (a dangling dash) out; a colon after the
 * number is punctuation (`:172: status 200` is line 172), except for the
 * two all-digit emoji shortcodes, denied below. A range separator may be
 * an ASCII hyphen or an en dash; `lines` normalizes it to the ASCII hyphen.
 */
const SHORTHAND =
	/(^|[\s([{`<,;/]):(\d{1,5})(?:[-\u2013](\d{1,5}))?(?![A-Za-z0-9_-\u2013])/g;

/**
 * The only two all-digit GitHub emoji shortcodes. `:100:` and `:1234:`
 * are emoji, not line numbers; every other `:N:` is read as a line
 * number followed by a colon (`:172: status 200` is line 172).
 */
const NUMERIC_EMOJI: ReadonlySet<string> = new Set(["100", "1234"]);

/** A fenced code block delimiter (three backticks or tildes, <=3 spaces). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A standalone 40-hex commit id (not part of a longer hex run). */
const HEAD40 = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

/** A commit-pinned permalink (`/blob/<40hex>/`, `/tree/<40hex>/`, raw). */
const PERMALINK =
	/\/blob\/[0-9a-f]{40}(?:\/|$)|\/tree\/[0-9a-f]{40}(?:\/|$)|raw\.githubusercontent\.com\/[^\s]*\/[0-9a-f]{40}\//;

/** How a citation is written: `path:NN` or the `:NN` shorthand. */
export type CitationKind = "path" | "shorthand";

/** One bare-line-number hit in a body. */
export interface Citation {
	/** `path` for `path:NN`, `shorthand` for `:NN`. */
	kind: CitationKind;
	/** Character offset of the hit in the scanned text (document order). */
	offset: number;
	/** 1-based line number in the scanned text. */
	line: number;
	/**
	 * The cited path, as written. For a shorthand, the path named earlier
	 * in the same block (the anchor the number belongs to).
	 */
	path: string;
	/** The line part: `2081` or `183-258`. */
	lines: string;
	/** The matched text (`tools/merge-pr.sh:2081`, `:365-434`). */
	text: string;
	/** The hit sits inside a fenced code block. */
	inFence: boolean;
	/** The hit is part of a commit-pinned permalink (exemption a). */
	permalink: boolean;
	/** The anchor path as written, for a shorthand; null for `path:NN`. */
	anchor: string | null;
}

/** What a path-shaped token is: a file, a tool script, or not a citation. */
export function isCitationPath(path: string): boolean {
	const segments = path.split("/").filter((segment) => segment !== "");
	if (segments.length === 0) return false;
	const last = segments[segments.length - 1] ?? "";
	const extension = HAS_EXTENSION.exec(last);
	if (extension !== null) {
		// A bare hostname with a TLD-shaped extension is a host, not a file.
		const suffix = extension[0].slice(1).toLowerCase();
		return !(segments.length === 1 && TLD_DENY.has(suffix));
	}
	if (EXTENSIONLESS_FILES.has(last)) return true;
	return segments.length >= 2 && TOOL_DIRS.has(segments[0] ?? "");
}

/**
 * A token that is a URL. URLs are LINKS, not bare citations: a
 * `https://host:8080` port is not a line number, and a
 * `https://github.com/.../blob/<40hex>/x.sh#L12` permalink carries its
 * line in a `#L` anchor. They are skipped whole (exemption a). A
 * SCHEME-LESS commit-pinned permalink (`github.com/o/r/blob/<40hex>/x.sh:12`)
 * is not a URL token, so it is scanned — and exempted by the permalink
 * check below, which is why that check is live code, not a formality.
 */
const URL_TOKEN = /:\/\/|^www\./;

/**
 * Every `path:N` hit in `text`, in document order, with the fence and
 * permalink flags. Pure: no filesystem, no context.
 */
export function scanCitations(text: string): Citation[] {
	const hits: Citation[] = [];
	let fence: string | null = null;
	const lines = text.split(/\r?\n/);
	let lineStart = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const start = lineStart;
		lineStart += line.length + 1;
		const marker = FENCE.exec(line);
		if (marker !== null) {
			const character = (marker[1] ?? "`")[0] ?? "`";
			if (fence === null) fence = character;
			else if (fence === character) fence = null;
			continue;
		}
		const inFence = fence !== null;
		for (const tokenMatch of line.matchAll(/\S+/g)) {
			const token = tokenMatch[0];
			const tokenStart = start + (tokenMatch.index ?? 0);
			if (URL_TOKEN.test(token)) continue;
			for (const match of token.matchAll(CITATION)) {
				const path = match[1] ?? "";
				if (!isCitationPath(path)) continue;
				hits.push({
					kind: "path",
					offset: tokenStart + (match.index ?? 0),
					line: index + 1,
					path,
					lines:
						match[3] === undefined
							? (match[2] ?? "")
							: `${match[2]}-${match[3]}`,
					text: match[0],
					inFence,
					permalink: PERMALINK.test(token),
					anchor: null,
				});
			}
		}
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Blocks: what "the same paragraph" means
// ---------------------------------------------------------------------------

/** The kind of block a line belongs to. */
export type BlockKind =
	| "paragraph"
	| "list-item"
	| "table-row"
	| "heading"
	| "fence"
	| "code";

/** One block: the unit in which a shorthand may resolve to a path. */
export interface Block {
	/** What kind of block it is. */
	kind: BlockKind;
	/** 1-based line number of the block's first line. */
	line: number;
	/** Character offset of the block's first character in the body. */
	offset: number;
	/** The block's text, its lines joined with `\n`. */
	text: string;
}

/** An ATX heading (`## Title`); a heading is its own block. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** A table row (`| a | b |`); one row is one block (a cell is a row). */
const TABLE_ROW = /^ {0,3}\|/;

/** A list marker (`- x`, `* x`, `1. x`, `1) x`). */
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** A 4-space or tab indented line (an indented code block after a blank). */
const INDENTED_CODE = /^(?: {4}|\t)/;

/**
 * Split a body into blocks. The rules, in order:
 *
 *   - a fence delimiter opens or closes a fence block (its content is
 *     one block; the delimiters are part of it);
 *   - a blank line ends the current block;
 *   - an ATX heading is a one-line block and ends the current block;
 *   - a table row is a one-line block and ends the current block;
 *   - a list marker starts a list-item block; its continuation lines
 *     (indented or lazy) belong to it;
 *   - a 4-space-indented line after a blank line starts a code block;
 *   - anything else joins the current paragraph, or starts one.
 *
 * So a path named in a heading does NOT license a shorthand in the
 * paragraph below it, and a path in one table row does not license a
 * shorthand in the next row. That is the documented edge.
 */
export function splitBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	const lines = text.split(/\r?\n/);
	let offset = 0;
	let fence: string | null = null;
	let current: Block | null = null;
	let previousBlank = true;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const start = offset;
		offset += line.length + 1;
		const marker = FENCE.exec(line);
		if (marker !== null) {
			const character = (marker[1] ?? "`")[0] ?? "`";
			if (fence === null) {
				fence = character;
				current = {
					kind: "fence",
					line: index + 1,
					offset: start,
					text: line,
				};
				blocks.push(current);
			} else if (fence === character) {
				fence = null;
				if (current !== null) current.text += `\n${line}`;
				current = null;
			} else if (current !== null) {
				current.text += `\n${line}`;
			}
			previousBlank = false;
			continue;
		}
		if (fence !== null) {
			if (current !== null) current.text += `\n${line}`;
			previousBlank = false;
			continue;
		}
		if (line.trim() === "") {
			current = null;
			previousBlank = true;
			continue;
		}
		if (ATX_HEADING.test(line)) {
			blocks.push({ kind: "heading", line: index + 1, offset: start, text: line });
			current = null;
			previousBlank = false;
			continue;
		}
		if (TABLE_ROW.test(line)) {
			blocks.push({ kind: "table-row", line: index + 1, offset: start, text: line });
			current = null;
			previousBlank = false;
			continue;
		}
		if (LIST_MARKER.test(line)) {
			current = { kind: "list-item", line: index + 1, offset: start, text: line };
			blocks.push(current);
			previousBlank = false;
			continue;
		}
		if (current !== null && current.kind === "code" && INDENTED_CODE.test(line)) {
			current.text += `\n${line}`;
			previousBlank = false;
			continue;
		}
		if (
			current !== null &&
			(current.kind === "paragraph" || current.kind === "list-item")
		) {
			current.text += `\n${line}`;
			previousBlank = false;
			continue;
		}
		if (previousBlank && INDENTED_CODE.test(line)) {
			current = { kind: "code", line: index + 1, offset: start, text: line };
			blocks.push(current);
			previousBlank = false;
			continue;
		}
		current = { kind: "paragraph", line: index + 1, offset: start, text: line };
		blocks.push(current);
		previousBlank = false;
	}
	return blocks;
}

/** A path named in a block: the anchor a shorthand belongs to. */
export interface PathMention {
	/** The path as written, without a `:NN` suffix or a `#L` anchor. */
	path: string;
	/** Character offset of the mention within the block's text. */
	offset: number;
}

/** A URL's scheme (`https://`), so the authority can be dropped. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A `commit:path` prefix (`e8b29af:terraform/aws-mail/receipt.tf`). */
const COMMIT_PREFIX = /^[0-9a-f]{7,40}:(?=\S*[A-Za-z])/;

/**
 * Whether a path is a plausible FILE, which is stricter than
 * `isCitationPath`: the extension must be lowercase, so a dotted
 * identifier (`ReconcileClass.Expected`, `Foo.Bar`) is not read as the
 * anchor of a shorthand. v1's `path:NN` matcher keeps the looser test:
 * narrowing it would drop a citation v1 already refuses.
 */
export function isAnchorPath(path: string): boolean {
	if (!isCitationPath(path)) return false;
	const segments = path.split("/").filter((segment) => segment !== "");
	const last = segments[segments.length - 1] ?? "";
	const extension = /\.[A-Za-z][A-Za-z0-9]{0,7}$/.exec(last);
	if (extension === null) return true;
	if (extension[0] !== extension[0].toLowerCase()) return false;
	// `e.g` and `i.e` are prose, not files: a single-segment token needs
	// a two-character extension (`.sh`, `.go`, `.md` — not `.g`).
	return segments.length > 1 || extension[0].length >= 3;
}

/**
 * Strip the punctuation a path may be wrapped in inside prose. Backticks
 * are removed ANYWHERE, because a note writes a code-spanned path with
 * the line number outside the span (`pc-slice.timer.j2`:7-11), and a
 * path never contains a backtick.
 */
function trimToken(token: string): string {
	return token
		.replaceAll("`", "")
		.replace(/^[([{<"'*_,;!?]+/, "")
		.replace(/[)\]}>"'*_,.;:!?]+$/, "")
		.replace(/['\u2019]s$/, "");
}

/**
 * The path a token names, or null. A token may be a bare path
 * (`tools/merge-pr.sh`), a v1 citation (`tools/merge-pr.sh:2081`), a
 * `#L`-anchored path, or a URL whose pathname ends in a file
 * (`https://github.com/o/r/blob/<hex>/tools/x.sh#L12`).
 */
export function namedPath(token: string): string | null {
	const trimmed = trimToken(token);
	if (trimmed === "") return null;
	if (URL_SCHEME.test(trimmed) || trimmed.startsWith("www.")) {
		const withoutScheme = trimmed.replace(URL_SCHEME, "");
		const slash = withoutScheme.indexOf("/");
		if (slash === -1) return null;
		const pathname = withoutScheme.slice(slash + 1).split(/[?#]/)[0] ?? "";
		const blob = /\/blob\/[^/]+\/(.+)$/.exec(pathname);
		if (blob !== null) {
			const candidate = blob[1] ?? "";
			return isCitationPath(candidate) ? candidate : null;
		}
		const segments = pathname.split("/").filter((segment) => segment !== "");
		const last = segments[segments.length - 1] ?? "";
		return isCitationPath(last) ? last : null;
	}
	const withoutCommit = trimmed.replace(COMMIT_PREFIX, "");
	const withoutAnchor = withoutCommit.split("#")[0] ?? "";
	// A chain ("migrate_test.go:49/:58") names the file once and then
	// repeats the line numbers, so a trailing run of ":NN" and "/" is the
	// line part, not the path.
	const withoutLine = withoutAnchor.replace(/(?::\d+(?:-\d+)?|\/)+$/, "");
	return isAnchorPath(withoutLine) ? withoutLine : null;
}

/**
 * Every `:N` / `:N-M` shorthand hit whose block names a path earlier,
 * in document order. Pure: no filesystem, no context.
 */
export function scanShorthands(text: string): Citation[] {
	const hits: Citation[] = [];
	for (const block of splitBlocks(text)) {
		const mentions: PathMention[] = [];
		for (const tokenMatch of block.text.matchAll(/\S+/g)) {
			const path = namedPath(tokenMatch[0]);
			if (path !== null) {
				mentions.push({ path, offset: tokenMatch.index ?? 0 });
			}
		}
		if (mentions.length === 0) continue;
		for (const match of block.text.matchAll(SHORTHAND)) {
			const boundary = match[1] ?? "";
			const at = (match.index ?? 0) + boundary.length;
			const start = match[2] ?? "";
			const end = match[3];
			const length = match[0].length - boundary.length;
			if (block.text[at + length] === ":" && NUMERIC_EMOJI.has(start)) {
				continue;
			}
			const anchor = mentions.filter((mention) => mention.offset < at).pop();
			if (anchor === undefined) continue;
			const before = block.text.slice(0, at);
			const newlines = before.split("\n").length - 1;
			hits.push({
				kind: "shorthand",
				offset: block.offset + at,
				line: block.line + newlines,
				path: anchor.path,
				lines: end === undefined ? start : `${start}-${end}`,
				text: match[0].slice(boundary.length),
				inFence: block.kind === "fence",
				permalink: false,
				anchor: anchor.path,
			});
		}
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Near misses: every `:N` the matcher refuses to read as a citation
// ---------------------------------------------------------------------------

/** Why a `:N` in a body is NOT a shorthand citation. */
export interface ShorthandMiss {
	/** 1-based line number. */
	line: number;
	/** The candidate text (`:30`, `:8080`, `:100`). */
	text: string;
	/** Which rule rejected it, in words. */
	reason: string;
}

/** Every `:N` / `:N-M` candidate, matched or not (for the reasons). */
const CANDIDATE = /:(\d{1,5})(?:[-\u2013](\d{1,5}))?/g;

/** A character that licenses a shorthand colon. */
const BOUNDARY = /[\s([{`<,;/]/;

/** Why the character BEFORE the colon disqualifies it. */
const PRECEDING_REASON: Readonly<Record<string, string>> = {
	":": "IPv6 or a double colon",
	".": "a dotted token",
	'"': "a quoted key (JSON/YAML)",
	"'": "a quoted value",
	"]": "an IPv6 literal",
	">": "a placeholder host with a port",
	")": "a closing bracket",
	"}": "a closing brace",
	"#": "an anchor",
	"_": "an identifier",
	"+": "an emoji shortcode",
	"-": "a hyphenated word",
};

/**
 * Every `:N` in the body that the matcher does NOT read as a shorthand,
 * with the rule that rejected it. This is the false-positive ledger: it
 * exists so a test can pin WHY a clock time, a ratio, an IPv6 literal, a
 * host:port, a quoted YAML/JSON key, a lens label or an emoji shortcode
 * is skipped, instead of only pinning that it is.
 */
export function shorthandMisses(text: string): ShorthandMiss[] {
	const misses: ShorthandMiss[] = [];
	for (const block of splitBlocks(text)) {
		const mentions: PathMention[] = [];
		for (const tokenMatch of block.text.matchAll(/\S+/g)) {
			const path = namedPath(tokenMatch[0]);
			if (path !== null) {
				mentions.push({ path, offset: tokenMatch.index ?? 0 });
			}
		}
		for (const match of block.text.matchAll(CANDIDATE)) {
			const at = match.index ?? 0;
			const end = at + match[0].length;
			const line =
				block.line + (block.text.slice(0, at).split("\n").length - 1);
			const previous = at === 0 ? "" : (block.text[at - 1] ?? "");
			const next = block.text.slice(end, end + 1);
			if (previous !== "" && !BOUNDARY.test(previous)) {
				const named = PRECEDING_REASON[previous];
				misses.push({
					line,
					text: match[0],
					reason:
						named ??
						(/[0-9]/.test(previous)
							? "a clock time or a ratio (a digit is glued to the colon)"
							: "a word or a host:port (a letter is glued to the colon)"),
				});
				continue;
			}
			if (/[A-Za-z0-9_]/.test(next)) {
				misses.push({
					line,
					text: match[0],
					reason: "the number runs into a word or another digit",
				});
				continue;
			}
			if (next === ":" && NUMERIC_EMOJI.has(match[1] ?? "")) {
				misses.push({ line, text: match[0], reason: "an emoji shortcode" });
				continue;
			}
			if (next === "-" || next === "\u2013") {
				misses.push({ line, text: match[0], reason: "a dangling dash" });
				continue;
			}
			if (mentions.filter((mention) => mention.offset < at).length === 0) {
				misses.push({
					line,
					text: match[0],
					reason: "no path named earlier in the same block",
				});
			}
		}
	}
	return misses;
}

/** The scan's verdict: every hit, and the subset the gate refuses. */
export interface CitationScan {
	/** Every `path:N` hit, in document order. */
	all: Citation[];
	/** The hits that survive every exemption (the refused ones). */
	refused: Citation[];
}

/**
 * Scan a body and apply the two per-body exemptions: a commit-pinned
 * permalink (a) and — when `fencedCode` is "exempt" — a fenced code
 * block (c). The transition (date) is a BODY-level exemption and lives
 * in `citationRefusal`, because it needs the frontmatter.
 */
export function citationScan(
	body: string,
	options: CitationGateArgs = {},
): CitationScan {
	const fenced = options.fencedCode ?? EXEMPT_FENCED_CODE;
	const all = [...scanCitations(body), ...scanShorthands(body)].sort(
		(left, right) => left.offset - right.offset,
	);
	const refused = all.filter(
		(hit) => !hit.permalink && !(fenced === "exempt" && hit.inFence),
	);
	return { all, refused };
}

// ---------------------------------------------------------------------------
// The note body: the strip mirror, the head line, the frontmatter date
// ---------------------------------------------------------------------------

/**
 * JS mirror of the pinned perl body-strip (`BODY_STRIP` in
 * @cad0p/pi-steering-github): drop a leading YAML frontmatter block
 * (BOM-tolerant, CRLF-tolerant) plus the blank lines after it, then the
 * leading ATX H1 plus the blank lines after it. Pinned against the real
 * perl one-liner in the test file, so the mirror cannot drift from what
 * gh actually uploads.
 */
const FRONTMATTER =
	/^(?:\uFEFF)?---\r?\n(?:.*?\r?\n)?(?:---|\.\.\.)\r?\n(?:\r?\n)*(?:[ \t]*\r?\n)*(?:#(?!\S)[^\n]*(?:\r?\n)?(?:[ \t]*\r?\n)*)?/s;

/** The body gh uploads for a note (frontmatter + leading H1 stripped). */
export function stripNoteBody(text: string): string {
	return text.replace(FRONTMATTER, "");
}

/** The frontmatter `date:` value (YYYY-MM-DD), or null. */
export function frontmatterDate(text: string): string | null {
	const match = /^date:\s*(.+)$/m.exec(text);
	if (match === null) return null;
	const iso = /\d{4}-\d{2}-\d{2}/.exec(match[1] ?? "");
	return iso === null ? null : (iso[0] ?? null);
}

/**
 * The 40-hex head a body's FIRST non-blank line names, or null
 * (exemption b). Leading blank lines are tolerated; the line itself must
 * carry a standalone 40-hex token.
 */
export function firstLineHead(body: string): string | null {
	for (const line of body.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const match = HEAD40.exec(line);
		return match === null ? null : (match[0] ?? null);
	}
	return null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** One body the command would post. */
export interface BodySource {
	/** What the refusal names: the note path, or the flag the text came from. */
	where: string;
	/** The text as posted (note bodies already stripped). */
	body: string;
	/** The note's frontmatter date, when the body came from a file. */
	date: string | null;
}

/** A refusal: the body, the hits, and the count. */
export interface CitationRefusal {
	/** What the refusal names. */
	where: string;
	/** The refused hits, in document order. */
	hits: Citation[];
	/** How many refused hits sit inside a fenced code block. */
	inFence: number;
	/** How many of the refused hits are `:NN` shorthands. */
	shorthands: number;
}

/**
 * Why this body is refused, or null. Applies the body-level exemptions
 * in order: the transition (a note dated before the activation date),
 * then the head binding (b), then the per-hit scan (permalink a, fence c).
 */
export function citationRefusal(
	source: BodySource,
	options: CitationGateArgs = {},
): CitationRefusal | null {
	const activation = options.activationDate ?? ACTIVATION_DATE;
	if (source.date !== null && source.date < activation) return null;
	if (firstLineHead(source.body) !== null) return null;
	const scan = citationScan(source.body, options);
	if (scan.refused.length === 0) return null;
	return {
		where: source.where,
		hits: scan.refused,
		inFence: scan.refused.filter((hit) => hit.inFence).length,
		shorthands: scan.refused.filter((hit) => hit.kind === "shorthand").length,
	};
}

/** Clip a line for a message. */
function clip(text: string, limit = 120): string {
	const trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}...`;
}

/** A plausible symbol name for a path, for the message's example. */
function symbolHint(path: string): string {
	const last = path.split("/").pop() ?? path;
	const base = last.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_]+/g, "_");
	return `${base === "" ? "the_function" : base}()`;
}

/**
 * The refusal message: every offending line (first `MAX_REPORTED`), the
 * count, and the two fixes. `slug` is the `owner/repo` the permalink
 * example is built for.
 */
export function renderCitationReason(
	refusal: CitationRefusal,
	slug: string | null,
	options: CitationGateArgs = {},
): string {
	const activation = options.activationDate ?? ACTIVATION_DATE;
	const shown = refusal.hits.slice(0, MAX_REPORTED);
	const example = shown[0]?.path.replace(/^\.\//, "") ?? "tools/merge-pr.sh";
	const exampleLine = (shown[0]?.lines ?? "2081").split("-")[0] ?? "2081";
	const lines = shown.map((hit) =>
		hit.kind === "shorthand"
			? `  line ${hit.line}: ${clip(hit.text)} (a shorthand for ${hit.anchor ?? hit.path})`
			: `  line ${hit.line}: ${clip(hit.text)}`,
	);
	if (refusal.hits.length > shown.length) {
		lines.push(`  ... and ${refusal.hits.length - shown.length} more`);
	}
	if (refusal.inFence > 0) {
		lines.push(
			`${refusal.inFence} of them sit inside a fenced code block: quoted output is exempt only while EXEMPT_FENCED_CODE is "exempt", and this body was graded with "scan".`,
		);
	}
	const forms: string[] = [];
	if (refusal.hits.length - refusal.shorthands > 0) forms.push("a bare path:NN");
	if (refusal.shorthands > 0) {
		forms.push(
			"a bare :NN shorthand (a line number written after a path was named earlier in the same paragraph)",
		);
	}
	return [
		`${refusal.where} cites code by a bare line number (${refusal.hits.length} hit${refusal.hits.length === 1 ? "" : "s"}): ${forms.join(" and ")}. Line numbers move as the file changes, so the pointer goes stale and the reader has to re-derive it.`,
		...lines,
		"Cite the code one of two ways:",
		`  a permalink pinned to the commit: https://github.com/${slug ?? "<owner>/<repo>"}/blob/<40-hex>/${example}#L${exampleLine}`,
		`  or the symbol: ${symbolHint(example)} in ${example}`,
		`A body whose first non-blank line names the head (Lens: functional @ <40-hex>) is bound to one commit and is not refused; a note whose frontmatter date is before ${activation} is exempt.`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// The gh side: which bodies would this command post?
// ---------------------------------------------------------------------------

/** The `gh` sequences whose body this rule grades. */
export const GH_BODY_SEQUENCES = [
	["pr", "create"],
	["pr", "new"],
	["pr", "edit"],
	["pr", "comment"],
	["issue", "create"],
	["issue", "new"],
	["issue", "edit"],
	["issue", "comment"],
	["api"],
] as const;

/** The argument words of the evaluated command, unquoted. */
function words(ctx: PredicateContext): string[] {
	const args = (ctx.input.args ?? []) as ReadonlyArray<{
		text?: string;
		value?: string;
	}>;
	return args.map((word) => word.value ?? word.text ?? "");
}

/** The first value of any of `flags` (space or `=` form), or null. */
function flagValue(
	argv: readonly string[],
	flags: readonly string[],
): string | null {
	for (let index = 0; index < argv.length; index += 1) {
		const word = argv[index] ?? "";
		for (const flag of flags) {
			if (word === flag) return argv[index + 1] ?? "";
			if (word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
		}
	}
	return null;
}

/** Every value of any of `flags`, in argv order. */
function flagValues(
	argv: readonly string[],
	flags: readonly string[],
): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const word = argv[index] ?? "";
		for (const flag of flags) {
			if (word === flag) values.push(argv[index + 1] ?? "");
			else if (word.startsWith(`${flag}=`))
				values.push(word.slice(flag.length + 1));
		}
	}
	return values;
}

/** Read a file, or null (unreadable = not inspectable here). */
function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** A body read from a file path, with the note's date when it has one. */
function bodyFromPath(
	ctx: PredicateContext,
	path: string,
	quoted: boolean,
): BodySource | null {
	const absolute = resolveAgainstCwd(ctx, path, quoted);
	if (absolute === null) return null;
	const text = readOrNull(absolute);
	if (text === null) return null;
	return {
		where: absolute,
		body: stripNoteBody(text),
		date: frontmatterDate(text),
	};
}

/** `gh api` flags that consume the next word (so it is not the endpoint). */
const API_VALUE_FLAGS: readonly string[] = [
	"-X", "--method", "-f", "--raw-field", "-F", "--field", "--input", "-H",
	"--header", "-q", "--jq", "-t", "--template", "--hostname", "-p",
	"--preview", "--cache",
];

/** The endpoint positional of a `gh api` invocation. */
function apiEndpoint(argv: readonly string[]): string | null {
	const at = argv.indexOf("api");
	if (at === -1) return null;
	for (let index = at + 1; index < argv.length; index += 1) {
		const word = argv[index] ?? "";
		if (API_VALUE_FLAGS.includes(word)) {
			index += 1;
			continue;
		}
		if (word.startsWith("-")) continue;
		return word;
	}
	return null;
}

/**
 * Whether a `gh api` invocation writes a comment body: a POST (the
 * default once a parameter is added) or a PATCH of an existing comment.
 * A GET is a read.
 */
function apiWrites(argv: readonly string[]): boolean {
	const method = flagValue(argv, ["-X", "--method"]);
	if (method !== null && method !== "") {
		const upper = method.toUpperCase();
		return upper === "POST" || upper === "PATCH";
	}
	return flagValue(argv, ["-f", "--raw-field", "-F", "--field", "--input"]) !== null;
}

/** The bodies a `gh api` comment POST carries. */
function apiBodies(ctx: PredicateContext, argv: readonly string[]): BodySource[] {
	const bodies: BodySource[] = [];
	for (const field of flagValues(argv, ["-f", "--raw-field", "-F", "--field"])) {
		if (!field.startsWith("body=")) continue;
		const value = field.slice("body=".length);
		if (value.startsWith("@")) {
			const path = value.slice(1);
			if (path === "" || path === "-") continue; // stdin: not inspectable
			const source = bodyFromPath(ctx, path, false);
			if (source !== null) bodies.push(source);
			continue;
		}
		if (value !== "") {
			bodies.push({ where: "the api body field", body: value, date: null });
		}
	}
	const input = flagValue(argv, ["--input"]);
	if (input !== null && input !== "" && input !== "-") {
		const absolute = resolveAgainstCwd(ctx, input, false);
		const text = absolute === null ? null : readOrNull(absolute);
		if (text !== null) {
			try {
				const parsed = JSON.parse(text) as { body?: unknown };
				if (typeof parsed.body === "string" && parsed.body !== "") {
					bodies.push({ where: absolute ?? input, body: parsed.body, date: null });
				}
			} catch {
				// not JSON: the shipped rules own the shape, nothing to grade
			}
		}
	}
	return bodies;
}

/**
 * Every body this `gh` command would post, as the rule reads it.
 * Uninspectable bodies are absent (see the module's KNOWN GAPS).
 */
export function ghBodies(ctx: PredicateContext): BodySource[] {
	const argv = words(ctx);
	const bodies: BodySource[] = [];
	const inline = flagValue(argv, ["--body", "-b"]);
	if (inline !== null && inline !== "") {
		bodies.push({ where: "the --body value", body: inline, date: null });
	}
	// A context without walker-parsed args (a unit test, a non-bash
	// surface) must not throw here: a thrown predicate is "unknown" and
	// the engine blocks fail-closed, which would refuse a body this rule
	// cannot even see. No args = no body-file to read.
	const raw =
		Array.isArray(ctx.input.args) && ctx.input.args.length > 0
			? findBodyFileRawValue(ctx)
			: "";
	if (raw !== "") {
		const parsed = parseBodyFileArg(raw);
		if (parsed !== null) {
			const source = bodyFromPath(ctx, parsed.path, parsed.quoted);
			if (source !== null) bodies.push(source);
		}
	}
	if (argv.includes("api")) {
		const endpoint = apiEndpoint(argv);
		if (
			endpoint !== null &&
			/(?:^|\/)comments(?:\/\d+)?(?:\?|$)/.test(endpoint) &&
			apiWrites(argv)
		) {
			bodies.push(...apiBodies(ctx, argv));
		}
	}
	return bodies;
}

/** The `owner/repo` a permalink example is built for, or null. */
async function repoSlug(
	ctx: PredicateContext,
	argv: readonly string[],
): Promise<string | null> {
	const flag = flagValue(argv, ["-R", "--repo"]);
	if (flag !== null) {
		const parts = flag.split("/").filter((part) => part !== "");
		if (parts.length === 2) return parts.join("/");
		if (parts.length === 3) return parts.slice(1).join("/");
	}
	try {
		const result = await ctx.exec(
			"git",
			["config", "--get", "remote.origin.url"],
			{ cwd: ctx.cwd },
		);
		const url = result.stdout?.trim() ?? "";
		const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
		if (match !== null) return `${match[1]}/${match[2]}`;
	} catch {
		// no remote: the message falls back to <owner>/<repo>
	}
	return null;
}

/** Every refusal this command produces, in body order. */
function offences(
	ctx: PredicateContext,
	options: CitationGateArgs,
): CitationRefusal[] {
	const refusals: CitationRefusal[] = [];
	for (const source of ghBodies(ctx)) {
		const refusal = citationRefusal(source, options);
		if (refusal !== null) refusals.push(refusal);
	}
	return refusals;
}

/** The predicate: true when a body this command posts carries a bare citation. */
export const bodyHasBareCitation = async (
	args: unknown,
	ctx: PredicateContext,
): Promise<boolean> => {
	if (args === false) return false;
	const options =
		args === true || args === undefined ? {} : (args as CitationGateArgs);
	return offences(ctx, options).length > 0;
};

/** The rule's reason: the first refusal, with its offending lines. */
const citationReason = async (ctx: PredicateContext): Promise<string> => {
	const [refusal] = offences(ctx, {});
	if (refusal === undefined) {
		return "a PR/issue body may not cite code by a bare path:NN; use a permalink pinned to a commit, or name the symbol.";
	}
	const slug = await repoSlug(ctx, words(ctx));
	return renderCitationReason(refusal, slug);
};

export const noBareCitationPlugin = {
	name: "pinned-citation",
	predicates: { bodyHasBareCitation },
};

/**
 * The rule. `gh` routes through the descriptor owned by
 * @cad0p/pi-steering-github (already in the owner's config), so
 * `subcommand` and the flag facade resolve; `onUnknown: "allow"` keeps
 * an unextractable subcommand out of this rule (the shipped body-file
 * rules own that shape).
 */
export const noBareCitationRules = [
	{
		name: "no-bare-citation",
		tool: "bash",
		command: "gh",
		when: {
			subcommand: { anyOf: GH_BODY_SEQUENCES, onUnknown: "allow" },
			bodyHasBareCitation: true,
		},
		reason: citationReason,
	},
] as const satisfies readonly Rule[];
