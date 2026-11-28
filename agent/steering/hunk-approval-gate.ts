// SPDX-License-Identifier: MIT
/**
 * The pc-host #1099 hunk-approval gates - the steering half of the partial
 * approval design (owner 2026-11-28: "this also needs the steering half as
 * well no?"; "the split must be a constant reminder"; "at round 3 and 5 the
 * design checks are going to say it"). The design (owner-agreed 2026-11-14):
 * every lens verdict carries one line `Blocking-hunks: <ids> | none` and a
 * hunk no lens lists is approved; the approved hunks can be trimmed and
 * landed, and the rest goes on as an ordinary split at round 1. Whether a
 * partial merge happens is ruled by the orchestrator after any trio or by
 * the design check at rounds 3 and 5, in a fixed `Partial-merge: yes | no —
 * <reason>` line. Both halves are enforced here because the lines only
 * exist when the brief asks for them and the check rules them:
 *
 *   1. lens-brief-blocking-hunks - a `kind: lens` brief write whose body
 *      never asks for the `Blocking-hunks:` line is refused. The token is
 *      read from the BODY, not the leading header block: the ask is an
 *      instruction to the reviewing lens, and a header key instructs no one
 *      (a `Blocking-hunks: none` header line is not a bypass). Every hunk
 *      the lens does not list is approved by that lens, and a hunk that
 *      only works with a blocked one is blocking too - the ask carries both
 *      halves of that rule, so a brief that drops it silently approves the
 *      whole diff. The hunk manifest comes from `tools/merge-pr.sh hunks`
 *      once pc-host #1551 lands; until then hunks are named
 *      `<path>:<start>-<end>` of the head's diff.
 *
 *   2. design-check-partial-merge - a design check at round 3 or 5 is
 *      refused unless it carries `Partial-merge:`. The round is read from
 *      the filename's `-r<N>` token - the name design-check-gate.ts reads
 *      the check by (rebound spellings like `-r3-rebound.md` included:
 *      a rewritten round-3 check is the round-3 check) - never from the
 *      file's prose, which the corpus shows naming the round in five
 *      different spellings and sometimes not at all. Files with no round
 *      token (ad-hoc rulings parked in the same directory) and rounds other
 *      than 3 and 5 are untouched.
 *
 * Both rules defer to design-check-gate on what it owns: a brief whose
 * header is unreadable or incomplete is its header-contract refusal, and a
 * brief write whose content the shell hides is its unverifiable refusal
 * (first-wins ordering puts this gate last, so the older rails speak
 * first). The design-checks directory has no such owner, so a round-3/5
 * check whose content cannot be verified is refused here instead - the
 * ruling cannot be confirmed missing or present (fail closed, the house
 * rule).
 *
 * Surfaces: the write / edit tools, `tee`, and a `bash -c` / `sh -c`
 * payload that redirects or tees into the briefs or design-checks dirs
 * (brief-gates.ts toolWrites). A top-level `cat > file` redirect is
 * invisible to pi-steering bash rules (documented in brief-gates.ts).
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
		 * `when.lensMissesBlockingHunks` - this tool call writes a
		 * `kind: lens` brief whose body never asks for the
		 * `Blocking-hunks:` verdict line (pc-host #1099). Boolean leaf.
		 */
		lensMissesBlockingHunks: import("@cad0p/pi-steering").PredicateShape<boolean>;
		/**
		 * `when.designCheckMissesPartialMerge` - this tool call writes a
		 * round-3 or round-5 design check that carries no `Partial-merge:`
		 * ruling (pc-host #1099). Boolean leaf.
		 */
		designCheckMissesPartialMerge: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

/**
 * The body of a brief: everything after the leading header block, in either
 * form brief-gates.ts headerBlock reads (YAML frontmatter or the leading
 * `key: value` lines). The blocking-hunks ask is an instruction to the
 * reviewing lens, so only the body carries it - a `Blocking-hunks:` line
 * inside the leading key:value block is a header key and instructs no one.
 */
export function briefBody(content: string): string {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() === "---") {
		for (let i = 1; i < lines.length; i += 1) {
			if (lines[i]?.trim() === "---") return lines.slice(i + 1).join("\n");
		}
		return "";
	}
	let end = 0;
	while (
		end < lines.length &&
		/^[A-Za-z][A-Za-z0-9 _-]*:/.test(lines[end] ?? "")
	) {
		end += 1;
	}
	return lines.slice(end).join("\n");
}

/** The ask the refusal tells the author to add, verbatim (pc-host #1099). */
export const BLOCKING_HUNKS_ASK =
	"Write one line `Blocking-hunks: <hunk ids> | none` (cad0p/pc-host#1099): every hunk you do not list is approved by you; list a hunk that only works with a blocked one too.";

/**
 * Why this brief write is refused, or null when it passes. Null too when
 * the write is design-check-gate's own refusal: an unreadable or incomplete
 * header, and a shell write whose content cannot be verified - first-wins
 * ordering lets the older rail speak, and this gate never double-refuses.
 */
