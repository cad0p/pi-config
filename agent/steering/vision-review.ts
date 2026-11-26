// SPDX-License-Identifier: MIT
/**
 * vision review - a lens may not answer with a bare "FIT".
 *
 * The incident (pc-host #983). A trio shipped "Vision: FIT" for work
 * that was treating "the host cannot `incus exec` into the guest" as
 * a defect to fix. The vision says the host is the adversary, so the
 * ABSENCE of a host-to-guest execution path is the invariant, not the
 * defect. The merge helper checks only that a `Vision:` line EXISTS - it
 * cannot grade it - so the only control that makes a vision review real
 * is the brief and the verdict. Today's briefs asked for
 *
 *     Vision: FIT|MOSTLY-FIT|MISFIT
 *
 * which is wrong three ways: the third token is UNFIT, there is no
 * reason sentence, and nothing requires the reviewer to NAME the
 * invariants in scope and answer each with evidence.
 *
 * Three rules, one module.
 *
 * 1. vision-review-section. A brief handed to a lens agent (`kind: lens`)
 *    must carry a `## VISION REVIEW` section that names the candidate
 *    invariants by id from the canonical list, states the answer shape
 *    per invariant (the id, one verdict word, and the evidence: a
 *    file:line, a measured number, or an artifact), asks which
 *    candidates are out of scope and why, and spells the token set
 *    FIT | MOSTLY-FIT | UNFIT (UNFIT, never MISFIT). Refused at write
 *    time with the text to add. Surfaces: write / edit / tee and a
 *    `bash -c` payload, like the design-check gate.
 *
 * 2. vision-verdict-shape. A posted `Vision:` line must name at least one
 *    invariant id from the canonical list and carry a reason.
 *    "Vision: FIT", "Vision: FIT - reviewed" and a verdict naming an id
 *    that does not exist (V18) are refused. Surface: `gh pr comment` -
 *    where a lens verdict is posted. There is NO separate write-time
 *    rule for the first `Lens:` line in this tree (base-rules.ts parses
 *    that line when it COUNTS posted rounds; design-check-gate.ts reads
 *    posted verdicts for a fold; the shipped github plugin inspects
 *    issue/PR BODIES, never `gh pr comment`), so this rule is the one
 *    place a verdict body is inspected at post time, and the pure check
 *    (visionVerdictRefusal) is importable by any rule that wants it.
 *
 * 3. vision-drift-invariant. A brief, note or PR/issue body that
 *    PROPOSES making a host-to-guest execution path work must cite the
 *    invariant it would violate (V4) and say how the proposal satisfies
 *    it; otherwise it is refused, and the refusal names V4. How a fact
 *    is told from a proposal: the scan is sentence-scoped and the DENIAL
 *    is read off the clause that names the path ("`incus exec` does not
 *    work", "the host cannot `incus exec` into the guest", "no
 *    host-to-guest path") - a statement of fact is not a proposal and
 *    passes, which is what keeps docs/host-teleport-recovery.md and
 *    docs/host-watchdogs.md legal. A sentence is a proposal when its
 *    path clause is not denied AND the demand sits in that clause or
 *    in one that FOLLOWS it (make ... work, add, support, provide,
 *    enable, route, fix, should, must, need), or when it asserts the
 *    path outright ("the host can run commands in the guest"). A denial
 *    excuses its own clause; a demand AFTER it is the incident's shape
 *    ("the host cannot incus exec into the guest, a gap we must fix"),
 *    while a demand BEFORE a denied clause is the invariant being
 *    specified ("Any signal must be host-side, never an in-guest
 *    agent") and does not count - clause order separates the two.
 *    "does not work" is a fact; "does not work yet" commits to the path
 *    arriving and is a proposal. A question is not a proposal. A
 *    sentence that cites V4 and how the design satisfies it ("started
 *    by the tenant", "by design") is allowed.
 *
 * Known gaps (pinned in vision-review.test.ts): a top-level
 * `cat > note.md` redirect is invisible to pi-steering bash rules (same
 * gap as brief-gates.ts); a `--body-file <(perl ...)` substitution cannot
 * be read here (the shipped body-file rules own that path); and a
 * `gh pr comment` with no `--body` / `--body-file` (stdin or an editor) is
 * not inspectable.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PredicateContext } from "@cad0p/pi-steering";
import { resolveAgainstCwd } from "@cad0p/pi-steering-github";
import type { BriefWrite } from "./brief-gates.ts";
import { briefContent, parseBriefHeader, toolWrites } from "./brief-gates.ts";

declare global {
	interface PiSteeringPredicates {
		/**
		 * `when.briefNeedsVisionReview` - this tool call writes a
		 * `kind: lens` brief whose VISION REVIEW section is missing or
		 * unusable.
		 */
		briefNeedsVisionReview: import("@cad0p/pi-steering").PredicateShape<boolean>;
		/**
		 * `when.prCommentNeedsVisionVerdict` - this `gh pr comment` carries
		 * a `Vision:` line that names no invariant, no reason, or an id
		 * outside the canonical list.
		 */
		prCommentNeedsVisionVerdict: import("@cad0p/pi-steering").PredicateShape<boolean>;
		/**
		 * `when.proposalNeedsVisionInvariant` - this write or gh body
		 * proposes a host-to-guest execution path without citing the
		 * invariant it would violate.
		 */
		proposalNeedsVisionInvariant: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

