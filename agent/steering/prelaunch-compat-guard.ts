// SPDX-License-Identifier: MIT
/**
 * pre-launch compatibility guard — a brief may not assume a compatibility
 * obligation nobody has.
 *
 * Twice a design was bent by a compatibility demand nobody owes:
 *
 *   1. 2026-11-03 (#148 item D): the design spent an option, a
 *      dual-accept window, a retirement ruling and a live fleet read on
 *      keeping old `pc-unlock/1` producers working. No tenant runs a
 *      slice. Owner, verbatim: "no enrolled slice is running it come
 *      on.. problems for nothing. just destroy the slice if it's there
 *      nothing is running".
 *   2. 2026-11-09 (pc-tenant #228): the orchestrator's design brief
 *      demanded the change work "without breaking verification of
 *      already-signed releases (0.3.0-0.3.5)", and the design agent
 *      ruled B (a deferred schema change) mostly on that premise.
 *      Owner, verbatim: "probably option A, there's no need to support
 *      any already signed release, we have no customers yet no one
 *      using it." and "so why was there that assumption?? any
 *      structural fix to that not happening again?".
 *
 * The rule lived in prose only (Goldmine reflections/2026-11-03-pre-
 * launch-no-compat-windows-for-things-nothing-runs.md: "every lens and
 * design brief states 'pre-launch: no tenant slices run; no
 * compatibility window is owed'"), so nothing enforced it. This gate
 * does. Standing owner direction 2026-11-06: "we've no customers asking
 * us for perfect uptime".
 *
 * The header contract. Every brief write (brief-gates.ts isBriefFile /
 * briefWrites: the write and edit tools, `tee`, and a `bash -c` /
 * `sh -c` payload that redirects or tees into briefs/) carries
 *
 *   consumers: <value>
 *
 * where the value is either
 *   (a) the pre-launch default, exactly
 *       "none — pre-launch: no tenant slices run; no compatibility
 *       window is owed" (a hyphen or en dash is accepted for the em
 *       dash, and runs of whitespace collapse — the words are what
 *       matter), or
 *   (b) a concrete RUNNING consumer, plus an `evidence:` line naming
 *       where it runs: a `path:line` or an http(s) URL.
 *
 * A bare "none" is NOT the default: it names no consumer and carries no
 * evidence, so it is refused with the exact default to write. A signed
 * release that exists is not a running consumer (that is the whole
 * lesson of #148 item D).
 *
 * The demand scan. With the pre-launch default, a brief whose text
 * DEMANDS compatibility work is refused: backwards compatibility,
 * already-signed releases, existing releases that must stay verifiable,
 * dual readers / dual-accept windows, compatibility / migration /
 * deprecation windows, and keeping the old producer/release/client/
 * schema working. The scan is line-scoped and a line that DISCLAIMS is
 * allowed — it contains "no compatibility", "not owed", "nothing runs"
 * or "pre-launch" — so the default line itself, and a brief that states
 * the rule, pass. Tuning notes from the real corpus (all 2632 briefs
 * and 141 design checks in the live state dir were scanned when this
 * landed: 11 briefs and 1 design check carry a demand — the nine #148
 * item D briefs, 228-design-ruling.md, this rule's own brief (it quotes
 * the incident) and the #228 design check; 1212 briefs predate the
 * header and would be refused on rewrite):
 *   - `\bdual` is anchored: "residual accepted" contains "dual
 *     accept" and matched the unanchored form;
 *   - a migration / deprecation window counts only on a line that also
 *     names a compatibility noun (schema, format, version, producer,
 *     consumer, reader, client, release, api, contract, manifest,
 *     protocol): the Debian plan's red-team briefs ask what "the
 *     migration window" opens up about hosts, which is not a
 *     compatibility obligation;
 *   - the header is read from the leading block only, so a `consumers:`
 *     line in the body does not satisfy the contract (the anti-bypass
 *     property: the compat demand cannot move to the body either).
 *
 * Design checks get the demand scan too (designChecksDir, no consumers
 * header): a check whose rationale repeats the obligation ("already-
 * signed releases must stay verifiable") is the artifact that bent #228,
 * so it is refused with the same rationale. Known gap, pinned in the
 * test file: a design check for a REAL consumer cannot state the
 * obligation either — the check has no consumers header to carry the
 * evidence, so the escape is the line-level disclaimer or moving the
 * consumer into the brief. Cheap to detect, not cheap to exempt.
 *
 * Known gap (shared with design-check-gate, pinned in its test file): a
 * top-level `cat > brief.md` redirect is invisible to pi-steering bash
 * rules, and a `tee -a` append's content is hidden (the gate reads the
 * existing file), so a demand appended through those shapes is not seen.
 * Write briefs with the write tool.
 */

