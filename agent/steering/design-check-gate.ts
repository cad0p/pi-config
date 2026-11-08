// SPDX-License-Identifier: MIT
/**
 * E1 design-check gate - a lens or fold brief at round >= 3 needs the
 * periodic design check on file first, and the round cap ends the
 * chain at round 6.
 *
 * Round cap (owner rule: split at round 5). A lens or fold brief at
 * round >= 6 is refused: five rounds of findings on one PR is the
 * signal to split the PR into independent pieces, not to fold again.
 * The cap is per PR number in the `pr:` line and ignores any design
 * check on file - a check with `verdict: continue` is not a licence to
 * keep folding. A split piece is a NEW PR: its brief names the piece PR
 * in `pr:` and carries `split-of: <owner>/<repo>#<n>` (the original).
 * `kind: impl` / `land` / `build` briefs are never capped, so landing a
 * PR that already has clean verdicts keeps working.
 *
 * One round definition and the shrink rule (pc-host #704 R4, R2; owner
 * 2026-11-08: "yes it should be enforced, advisories don't work with
 * agents"). The count is merge-pr.sh's (base-rules.ts): the effective
 * round is the higher of the header's `round:` and the helper's count
 * plus one, so a re-cut cannot understate it. A piece restarts at round 1
 * only when its changed paths are a subset of the parent's and its
 * changed lines strictly fewer; otherwise it inherits the parent's count.
 * There is no one-split limit: a piece that reaches round 5 splits again.
 * The helper's `rounds` subcommand does not exist until #704 merges, so
 * ROUNDS_FROM_HELPER keeps that path dormant and the header's round
 * stands - the live steering never shells out to a missing subcommand.
 *
 * No round on a red or unpushed head (pc-host #704 R1/R3). A `kind: lens`
 * brief carries `head: <40-hex>`; it is refused unless that sha is the
 * PR's current head on GitHub and a passing run is bound to it (a
 * gate-record comment for that head, or a `green-run: <path>` summary
 * whose result:, run-on and dirty lines grep clean). Every check fails
 * closed.
 *
 * Absorb exemption (owner ruling 2026-11-08, "ideally this process should
 * not require me"): a capped PR must still take in main before it merges,
 * and when merge-pr.sh's absorb check asks for a trio, that trio reviews
 * the absorb, not new work. A `kind: lens` brief whose header carries
 * `absorb-of: <40-hex merge commit>` is exempt from the cap; it still
 * needs the design check for its odd round, like any lens round. Folds
 * stay capped: code beyond the absorb at round >= 6 is a split piece.
 * The exemption is bound (#719 trust-model F1): the sha must be a merge
 * commit on the PR branch with one parent reachable from origin/main,
 * read from the PR's own repo clone after a fetch (base-rules.ts
 * repoClone: `<clones root>/<owner>--<repo>`, never pc-host's clone for
 * another repo's PR). Nothing more is checked -
 * the exemption is about which round it is, not about the absorb's
 * content - so a bogus or foreign sha is refused rather than exempted.
 *
 * Verdict consistency. The design check's `causing:` answer and its
 * verdict must agree: `causing: yes` means the design IS the source of
 * the churn, so `verdict: continue` contradicts the answer (that is how
 * pc-host #697 reached round 17 on `causing: yes` + `continue`). A
 * check whose `causing:` value starts with "yes" must carry
 * `verdict: cut` or `verdict: redesign`.
 *
 * Owner rule (pc-host plan 2026-11-07, E1): every odd round from r3
 * (3, 5, 7, ...) carries a design-check comment bound to that round,
 * written from a fixed template with three answers (scope still what
 * the goal needs; is the design causing the findings; same class open
 * elsewhere) plus a verdict continue / cut / redesign. The steering
 * side refuses a brief write until the latest required check exists:
 *
 *   <state>/design-checks/<owner>--<repo>-<pr>-r<N>.md
 *
 * where N is the latest odd round <= the brief's round (r3 for rounds
 * 3-4, r5 for 5-6, ...). The file is checked with a simple line-key
 * scan (scope:, design:, class: non-empty; verdict:
 * continue|cut|redesign) - deliberately not a YAML parser.
 *
 * The same rule owns the brief header contract: every write into the
 * briefs directory must carry `pr:`, `round:`, `kind:` in its
 * leading block (see brief-gates.ts). A brief with no readable header
 * is refused with the contract in the message.
 *
 * Surfaces: write / edit tools, `tee`, and a `bash -c` / `sh -c`
 * payload that redirects or tees into the briefs dir. A top-level
 * `cat > brief.md` redirect is invisible to pi-steering bash rules
 * (documented in brief-gates.ts).
 */