/** The invariant this rule family is about (the adversary model). */
export const ADVERSARY_INVARIANT = "V4";

/**
 * The canonical list is the vault note, loaded at evaluation time - never a
 * copy (a copy is a second, drifting definition: pc-host #618 would move
 * the file and this rule would keep grading against rev 4). The path is
 * env-overridable (`PI_H4_INVARIANTS_FILE`) so the suite can feed a
 * synthetic document. A file that cannot be read is a named refusal, not a
 * fallback: no ids means no vision review, and pretending otherwise is the
 * fail-open this rule exists to remove.
 */
export function canonicalFile(): string {
	return (
		process.env.PI_H4_INVARIANTS_FILE ??
		join(
			process.env.HOME ?? homedir(),
			"personal/github/Goldmine/personal/github/pcad.it-infra/architecture/piercloud-product-invariants.md",
		)
	);
}

/** The ids and titles a canonical document declares (`### V4 — title`). */
export function parseInvariants(text: string): {
	ids: string[];
	titles: Record<string, string>;
} {
	const ids: string[] = [];
	const titles: Record<string, string> = {};
	const lineSplit = new RegExp('\\r?\\n');
	const heading = new RegExp('^#{1,6}\\s+([A-Z][A-Za-z0-9-]{0,11})\\s*(?:—|-{1,2}|–)\\s*(.+?)\\s*$');
	for (const line of text.split(lineSplit)) {
		const match = heading.exec(line);
		if (match === null) continue;
		const id = match[1] ?? "";
		if (id === "" || ids.includes(id)) continue;
		ids.push(id);
		titles[id] = match[2] ?? "";
	}
	return { ids, titles };
}

/** The mtime the cache was built from, and its answer. */
let cached: { mtimeMs: number; set: InvariantSet } | null = null;

/**
 * The canonical list, cached by the file's mtime: a revision (V18, V19)
 * is picked up on the next evaluation with NO code change, because the
 * cache key is the file's mtime, not a build-time constant. A stat or read
 * that fails returns `error` naming the path.
 */
export function loadInvariants(): InvariantSet {
	const path = canonicalFile();
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return { ids: [], titles: {}, source: path, error: path };
	}
	if (cached !== null && cached.mtimeMs === mtimeMs && cached.set.source === path) {
		return cached.set;
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { ids: [], titles: {}, source: path, error: path };
	}
	const parsed = parseInvariants(text);
	const set: InvariantSet =
		parsed.ids.length === 0
			? { ids: [], titles: {}, source: path, error: path }
			: { ids: parsed.ids, titles: parsed.titles, source: path, error: null };
	cached = { mtimeMs, set };
	return set;
}

/** The verdict tokens, in the order they are written. */
export const VISION_TOKENS = ["FIT", "MOSTLY-FIT", "UNFIT"] as const;

/** The token that shipped in briefs and is NOT a verdict. */
export const WRONG_TOKEN = "MISFIT";

/** The section heading a lens brief must carry. */
export const SECTION_HEADING = "## VISION REVIEW";

/** One resolved invariant list: its ids, titles, source, or the error. */
export interface InvariantSet {
	/** The ids the gate accepts, in list order. */
	ids: string[];
	/** The title each id declares, by id. */
	titles: Record<string, string>;
	/** The canonical file the ids were read from. */
	source: string;
	/** The path that could not be read, or null when the list loaded. */
	error: string | null;
}

/** The title of an id, or null. */
export function invariantSubject(id: string): string | null {
	return loadInvariants().titles[id] ?? null;
}

/** The refusal an unreadable canonical file produces (names the path). */
export function unreadableReason(set: InvariantSet): string {
	return (
		"cannot read the canonical invariants list at " +
		(set.error ?? set.source) +
		": the vision review grades against that file, and a copy in code would drift from it. Restore it (or point PI_H4_INVARIANTS_FILE at it); a lens brief and a 'Vision:' line are refused until the list is readable."
	);
}

