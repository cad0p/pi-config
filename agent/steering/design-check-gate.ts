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
 * in `pr:` and carries `split-of: <owner>/<repo>#<n>` (the original),
 * and the piece starts again at round 1. `kind: impl` / `land` /
 * `build` briefs are never capped, so landing a PR that already has
 * clean verdicts keeps working.
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
function roundCapReason(pr: string, round: number): string {
	return `round ${round} on ${pr}: split the PR into independent pieces (owner rule: split at round 5). A split piece is a new PR whose brief header carries split-of: ${pr} and starts again at round 1.`;
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
	if (
		isGatedKind(header.kind) &&
		header.round !== null &&
		header.round >= ROUND_CAP
	) {
		return roundCapReason(header.pr, header.round);
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