export function blockingHunksRefusal(write: BriefWrite): string | null {
	const content = briefContent(write);
	if (content === null) return null;
	const header = parseBriefHeader(content);
	if (!header.complete) return null;
	if (header.kind !== "lens") return null;
	if (briefBody(content).includes("Blocking-hunks:")) return null;
	return (
		`the lens brief never asks for the blocking-hunks line (cad0p/pc-host#1099; owner 2026-11-28: the split must be a constant reminder). ` +
		`Add this line to the brief body: ${BLOCKING_HUNKS_ASK} ` +
		`The hunk manifest comes from ` +
		"`tools/merge-pr.sh hunks` once #1551 lands; until then, name hunks as `<path>:<start>-<end>` of the head's diff."
	);
}

/**
 * The round a design-check file is bound to, from the `-r<N>` token of its
 * filename - the name design-check-gate.ts reads the check by, rebound
 * spellings (`-r3-rebound.md`) included. The file's prose is never read
 * for this: the corpus names the round in five different spellings and
 * sometimes not at all, while the gate's lookup key is the filename.
 */
export function designCheckRound(path: string): number | null {
	const base = path.split("/").pop() ?? "";
	const match = /-r(\d+)(?=[-.])/i.exec(base);
	if (match === null) return null;
	return Number.parseInt(match[1] ?? "", 10);
}

/** The partial-merge ruling a round-3/5 design check must carry. */
export const PARTIAL_MERGE_RULING =
	"Partial-merge: yes | no — <reason>";

/**
 * Why this design-check write is refused, or null when it passes. Round 3
 * and round 5 only (owner 2026-11-28: "at round 3 and 5 the design checks
 * are going to say it"); a write whose content the shell hides is refused
 * rather than passed - no other gate reads the design-checks directory, so
 * the fail-closed refusal is this rule's own.
 */
export function partialMergeRefusal(write: BriefWrite): string | null {
	const round = designCheckRound(write.path);
	if (round !== 3 && round !== 5) return null;
	const content = briefContent(write);
	const what =
		`the design check must rule '${PARTIAL_MERGE_RULING}': which approved part lands now, which part goes on as a round-1 split (cad0p/pc-host#1099; owner 2026-11-28)`;
	if (content === null) {
		return `cannot verify the round-${round} design check through this shell write: use the write tool for ${write.path} - ${what}`;
	}
	if (content.includes("Partial-merge:")) return null;
	return `round ${round} design check carries no Partial-merge ruling: ${what}`;
}

/** One refused write of this tool call. */
interface Offence {
	path: string;
	reason: string;
}

/** Every lens brief this tool call writes without the blocking-hunks ask. */
function lensOffences(ctx: PredicateContext): Offence[] {
	const out: Offence[] = [];
	for (const write of toolWrites(ctx)) {
		if (!isBriefFile(write.path)) continue;
		const reason = blockingHunksRefusal(write);
		if (reason !== null) out.push({ path: write.path, reason });
	}
	return out;
}

/** Every round-3/5 design check this tool call writes without the ruling. */
function designCheckOffences(ctx: PredicateContext): Offence[] {
	const out: Offence[] = [];
	for (const write of toolWrites(ctx)) {
		if (!isDesignCheckFile(write.path)) continue;
		const reason = partialMergeRefusal(write);
		if (reason !== null) out.push({ path: write.path, reason });
	}
	return out;
}

export const hunkApprovalPlugin = {
	name: "hunk-approval",
	predicates: {
		lensMissesBlockingHunks: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return lensOffences(ctx).length > 0;
		},
		designCheckMissesPartialMerge: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return designCheckOffences(ctx).length > 0;
		},
	},
};

function lensReason(ctx: PredicateContext): string {
	const first = lensOffences(ctx)[0];
	if (first !== undefined) return first.reason;
	return `the lens brief never asks for the blocking-hunks line. ${BLOCKING_HUNKS_ASK}`;
}

function designCheckReason(ctx: PredicateContext): string {
	const first = designCheckOffences(ctx)[0];
	if (first !== undefined) return first.reason;
	return `the design check must rule '${PARTIAL_MERGE_RULING}' (cad0p/pc-host#1099)`;
}

export const hunkApprovalRules = [
	{
		name: "lens-brief-blocking-hunks",
		tool: "write" as const,
		field: "path" as const,
		// `pattern` cannot see the briefs dir, so it must not pre-filter:
		// the predicate resolves the path and does the exact check.
		pattern: /^/,
		when: { lensMissesBlockingHunks: true },
		reason: lensReason,
	},
	{
		name: "lens-brief-blocking-hunks-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { lensMissesBlockingHunks: true },
		reason: lensReason,
	},
	{
		name: "lens-brief-blocking-hunks-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { lensMissesBlockingHunks: true },
		reason: lensReason,
	},
	{
		name: "design-check-partial-merge",
		tool: "write" as const,
		field: "path" as const,
		pattern: /^/,
		when: { designCheckMissesPartialMerge: true },
		reason: designCheckReason,
	},
	{
		name: "design-check-partial-merge-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { designCheckMissesPartialMerge: true },
		reason: designCheckReason,
	},
	{
		name: "design-check-partial-merge-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { designCheckMissesPartialMerge: true },
		reason: designCheckReason,
	},
];