/** Escape a regex literal. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^$()|[\]\\{]/g, "\\$&");
}

/** Read a file, or null. */
function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** The id shapes of a list, as a regex alternation (`V`, `I-`). */
function idAlternation(set: InvariantSet): string | null {
	const prefixes = [...new Set(set.ids.map((id) => id.replace(/\d+$/, "")))].filter(
		(prefix) => prefix !== "",
	);
	if (prefixes.length === 0) return null;
	return prefixes.map(escapeRegExp).join("|");
}

/** Every id of the list's shape that appears in `text` (may be unknown). */
export function idMentions(text: string, set: InvariantSet): string[] {
	const alternation = idAlternation(set);
	if (alternation === null) return [];
	const pattern = new RegExp("\\b(?:" + alternation + ")\\d+\\b", "g");
	return [...new Set(text.match(pattern) ?? [])];
}

/**
 * Why `text` names an id outside the list, or null. The shipped ids'
 * shape (`V<n>`) is read even when the repo's list uses another shape
 * (`I-<n>`), so "V4" in a mail repo is refused as an id outside that
 * repo's list rather than as a verdict naming no id at all.
 */
export function unknownId(text: string, set: InvariantSet): string | null {
	const mentions = idMentions(text, set);
	return mentions.find((id) => !set.ids.includes(id)) ?? null;
}

/** A list for a message: the ids, comma-separated, with the source. */
export function listLabel(set: InvariantSet): string {
	return set.ids.join(", ") + " (" + set.source + ")";
}

/** The id an example uses: the adversary-model invariant when present. */
export function exampleId(set: InvariantSet): string {
	return set.ids.includes(ADVERSARY_INVARIANT)
		? ADVERSARY_INVARIANT
		: (set.ids[0] ?? ADVERSARY_INVARIANT);
}

/** The answer shape the brief must state, with a real id from the list. */
export function answerShape(set: InvariantSet): string {
	return exampleId(set) + " FIT (<evidence: a file:line, a measured number, or an artifact>)";
}

/**
 * The canonical VISION REVIEW section (a template a brief can copy). The
 * tests use it too, so the gate and its fixtures cannot drift.
 */
export function visionSectionText(set: InvariantSet = loadInvariants()): string {
	return [
		SECTION_HEADING,
		"",
		"Candidates: " +
			set.ids.join(" ") +
			" (" +
			set.source +
			"). Answer every candidate, one line each: " +
			answerShape(set) +
			" - the id, one verdict word, and the evidence: a file:line, a measured number, or an artifact.",
		"",
		"Verdict words: FIT | MOSTLY-FIT | UNFIT (the third is UNFIT).",
		"",
		"Out of scope: name each candidate id you ruled out, and why.",
	].join("\n");
}

/** The VISION REVIEW section of a brief: its heading line and body text. */
export interface VisionSection {
	/** 1-based line of the heading. */
	line: number;
	/** The heading line as written. */
	heading: string;
	/** The lines after the heading, up to the next heading. */
	text: string;
}

/** Find the VISION REVIEW section (heading or bold label), or null. */
export function visionSection(content: string): VisionSection | null {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) =>
		/^\s*(?:#{1,6}\s*)?(?:[*_]{1,2})?\s*VISION[ -]REVIEW\b/i.test(line),
	);
	if (start === -1) return null;
	const heading = lines[start] ?? "";
	const hashes = /^\s*(#{1,6})/.exec(heading);
	const level = hashes?.[1]?.length ?? 0;
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const next = /^\s*(#{1,6})\s/.exec(line);
		if (next !== null && (level === 0 || (next[1]?.length ?? 0) <= level)) break;
		body.push(line);
	}
	return { line: start + 1, heading, text: body.join("\n") };
}

/** One line that names a canonical id, a verdict word, and evidence parens. */
function hasAnswerShape(text: string, set: InvariantSet): boolean {
	const alternation = idAlternation(set);
	if (alternation === null) return false;
	const shape = new RegExp(
		"\\b(?:" + alternation + ")\\d+\\s+(?:FIT|MOSTLY-FIT|UNFIT)\\s*\\(",
	);
	return shape.test(text);
}

/** Does the section say what evidence each answer needs? */
function namesEvidence(text: string): boolean {
	return /file:line/i.test(text) && /\b(?:measured|number|artifact)\b/i.test(text);
}

/**
 * Why a lens brief's VISION REVIEW section is unusable, or null when it
 * passes. Pure: the caller supplies the content, the list and the name
 * of the file the message names.
 */
