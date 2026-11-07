// SPDX-License-Identifier: MIT
/**
 * E4 critical-path slip - a slipped critical path must be replanned
 * before another brief is written for one of its items.
 *
 * State file (owner plan 2026-11-07, E4):
 *
 *   <state>/critical-path.json
 *   { goal, set_at (ISO), eta (ISO),
 *     items: [{ id, pr?: "owner/repo#n", status }],
 *     replans: [{ at, slipped, why, new_eta, told_owner_at }] }
 *
 * The slip deadline is `set_at + 1.5 * (eta - set_at)`; when replans
 * exist, the latest one's `at` / `new_eta` replace `set_at` / `eta`.
 * Once now > deadline, writing a brief whose `pr:` header matches a
 * non-`done` item is refused until a replan entry (carrying
 * `told_owner_at`) is appended.
 *
 * Fail-open by design: a missing or unparsable state file (or
 * unparsable dates) allows the write. This gate is a nudge on a
 * state file the orchestrator owns, not a security boundary - a
 * broken file must not wedge every brief.
 *
 * Surfaces: the same three as the design-check gate (write / edit /
 * tee + wrapper payload); see brief-gates.ts for the top-level
 * redirect gap.
 */

import { readFileSync } from "node:fs";
import type { PredicateContext } from "@cad0p/pi-steering";
import {
	briefContent,
	briefWrites,
	criticalPathFile,
	firstBriefWrite,
	parseBriefHeader,
} from "./brief-gates.ts";

declare global {
	interface PiSteeringPredicates {
		briefSlipsCriticalPath: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

interface CriticalPathItem {
	id?: string;
	pr?: string;
	status?: string;
}

interface CriticalPathReplan {
	at?: string;
	slipped?: string;
	why?: string;
	new_eta?: string;
	told_owner_at?: string;
}

interface CriticalPath {
	goal?: string;
	set_at?: string;
	eta?: string;
	items?: CriticalPathItem[];
	replans?: CriticalPathReplan[];
}

/** Read the state file; null on missing / unparsable (fail-open). */
function readCriticalPath(): CriticalPath | null {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(criticalPathFile(), "utf8"),
		);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as CriticalPath;
	} catch {
		return null;
	}
}

/** The slip deadline in epoch ms, or null when the dates are unusable. */
export function slipDeadline(state: CriticalPath): number | null {
	let setAt = Date.parse(state.set_at ?? "");
	let eta = Date.parse(state.eta ?? "");
	const replans = Array.isArray(state.replans) ? state.replans : [];
	if (replans.length > 0) {
		// Latest = greatest parseable `at`; with no parseable `at` the
		// append-only array's last entry is the latest.
		const dated = replans.filter((r) =>
			Number.isFinite(Date.parse(r.at ?? "")),
		);
		const latest =
			dated.length > 0
				? dated.reduce((a, b) =>
						Date.parse(b.at ?? "") > Date.parse(a.at ?? "") ? b : a,
					)
				: replans[replans.length - 1];
		if (latest !== undefined) {
			setAt = Date.parse(latest.at ?? "");
			eta = Date.parse(latest.new_eta ?? "");
		}
	}
	if (!Number.isFinite(setAt) || !Number.isFinite(eta)) return null;
	return setAt + 1.5 * (eta - setAt);
}

/** The non-done item whose `pr` matches the brief header, or null. */
function slippedItem(
	state: CriticalPath,
	ctx: PredicateContext,
): { item: CriticalPathItem; reason: string } | null {
	const deadline = slipDeadline(state);
	if (deadline === null || Date.now() <= deadline) return null;
	const items = Array.isArray(state.items) ? state.items : [];
	for (const write of briefWrites(ctx)) {
		const content = briefContent(write);
		if (content === null) continue; // header gate owns unverifiable writes
		const header = parseBriefHeader(content);
		if (!header.complete || header.prKey === null) continue;
		const item = items.find(
			(candidate) =>
				typeof candidate.pr === "string" &&
				candidate.pr.toLowerCase() === header.prKey,
		);
		if (item === undefined) continue;
		if ((item.status ?? "").toLowerCase() === "done") continue;
		return {
			item,
			reason: `critical path slipped (deadline ${new Date(deadline).toISOString()}): append a replan entry to ${criticalPathFile()} with {at, slipped, why, new_eta, told_owner_at} before writing a brief for ${header.pr}.`,
		};
	}
	return null;
}

export const criticalPathSlipPlugin = {
	name: "brief-critical-path",
	predicates: {
		briefSlipsCriticalPath: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			const state = readCriticalPath();
			if (state === null) return false; // fail-open: no state file
			return slippedItem(state, ctx) !== null;
		},
	},
};

function reason(ctx: PredicateContext): string {
	const state = readCriticalPath();
	const hit = state === null ? null : slippedItem(state, ctx);
	if (hit !== null) return hit.reason;
	return `critical path slipped: append a replan entry to ${criticalPathFile()} with {at, slipped, why, new_eta, told_owner_at} before writing this brief.`;
}

export const criticalPathSlipRules = [
	{
		name: "critical-path-slip",
		tool: "write" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefSlipsCriticalPath: true },
		reason,
	},
	{
		name: "critical-path-slip-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefSlipsCriticalPath: true },
		reason,
	},
	{
		name: "critical-path-slip-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { briefSlipsCriticalPath: true },
		reason,
	},
];