import type { PredicateContext } from "@cad0p/pi-steering";
import type { BriefWrite } from "./brief-gates.ts";
import {
	briefContent,
	isBriefFile,
	isDesignCheckFile,
	parseBriefHeader,
	toolWrites,
} from "./brief-gates.ts";

declare global {
	interface PiSteeringPredicates {
		/**
		 * `when.prelaunchCompatViolation` — this tool call writes a brief
		 * (or a design check) that assumes a compatibility obligation
		 * nobody has: no `consumers:` header, a running consumer with no
		 * `evidence:`, or the pre-launch default plus a demand for
		 * compatibility work. Boolean leaf.
		 */
		prelaunchCompatViolation: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

/** The pre-launch default, exactly (the em dash is the canonical form). */
export const PRELAUNCH_DEFAULT =
	"none — pre-launch: no tenant slices run; no compatibility window is owed";

/** The reflection note this rule enforces. */
export const COMPAT_NOTE =
	"Goldmine reflections/2026-11-03-pre-launch-no-compat-windows-for-things-nothing-runs.md";

/** The owner's words, verbatim, with their dates and sources. */
export const OWNER_QUOTES =
	'owner 2026-11-03 (#148 item D): "no enrolled slice is running it come on.. problems for nothing. just destroy the slice if it\'s there nothing is running"; ' +
	'owner 2026-11-09 (pc-tenant #228): "probably option A, there\'s no need to support any already signed release, we have no customers yet no one using it." and "so why was there that assumption?? any structural fix to that not happening again?"; ' +
	'standing direction 2026-11-06: "we\'ve no customers asking us for perfect uptime"';

/**
 * A line that DISCLAIMS the obligation is allowed, even when it names a
 * compatibility shape: the default header line itself, and a brief that
 * states the rule ("no compatibility window is owed; nothing runs a
 * /1 producer").
 */
export const COMPAT_DISCLAIMER =
	/\bno compatibility|not owed|nothing runs|pre-?launch/i;

/** One compatibility demand a line can make. */
export interface CompatDemand {
	/** The phrase the refusal names. */
	name: string;
	/** What the line must match. */
	pattern: RegExp;
}

/** Demands that are compatibility work on their own. */
export const COMPAT_DEMANDS: readonly CompatDemand[] = [
	{ name: "backwards compatibility", pattern: /\bbackward(s)?[- ]compat/i },
	{ name: "an already-signed release", pattern: /\balready[- ]signed release/i },
	{
		name: "an existing release that must stay verifiable",
		pattern:
			/\bexisting release[^.\n]{0,60}\b(must|stay|remain)\b[^.\n]{0,60}\bverif/i,
	},
	{ name: "a dual reader or dual-accept window", pattern: /\bdual[- ](reader|accept)/i },
	{ name: "a compatibility window", pattern: /\bcompat(ibility)?[ -]window/i },
	{
		name: "keeping the old shape working",
		pattern:
			/\bkeep\b[^\n]*\bold (producer|release|client|schema)s?\b[^\n]*\bworking\b/i,
	},
];

/**
 * Migration / deprecation windows count only where the same line names a
 * compatibility noun: a host migration window is not a compatibility
 * obligation (the Debian plan's red-team briefs).
 */
export const WINDOW_DEMANDS: readonly CompatDemand[] = [
	{ name: "a migration or deprecation window", pattern: /\b(migration|deprecation)[ -]window\b/i },
];

/** The nouns that make a "window" a compatibility window. */
export const COMPAT_NOUN =
	/\b(schema|format|version|producer|consumer|reader|client|release|api|contract|manifest|protocol)\b/i;

/** One line of a brief (or design check) that demands compatibility work. */
export interface CompatHit {
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
	return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 157)}...`;
}

/**
 * The first line that demands compatibility work, skipping every line
 * that disclaims it. Line-scoped on purpose: the disclaimer and the
 * demand are read off the same line, so "no compatibility window is
 * owed" cannot be inherited by a neighbouring demand.
 */
export function compatDemand(content: string): CompatHit | null {
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (COMPAT_DISCLAIMER.test(line)) continue;
		for (const demand of COMPAT_DEMANDS) {
			if (demand.pattern.test(line)) {
				return { line: i + 1, phrase: demand.name, text: clip(line) };
			}
		}
		if (!COMPAT_NOUN.test(line)) continue;
		for (const demand of WINDOW_DEMANDS) {
			if (demand.pattern.test(line)) {
				return { line: i + 1, phrase: demand.name, text: clip(line) };
			}
		}
	}
	return null;
}

/** Normalize a `consumers:` value for the default comparison. */
export function normalizeConsumers(value: string): string {
	return value
		.replace(/[\u2013\u2014]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** Is this `consumers:` value the pre-launch default (dash-insensitive)? */
export function isPrelaunchDefault(value: string): boolean {
	return normalizeConsumers(value) === normalizeConsumers(PRELAUNCH_DEFAULT);
}

/**
 * Is this `evidence:` value a place a running consumer can be seen —
 * a `path:line` (optionally a line range) or an http(s) URL? A bare
 * path, a PR ref or a sentence is not evidence.
 */
export function evidenceValid(value: string | null): boolean {
	if (value === null) return false;
	const trimmed = value.trim();
	if (trimmed === "") return false;
	if (/^https?:\/\/\S+$/i.test(trimmed)) return true;
	return /^\S+:\d+(-\d+)?$/.test(trimmed);
}

/** The shared rationale: the note, the owner's words, the rule. */
function rationale(): string {
	return `Pre-launch no tenant slice runs, so no compatibility window is owed, and compatibility work starts when the first tenant does. Rule: ${COMPAT_NOTE}. ${OWNER_QUOTES}.`;
}

/** A brief with no `consumers:` line (or an empty one). */
function consumersMissingReason(write: BriefWrite): string {
	return `briefs need a 'consumers:' line in the header: 'consumers: ${PRELAUNCH_DEFAULT}' (the pre-launch default), or 'consumers: <the concrete running consumer>' plus 'evidence: <path:line or URL>'. ${rationale()} Add it to ${write.path}.`;
}

/** A compatibility demand under the default (or no) consumers header. */
function compatDemandReason(
	write: BriefWrite,
	hit: CompatHit,
	consumers: string | null,
): string {
	const header =
		consumers === null
			? "and its header carries no 'consumers:' line"
			: `but its header says 'consumers: ${consumers}'`;
	return `${write.path} line ${hit.line} demands compatibility work (${hit.phrase}: "${hit.text}") ${header}. ${rationale()} Delete the compatibility demand, or - if a real consumer runs - write 'consumers: <it>' and 'evidence: <path:line or URL>'. A signed release that exists is not a running consumer.`;
}

/** A named consumer with no usable evidence. */
function evidenceReason(write: BriefWrite, consumers: string): string {
	return `${write.path} names a running consumer ('consumers: ${consumers}') but no usable 'evidence:' line: add 'evidence: <path:line or URL>' naming where that consumer runs, or write 'consumers: ${PRELAUNCH_DEFAULT}' when nothing runs it. ${rationale()}`;
}

/** A design check whose rationale assumes the obligation. */
function designCheckReason(write: BriefWrite, hit: CompatHit): string {
	return `design check ${write.path} line ${hit.line} assumes a compatibility obligation nobody has (${hit.phrase}: "${hit.text}"). ${rationale()} Delete the assumption, or state the disclaimer on that line ('no compatibility', 'not owed', 'nothing runs', 'pre-launch').`;
}

/**
 * Why this brief write is refused, or null when it passes.
 *
 * The demand is read BEFORE the header: a brief that demands
 * compatibility work while naming no consumer is refused for the
 * demand, with the owner's words and the reflection note - that is the
 * substantive error, and the header is still required once the demand
 * is gone. A brief whose pr/round/kind header is incomplete is left to
 * design-check-gate (its header contract fires first), and a write whose
 * content the shell hides is left to it too (unverifiable).
 */
export function briefRefusal(write: BriefWrite): string | null {
	const content = briefContent(write);
	if (content === null) return null;
	const header = parseBriefHeader(content);
	if (!header.complete) return null;
	const consumers = header.consumers;
	const hit = compatDemand(content);
	if (consumers === null) {
		return hit === null
			? consumersMissingReason(write)
			: compatDemandReason(write, hit, null);
	}
	if (isPrelaunchDefault(consumers)) {
		return hit === null ? null : compatDemandReason(write, hit, consumers);
	}
	// A named running consumer: the demand is legitimate once it is
	// evidenced. No evidence, no exemption.
	if (evidenceValid(header.evidence)) return null;
	return evidenceReason(write, consumers);
}

/** Why this design-check write is refused, or null when it passes. */
export function designCheckRefusal(write: BriefWrite): string | null {
	const content = briefContent(write);
	if (content === null) return null;
	const hit = compatDemand(content);
	return hit === null ? null : designCheckReason(write, hit);
}

/** One refused write of this tool call. */
interface Offence {
	path: string;
	reason: string;
}

/** Every refused write this tool call performs (briefs + design checks). */
function offences(ctx: PredicateContext): Offence[] {
	const out: Offence[] = [];
	for (const write of toolWrites(ctx)) {
		if (isBriefFile(write.path)) {
			const reason = briefRefusal(write);
			if (reason !== null) out.push({ path: write.path, reason });
			continue;
		}
		if (isDesignCheckFile(write.path)) {
			const reason = designCheckRefusal(write);
			if (reason !== null) out.push({ path: write.path, reason });
		}
	}
	return out;
}

export const prelaunchCompatPlugin = {
	name: "prelaunch-compat",
	predicates: {
		prelaunchCompatViolation: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return offences(ctx).length > 0;
		},
	},
};

function reason(ctx: PredicateContext): string {
	const first = offences(ctx)[0];
	if (first !== undefined) return first.reason;
	return `briefs need a 'consumers:' line in the header: 'consumers: ${PRELAUNCH_DEFAULT}', or 'consumers: <the concrete running consumer>' plus 'evidence: <path:line or URL>'. ${rationale()}`;
}

export const prelaunchCompatRules = [
	{
		name: "prelaunch-compat-gate",
		tool: "write" as const,
		field: "path" as const,
		// `pattern` cannot see the briefs / design-checks dirs, so it must
		// not pre-filter: the predicate resolves the path and checks.
		pattern: /^/,
		when: { prelaunchCompatViolation: true },
		reason,
	},
	{
		name: "prelaunch-compat-gate-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { prelaunchCompatViolation: true },
		reason,
	},
	{
		name: "prelaunch-compat-gate-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { prelaunchCompatViolation: true },
		reason,
	},
];