export function visionSectionRefusal(
	content: string,
	set: InvariantSet,
	where: string,
): string | null {
	if (set.error !== null) return unreadableReason(set);
	const section = visionSection(content);
	if (section === null) {
		return (
			where +
			" is a lens brief with no '" +
			SECTION_HEADING +
			"' section. Add one that (1) names every candidate invariant by id from the canonical list " +
			listLabel(set) +
			"; (2) states the answer shape per invariant - '" +
			answerShape(set) +
			"' (the id, one verdict word, and the evidence: a file:line, a measured number, or an artifact); (3) asks which candidates are out of scope and why; (4) spells the token set FIT | MOSTLY-FIT | UNFIT, the third being UNFIT. The section must name real ids, not a prose summary."
		);
	}
	const text = section.text;
	const at = where + " line " + section.line + ": ";
	if (new RegExp("\\b" + WRONG_TOKEN + "\\b", "i").test(text)) {
		return (
			at +
			"the VISION REVIEW section says '" +
			WRONG_TOKEN +
			"', which is not a verdict word. The token set is FIT | MOSTLY-FIT | UNFIT - the third token is UNFIT. Replace the word, then answer each candidate id with '" +
			answerShape(set) +
			"'."
		);
	}
	const invented = unknownId(text, set);
	if (invented !== null) {
		return (
			at +
			"the VISION REVIEW section names " +
			invented +
			", which is not in the canonical list " +
			listLabel(set) +
			". Name only real ids: the section is what tells the reviewer which invariants are in scope."
		);
	}
	if (idMentions(text, set).length === 0) {
		return (
			at +
			"the VISION REVIEW section names no candidate invariant id. Name the ids in scope from the canonical list " +
			listLabel(set) +
			"."
		);
	}
	if (!hasAnswerShape(text, set)) {
		return (
			at +
			"the VISION REVIEW section does not state the answer shape. Add a line like '" +
			answerShape(set) +
			"': the id, one verdict word from FIT | MOSTLY-FIT | UNFIT, and the evidence."
		);
	}
	const missing = VISION_TOKENS.filter(
		(token) => !new RegExp("\\b" + token + "\\b").test(text),
	);
	if (missing.length > 0) {
		return (
			at +
			"the VISION REVIEW section does not carry the token set (missing " +
			missing.join(", ") +
			"). Write 'Verdict words: FIT | MOSTLY-FIT | UNFIT' - the reviewer answers one of those three for every candidate."
		);
	}
	const outOfScope = text
		.split(/\r?\n/)
		.some(
			(line) =>
				/out[ -]of[ -]scope/i.test(line) && /\b(?:why|because|reason)\b/i.test(line),
		);
	if (!outOfScope) {
		return (
			at +
			"the VISION REVIEW section never asks which candidates are out of scope. Add 'Out of scope: name each candidate id you ruled out, and why.' - a reviewer that silently drops an invariant is the failure this gate exists for."
		);
	}
	if (!namesEvidence(text)) {
		return (
			at +
			"the VISION REVIEW section does not say what evidence each answer needs. Name it: 'a file:line, a measured number, or an artifact'. A verdict with no evidence is the bare 'FIT' this gate refuses."
		);
	}
	return null;
}

/** One `Vision:` line of a verdict body. */
export interface VisionLine {
	/** 1-based line in the body. */
	line: number;
	/** The value after `Vision:`, trimmed. */
	value: string;
}

/** Words that are not a reason, for the reason floor below. */
const FILLER = new Set([
	"a", "all", "an", "and", "as", "above", "below", "by", "check", "checked",
	"clean", "done", "fine", "fit", "good", "in", "is", "it", "lgtm", "mostly",
	"n", "no", "none", "ok", "okay", "on", "review", "reviewed", "s", "same",
	"t", "the", "to", "unfit", "vision", "was", "yes",
]);

