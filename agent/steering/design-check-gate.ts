// SPDX-License-Identifier: MIT
/**
 * E1 design-check gate - a lens or fold brief at round >= 3 needs the
 * periodic design check on file first.
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

/** The design check the brief's round requires, or null when it passes. */
function missingDesignCheck(
	ctx: PredicateContext,
): { reason: string } | null {
	const write = firstBriefWrite(ctx);
	if (write === null) return null;
	const content = briefContent(write);
	if (content === null) return { reason: unverifiableReason(write) };
	const header = parseBriefHeader(content);
	if (!header.complete) return { reason: headerReason(write) };
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
		return {
			reason: `design check required for ${header.pr} r${need}: create ${path} with 'scope:', 'design:', 'class:' answers and 'verdict: continue|cut|redesign' (every odd round from r3).`,
		};
	}
	if (status.missing.length > 0) {
		return {
			reason: `design check ${path} is incomplete: add ${status.missing.join(", ")} (scope:, design:, class:, verdict: continue|cut|redesign).`,
		};
	}
	return null;
}

export const designCheckGatePlugin = {
	name: "brief-design-check",
	predicates: {
		briefNeedsDesignCheck: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			for (const write of briefWrites(ctx)) {
				const content = briefContent(write);
				if (content === null) return true;
				const header = parseBriefHeader(content);
				if (!header.complete) return true;
				if (
					!isGatedKind(header.kind) ||
					header.round === null ||
					header.round < 3
				) {
					continue;
				}
				const need = requiredDesignCheckRound(header.round);
				const status = designCheckStatus(designCheckPath(header, need));
				if (!status.exists || status.missing.length > 0) return true;
			}
			return false;
		},
	},
};

function reason(ctx: PredicateContext): string {
	return missingDesignCheck(ctx)?.reason ?? headerReason(firstBriefWrite(ctx));
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