import type { PredicateContext } from "@cad0p/pi-steering";
import type { BriefWrite, DesignCheckStatus } from "./brief-gates.ts";
import {
	absorbBindingRefusal,
	lensHeadRefusal,
	pieceIsSmaller,
	pathsOutsideParent,
	roundsCount,
	roundsFromHelper,
} from "./base-rules.ts";
import type { BriefHeader } from "./brief-gates.ts";
import {
	briefContent,
	briefWrites,
	designCheckPath,
	designCheckStatus,
	firstBriefWrite,
	headerReason,
	isGatedKind,
	parseBriefHeader,
	requiredDesignCheckRound,
	unverifiableReason,
} from "./brief-gates.ts";

declare global {
	interface PiSteeringPredicates {
		briefNeedsDesignCheck: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

/** Round 6+ on the same PR: split it (owner rule: split at round 5). */
export const ROUND_CAP = 6;

/** The round-cap message. */
function roundCapReason(
	pr: string,
	round: number,
	why: string | null,
): string {
	const tail =
		why === null
			? "A split piece is a new PR whose brief header carries split-of: ${pr} and restarts at round 1 only when its changed paths are a subset of the parent's and its changed lines strictly fewer; otherwise it inherits the parent's round count. There is no one-split limit: a piece that reaches round 5 splits again."
			: why;
	return `round ${round} on ${pr}: split the PR into independent pieces (owner rule: split at round 5). ${tail}`;
}

/**
 * The round this brief effectively is (pc-host #704 R2/R4) and whether the
 * cap refuses it. The effective round is the higher of the header's round and
 * the helper's count plus one, so a re-cut cannot understate it; a split piece
 * restarts at round 1 only when it is strictly smaller than its parent, else it
 * inherits the parent's count. A check that cannot run refuses (fail closed).
 */
function roundCapRefusal(header: BriefHeader): string | null {
	if (!isGatedKind(header.kind) || header.round === null) return null;
	const pr = header.pr ?? "";
	let round = header.round;
	let inherited = false;
	if (header.splitOfKey !== null) {
		const parent = header.splitOfKey;
		const shrink = pieceIsSmaller(pr, parent);
		if (!shrink.ok) {
			return `could not compare ${pr} with its split parent ${parent} (${shrink.err}); a piece restarts at round 1 only when it is strictly smaller, so the cap cannot be evaluated (fail closed)`;
		}
		if (!shrink.smaller) {
			const outside = pathsOutsideParent(pr, parent);
			const why =
				outside.length > 0
					? `it changes ${outside.length} path(s) its parent does not (${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ", ..." : ""})`
					: "its changed lines are not strictly fewer than its parent's";
			if (!roundsFromHelper()) {
				return `split-of: ${parent} does not restart ${pr} at round 1: ${why}. A piece restarts only when it is strictly smaller; otherwise it inherits the parent's round count, which the helper's rounds subcommand reads (dormant until pc-host #704 merges), so this piece cannot be evaluated (fail closed).`;
			}
			const parentRounds = roundsCount(parent);
			if (!parentRounds.ok) {
				return `the round count of the split parent ${parent} could not be read (${parentRounds.err}); a piece that is not strictly smaller (${why}) inherits it, so the cap cannot be evaluated (fail closed)`;
			}
			round = Math.max(round, parentRounds.count + 1);
			inherited = true;
		}
	}
	if (roundsFromHelper()) {
		const own = roundsCount(pr);
		if (!own.ok) {
			return `the round count of ${pr} could not be read (${own.err}); the cap reads merge-pr.sh rounds and refuses when it cannot (fail closed)`;
		}
		round = Math.max(round, own.count + 1);
	}
	if (round < ROUND_CAP) return null;
	return roundCapReason(
		pr,
		round,
		inherited
			? `It inherits its split parent ${header.splitOfKey} round count.`
			: null,
	);
}

/** The `absorb-of:` value in the brief's leading lines, or null if absent. */
function absorbOfValue(content: string): string | null {
	for (const line of content.split(/\r?\n/).slice(0, 20)) {
		const m = /^absorb-of:\s*(.*?)\s*$/i.exec(line);
		if (m) return m[1] ?? "";
	}
	return null;
}

/** `causing: yes` + `verdict: continue` is a contradiction. */
function verdictConflictReason(
	need: number,
	status: DesignCheckStatus,
): string | null {
	if (status.verdict !== "continue") return null;
	if (status.causing === null || !/^yes/i.test(status.causing)) return null;
	return `design check r${need} says the design is causing the churn (causing: yes) but verdict: continue; the verdict must be cut or redesign`;
}

/** Why this brief write is refused, or null when it passes. */
function writeBlockReason(write: BriefWrite): string | null {
	const content = briefContent(write);
	if (content === null) return unverifiableReason(write);
	const header = parseBriefHeader(content);
	if (!header.complete || header.pr === null) return headerReason(write);
	if (!header.splitOfValid) {
		return `split-of must be a PR ref ('split-of: <owner>/<repo>#<n>'), not '${header.splitOf ?? ""}'.`;
	}
	const absorbOf = absorbOfValue(content);
	if (absorbOf !== null && !/^[0-9a-f]{40}$/.test(absorbOf)) {
		return `absorb-of must be the absorb merge commit as 40 lowercase hex ('absorb-of: <sha>'), not '${absorbOf}'.`;
	}
	const absorbLens = absorbOf !== null && header.kind === "lens";
	if (absorbLens && absorbOf !== null) {
		const binding = absorbBindingRefusal(absorbOf, header.pr);
		if (binding !== null) return binding;
	}
	if (header.kind === "lens") {
		const lens = lensHeadRefusal(header.head, header.greenRun, header.pr);
		if (lens !== null) return lens;
	}
	if (!absorbLens) {
		const capped = roundCapRefusal(header);
		if (capped !== null) return capped;
	}
	if (
		!isGatedKind(header.kind) ||
		header.round === null ||
		header.round < 3
	) {
		return null;
	}
	const need = requiredDesignCheckRound(header.round);
	const path = designCheckPath(header, need);
	const status = designCheckStatus(path);
	if (!status.exists) {
		return `design check required for ${header.pr} r${need}: create ${path} with 'scope:', 'design:', 'class:' answers and 'verdict: continue|cut|redesign' (every odd round from r3).`;
	}
	if (status.missing.length > 0) {
		return `design check ${path} is incomplete: add ${status.missing.join(", ")} (scope:, design:, class:, verdict: continue|cut|redesign).`;
	}
	return verdictConflictReason(need, status);
}

export const designCheckGatePlugin = {
	name: "brief-design-check",
	predicates: {
		briefNeedsDesignCheck: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return briefWrites(ctx).some(
				(write) => writeBlockReason(write) !== null,
			);
		},
	},
};

function reason(ctx: PredicateContext): string {
	const write = firstBriefWrite(ctx);
	if (write === null) return headerReason(null);
	return writeBlockReason(write) ?? headerReason(write);
}

export const designCheckRules = [
	{
		name: "design-check-gate",
		tool: "write" as const,
		field: "path" as const,
		// `pattern` cannot see the briefs dir, so it must not pre-filter:
		// the predicate resolves the path and does the exact check.
		pattern: /^/,
		when: { briefNeedsDesignCheck: true },
		reason,
	},
	{
		name: "design-check-gate-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefNeedsDesignCheck: true },
		reason,
	},
	{
		name: "design-check-gate-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { briefNeedsDesignCheck: true },
		reason,
	},
];