/** The fence marker a verdict body may use around a quoted template. */
const FENCE = /^\s*(?:`{3,}|~{3,})/;

/**
 * The `Vision:` lines of a body: column-0 lines only (an indented or
 * fenced line is a quotation, not a verdict). merge-pr.sh reads every
 * `^Vision:` line of a verdict; so does this.
 */
export function visionLines(body: string): VisionLine[] {
	const out: VisionLine[] = [];
	let fenced = false;
	const lines = body.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (FENCE.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const match = /^Vision:\s?(.*)$/.exec(line);
		if (match === null) continue;
		out.push({ line: i + 1, value: (match[1] ?? "").trim() });
	}
	return out;
}

/** The non-filler words of a reason (ids and verdict words removed). */
function reasonWords(value: string, set: InvariantSet): string[] {
	const alternation = idAlternation(set);
	const stripped =
		alternation === null
			? value
			: value.replace(new RegExp("\\b(?:" + alternation + ")\\d+\\b", "g"), " ");
	return stripped
		.replace(/\b(?:FIT|MOSTLY-FIT|UNFIT)\b/g, " ")
		.split(/[^A-Za-z]+/)
		.map((word) => word.toLowerCase())
		.filter((word) => word.length >= 2 && /[a-z]/.test(word) && !FILLER.has(word));
}

/**
 * Why a `Vision:` value is not a vision review, or null when it is one.
 * Pure: the caller supplies the value and the canonical list.
 *
 * A real verdict names at least one canonical invariant id and carries a
 * reason (four or more non-filler words beyond the ids and the verdict
 * word). "FIT", "FIT - reviewed" and an id outside the list are refused.
 */
export function visionVerdictRefusal(value: string, set: InvariantSet): string | null {
	if (set.error !== null) return unreadableReason(set);
	const trimmed = value.trim();
	const shape =
		"'Vision: " +
		exampleId(set) +
		" FIT (<what you checked: a file:line, a measured number, or an artifact>)'";
	if (trimmed === "") {
		return "the 'Vision:' line is empty. A vision review answers the invariants: " + shape + ".";
	}
	if (new RegExp("\\b" + WRONG_TOKEN + "\\b", "i").test(trimmed)) {
		return (
			"the 'Vision:' line says '" +
			WRONG_TOKEN +
			"', which is not a verdict word. The tokens are FIT | MOSTLY-FIT | UNFIT - the third is UNFIT."
		);
	}
	if (!/\b(?:FIT|MOSTLY-FIT|UNFIT)\b/.test(trimmed)) {
		return "the 'Vision:' line carries no verdict word. Use one of FIT | MOSTLY-FIT | UNFIT.";
	}
	const invented = unknownId(trimmed, set);
	if (invented !== null) {
		return (
			"the 'Vision:' line names " +
			invented +
			", which is not in the canonical list " +
			listLabel(set) +
			". Name the invariants you actually checked."
		);
	}
	if (idMentions(trimmed, set).length === 0) {
		return (
			"the 'Vision:' line names no invariant id - 'Vision: FIT' and 'Vision: FIT - reviewed' are exactly the answer this gate refuses. Name each invariant you checked, from " +
			listLabel(set) +
			", with its verdict and evidence: " +
			shape +
			"."
		);
	}
	const words = reasonWords(trimmed, set);
	if (words.length < 4) {
		return (
			"the 'Vision:' line names an invariant and a verdict but no reason (" +
			words.length +
			" word(s) beyond them). Say what you checked and the evidence: " +
			shape +
			"."
		);
	}
	return null;
}

/** One phrase a host-to-guest proposal can carry. */
interface DriftPhrase {
	/** The phrase the refusal names. */
	name: string;
	/** What the sentence must match. */
	pattern: RegExp;
	/** The phrase asserts the path on its own (no proposal verb needed). */
	assertive?: boolean;
}

/** Phrases that name a host-to-guest execution path (a mention, not a demand). */
export const DRIFT_PATH_PHRASES: readonly DriftPhrase[] = [
	{ name: "incus exec", pattern: /\bincus\s+exec\b/i },
	{ name: "a guest agent", pattern: /\bguest[- ]agent\b/i },
	{
		name: "exec into the guest",
		pattern: /\bexec(?:ute|uting)?\s+(?:in|into)\s+the\s+guest\b/i,
	},
];

/** Phrases that assert or demand the path on their own. */
export const DRIFT_ASSERTIVE_PHRASES: readonly DriftPhrase[] = [
	{
		name: "the host can run commands in the guest",
		pattern:
			/\bhost\b[^\n]{0,40}\b(?:can|may|could) run (?:commands|code|a command)\b[^\n]{0,30}\bguest\b/i,
		assertive: true,
	},
	{
		name: "a host-to-guest execution path",
		pattern: /\bhost[- ]to[- ]guest\b[^\n]{0,40}\b(?:exec|execution|command|shell|path)\w*/i,
		assertive: true,
	},
];

/**
 * The clause wants the path. Framing words alone ("broken", "a gap") are
 * deliberately absent: "incus exec is genuinely broken" (A1) is a
 * statement of fact, and refusing it taught nothing. A demand is a verb
 * or a modal - add/support/enable/fix/should/must/need.
 */
export const DRIFT_PROPOSAL =
	/\b(?:make|making)\b[^\n]{0,80}\bwork\b|\b(?:add|adds|adding|build|implement|support|provide|enable|allow|wire|route|expose|restore|re-?enable|fix|repair)\b|\b(?:should|must|need(?:s|ed)?|has to|have to|we want|we need|required)\b/i;

/**
 * The sentence commits to the path arriving ("does not work YET") even
 * though the path clause denies it: that is a proposal, not a fact.
 */
export const DRIFT_FRAMING =
	/\b(?:does not work yet|doesn'?t work yet|not implemented yet|needs? to work|should work|has to work|must work)\b/i;

/** The path is denied in this clause: a statement of fact, not a proposal. */
export const DRIFT_DENIAL =
	/\b(?:can\s*not|can['\u2019]t|can not|do(?:es)?\s*n['\u2019]?t|do(?:es)? not|never|no|not|without|forbidden|refused|rejected|blocked|denied|prohibited|banned|unavailable|impossible|unsupported|absent|removed)\b/i;

/** The sentence cites the invariant it would violate. */
export const DRIFT_CITATION = /\bV4\b/;

/** ... and says how the design satisfies it. */
export const DRIFT_SATISFACTION =
	/\bsatisf|honou?r|does not depart|no departure|non-departure|adversary|by design|on purpose|started by the (?:tenant|slice|guest)|tenant-started|slice-started|no host-started\b/i;

/** One sentence of a line that proposes a host-to-guest path. */
export interface DriftHit {
	/** 1-based line number. */
	line: number;
	/** The phrase the refusal names. */
	phrase: string;
	/** The line, trimmed and clipped for the message. */
	text: string;
}

/** Clip a line for a refusal message. */
function clip(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= 160 ? trimmed : trimmed.slice(0, 157) + "...";
}

/** Split a line into sentences (a full stop or a semicolon). */
function sentences(line: string): string[] {
	return line
		.split(/(?<=[.!?])\s+|\s*;\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence !== "");
}

/** The comma/parenthesis clause of a sentence that carries the path phrase. */
function clauseWith(sentence: string, pattern: RegExp): string {
	const clauses = sentence.split(/[,()\[\]\u2014]|\s+-\s+/);
	return clauses.find((clause) => pattern.test(clause)) ?? sentence;
}

/** The phrase one sentence proposes the path with, or null. */
function sentenceDrift(sentence: string): string | null {
	if (sentence.endsWith("?")) return null;
	if (DRIFT_CITATION.test(sentence) && DRIFT_SATISFACTION.test(sentence)) return null;
	const assertive = DRIFT_ASSERTIVE_PHRASES.find((phrase) => phrase.pattern.test(sentence));
	const mention = DRIFT_PATH_PHRASES.find((phrase) => phrase.pattern.test(sentence));
	const phrase = assertive ?? mention;
	if (phrase === undefined) return null;
	const clauses = sentence.split(/[,()\[\]\u2014]|\s+-\s+/);
	const pathAt = clauses.findIndex((other) => phrase.pattern.test(other));
	const clause = pathAt === -1 ? sentence : (clauses[pathAt] ?? sentence);
	const denied = DRIFT_DENIAL.test(clause);
	// A demand in the path clause, or in one that FOLLOWS it, is the
	// incident's shape ("the host cannot incus exec into the guest, a gap
	// we must fix"). A demand BEFORE a denied clause is the invariant
	// being specified ("Any signal must be host-side, never an in-guest
	// agent"), not a proposal - clause order is the difference.
	const after = pathAt === -1 ? [] : clauses.slice(pathAt + 1);
	const wants =
		DRIFT_PROPOSAL.test(clause) || after.some((other) => DRIFT_PROPOSAL.test(other));
	const framed = DRIFT_FRAMING.test(sentence);
	if (denied && !wants && !framed) return null;
	if (phrase.assertive === true) return phrase.name;
	if (!wants && !framed) return null;
	return phrase.name;
}

/**
 * The first sentence that proposes a host-to-guest execution path without
 * citing V4 and its satisfaction argument, or null. Pure.
 */
export function driftProposal(content: string): DriftHit | null {
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const namesPath =
			DRIFT_PATH_PHRASES.some((phrase) => phrase.pattern.test(line)) ||
			DRIFT_ASSERTIVE_PHRASES.some((phrase) => phrase.pattern.test(line));
		if (!namesPath) continue;
		for (const sentence of sentences(line)) {
			const phrase = sentenceDrift(sentence);
			if (phrase !== null) return { line: i + 1, phrase, text: clip(line) };
		}
	}
	return null;
}

/** The drift refusal: the invariant by id, and the two ways to pass. */
export function driftReason(where: string, hit: DriftHit): string {
	return (
		where +
		" line " +
		hit.line +
		" proposes making a host-to-guest execution path work (" +
		hit.phrase +
		': "' +
		hit.text +
		'"). The vision treats the host as the adversary and the tenant as the slice admin, so there is no host-to-guest execution path to build - invariant ' +
		ADVERSARY_INVARIANT +
		" (" +
		(invariantSubject(ADVERSARY_INVARIANT) ?? "the tenant administers the slice") +
		"). Cite the invariant this would violate and say how the proposal satisfies it (e.g. '" +
		ADVERSARY_INVARIANT +
		": the guest agent is started by the slice's own systemd, no host-started action enters the guest'), or state the fact ('incus exec does not work from the host')."
	);
}

/** Is this path a markdown note (the drift rule's write surface)? */
export function isNotePath(path: string): boolean {
	return /\.(?:md|markdown|mdx)$/i.test(path);
}

/** The gh subcommands whose body the drift rule reads. */
export const GH_BODY_SUBCOMMANDS = [
	["pr", "comment"],
	["pr", "create"],
	["pr", "new"],
	["pr", "edit"],
	["issue", "create"],
	["issue", "comment"],
	["issue", "edit"],
] as const;

/** The argument words of the evaluated command. */
function argWords(ctx: PredicateContext): string[] {
	return (ctx.input.args ?? []).map((word) => word.value ?? word.text ?? "");
}

/** One gh body this command carries, with the name the message uses. */
interface GhBody {
	body: string;
	where: string;
}

/**
 * The body a `gh` command carries: inline `--body`, or a readable
 * `--body-file`. A substitution (the pinned vault strip) and a missing
 * file are not readable here - the shipped body-file rules own those -
 * so the caller sees null and allows.
 */
export function ghBody(ctx: PredicateContext): GhBody | null {
	const words = argWords(ctx);
	const value = (flags: readonly string[]): string | null => {
		for (let i = 0; i < words.length; i += 1) {
			const word = words[i] ?? "";
			for (const flag of flags) {
				if (word === flag) return words[i + 1] ?? "";
				if (word.startsWith(flag + "=")) return word.slice(flag.length + 1);
			}
		}
		return null;
	};
	const inline = value(["--body", "-b"]);
	if (inline !== null && inline !== "") return { body: inline, where: "the gh body" };
	const file = value(["--body-file", "-F"]);
	if (file === null || file === "") return null;
	const path = resolveAgainstCwd(ctx, file);
	if (path === null) return null;
	const body = readOrNull(path);
	return body === null ? null : { body, where: path };
}

/** Why one md write is refused, or null. */
function noteRefusal(write: BriefWrite): string | null {
	if (!isNotePath(write.path)) return null;
	const content = briefContent(write);
	if (content === null) return null; // the shell hides the content: known gap
	const hit = driftProposal(content);
	if (hit === null) return null;
	const exemption = hostGuestExemption(content);
	if (exemption === "ok") return null;
	if (exemption === "bare") return bareExemptionReason(write.path);
	return driftReason(write.path, hit);
}

/** The frontmatter opt-out a meta-discussion of this rule must write. */
export const EXEMPTION_KEY = "host-guest-proposal";

/**
 * The explicit, mechanical exemption: a note whose subject IS the drift (a
 * rule, an investigation, an incident write-up) declares it in frontmatter
 * and is not refused for quoting the shape. Deny-by-default: the line must
 * be `host-guest-proposal: none - <reason>` with a real reason; a bare
 * "none" is refused, so the escape cannot become a silent blanket.
 */
export function hostGuestExemption(content: string): "absent" | "bare" | "ok" {
	const match = new RegExp("^" + EXEMPTION_KEY + ":\\s*(.*)$", "im").exec(content);
	if (match === null) return "absent";
	const value = (match[1] ?? "").trim();
	const reason = /^none\s*(?:[-—–:]\s*)?(.*)$/i.exec(value)?.[1]?.trim() ?? "";
	return /none/i.test(value) && reason.split(/\s+/).filter((word) => word.length > 2).length >= 2
		? "ok"
		: "bare";
}

/** The refusal for a bare `host-guest-proposal: none` (no reason). */
function bareExemptionReason(where: string): string {
	return (
		where +
		" carries a bare '" +
		EXEMPTION_KEY +
		":' line. The exemption is ' " +
		EXEMPTION_KEY +
		": none - <what this text is instead, e.g. 'the investigation note that quotes the shape'>': two or more words after 'none', so the escape names its subject and cannot become a silent blanket."
	);
}

/** Why a lens brief write is refused, or null. */
function lensSectionRefusal(write: BriefWrite): string | null {
	const content = briefContent(write);
	if (content === null) return null; // the header gate owns unverifiable writes
	const header = parseBriefHeader(content);
	if (!header.complete || header.kind !== "lens") return null;
	return visionSectionRefusal(content, loadInvariants(), write.path);
}

/** Every lens brief write this tool call performs that needs the section. */
function sectionOffences(ctx: PredicateContext): BriefWrite[] {
	return toolWrites(ctx).filter((write) => lensSectionRefusal(write) !== null);
}

/** Every md write that proposes the path without the invariant. */
function noteOffences(ctx: PredicateContext): BriefWrite[] {
	return toolWrites(ctx).filter((write) => noteRefusal(write) !== null);
}

/** The Vision: lines of this `gh pr comment` that are refused. */
function verdictOffences(ctx: PredicateContext): VisionLine[] {
	const body = ghBody(ctx);
	if (body === null) return [];
	const set = loadInvariants();
	return visionLines(body.body).filter(
		(line) => visionVerdictRefusal(line.value, set) !== null,
	);
}

/** The gh body this command carries that proposes the path. */
function ghDriftOffence(ctx: PredicateContext): DriftHit | null {
	const body = ghBody(ctx);
	if (body === null) return null;
	const hit = driftProposal(body.body);
	if (hit === null) return null;
	const exemption = hostGuestExemption(body.body);
	return exemption === "ok" ? null : hit;
}

/** The first refused lens brief, for the section gate's message. */
function sectionReason(ctx: PredicateContext): string {
	for (const write of sectionOffences(ctx)) {
		const reason = lensSectionRefusal(write);
		if (reason !== null) return reason;
	}
	return "a lens brief needs a '" + SECTION_HEADING + "' section naming the invariants by id.";
}

/** The first refused Vision: line, for the verdict gate's message. */
function verdictReason(ctx: PredicateContext): string {
	const body = ghBody(ctx);
	if (body === null) return "the 'Vision:' line is refused.";
	const set = loadInvariants();
	for (const line of visionLines(body.body)) {
		const reason = visionVerdictRefusal(line.value, set);
		if (reason !== null) {
			return (
				body.where +
				" line " +
				line.line +
				": " +
				reason +
				" A posted vision review names the invariants it checked and the evidence for each - a bare verdict is what this rule refuses."
			);
		}
	}
	return "the 'Vision:' line is refused.";
}

/** The first refused note / gh body, for the drift gate's message. */
function driftMessage(ctx: PredicateContext): string {
	for (const write of noteOffences(ctx)) {
		const content = briefContent(write);
		if (content === null) continue;
		if (hostGuestExemption(content) === "bare") return bareExemptionReason(write.path);
		const hit = driftProposal(content);
		if (hit !== null) return driftReason(write.path, hit);
	}
	const hit = ghDriftOffence(ctx);
	if (hit !== null) return driftReason(ghBody(ctx)?.where ?? "the gh body", hit);
	return "a host-to-guest execution path needs invariant " + ADVERSARY_INVARIANT + " named.";
}

export const visionReviewPlugin = {
	name: "vision-review",
	predicates: {
		briefNeedsVisionReview: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return sectionOffences(ctx).length > 0;
		},
		prCommentNeedsVisionVerdict: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return verdictOffences(ctx).length > 0;
		},
		proposalNeedsVisionInvariant: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return noteOffences(ctx).length > 0 || ghDriftOffence(ctx) !== null;
		},
	},
};

export const visionReviewRules = [
	{
		name: "vision-review-section",
		tool: "write" as const,
		field: "path" as const,
		// 'pattern' cannot see the briefs dir, so it must not pre-filter:
		// the predicate resolves the path and parses the header.
		pattern: /^/,
		when: { briefNeedsVisionReview: true },
		reason: sectionReason,
	},
	{
		name: "vision-review-section-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefNeedsVisionReview: true },
		reason: sectionReason,
	},
	{
		name: "vision-review-section-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { briefNeedsVisionReview: true },
		reason: sectionReason,
	},
	{
		// A lens verdict is posted on the PR; the helper reads its first line
		// and its 'Vision:' line, and only the second can be graded here.
		name: "vision-verdict-shape",
		tool: "bash" as const,
		command: "gh" as const,
		when: {
			subcommand: {
				anyOf: [["pr", "comment"]] as const,
				onUnknown: "allow" as const,
			},
			prCommentNeedsVisionVerdict: true,
		},
		reason: verdictReason,
	},
	{
		name: "vision-drift-invariant",
		tool: "write" as const,
		field: "path" as const,
		pattern: /\.(?:md|markdown|mdx)$/i,
		when: { proposalNeedsVisionInvariant: true },
		reason: driftMessage,
	},
	{
		name: "vision-drift-invariant-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /\.(?:md|markdown|mdx)$/i,
		when: { proposalNeedsVisionInvariant: true },
		reason: driftMessage,
	},
	{
		name: "vision-drift-invariant-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { proposalNeedsVisionInvariant: true },
		reason: driftMessage,
	},
	{
		name: "vision-drift-invariant-gh",
		tool: "bash" as const,
		command: "gh" as const,
		when: {
			subcommand: {
				anyOf: GH_BODY_SUBCOMMANDS,
				onUnknown: "allow" as const,
			},
			proposalNeedsVisionInvariant: true,
		},
		reason: driftMessage,
	},
];
