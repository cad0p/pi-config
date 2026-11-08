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
 *
 * Reset guard (pc-host #703, design note D8): a write / edit / tee /
 * wrapper payload / mv / cp whose target is critical-path.json may not
 * drop an unfinished item. Old `items` are compared with the new
 * content's by `id`; a removed item must be
 *   (a) finished: `done_at` set or `status: done`;
 *   (b) a well-formed `owner/repo#n` PR that the FRESH open-work
 *       ledger (`ok`, swept under 60 min) shows `parked` in `open`
 *       or no longer lists there (merged / closed); or
 *   (c) listed in the new content's top-level `dropped: [{id, why,
 *       told_owner_at}]`, all three non-empty (the escape for non-PR
 *       items and a stale ledger, so a reset never wedges).
 * Old file missing / unparsable: allow. New content hidden by the
 * shell (tee, a heredoc-less redirect, an mv/cp whose source does not
 * exist yet): refused as unverifiable. New content unparsable:
 * refused. Works with the ledger unarmed or absent ((b) just never
 * applies). Known gap (pinned in tests): moving or removing the old
 * file first (`mv critical-path.json <archive>`) leaves no old file to
 * compare, by design: archiving is untouched.
 */

import { readFileSync, statSync } from "node:fs";
import { basename as pathBasename, join } from "node:path";
import type { PredicateContext } from "@cad0p/pi-steering";
import {
	applyEdits,
	briefContent,
	briefWrites,
	criticalPathFile,
	effectiveCwd,
	firstBriefWrite,
	parseBriefHeader,
	readOrNull,
	resolveTarget,
	toolWrites,
} from "./brief-gates.ts";
import { ledgerFresh, prKeyOf, readOpenWork } from "./open-work-gate.ts";

declare global {
	interface PiSteeringPredicates {
		briefSlipsCriticalPath: import("@cad0p/pi-steering").PredicateShape<boolean>;
		criticalPathResetDrops: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

interface CriticalPathItem {
	id?: string;
	pr?: string;
	status?: string;
	done_at?: unknown;
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
	dropped?: unknown;
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

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** `mv` / `cp` operands: [source, destination] pairs (absolute). */
function moveCopyPairs(
	words: readonly string[],
	cwd: string | null,
): Array<[string, string]> {
	let targetDir: string | null = null;
	const plain: string[] = [];
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] ?? "";
		if (word === "--") {
			plain.push(...words.slice(i + 1));
			break;
		}
		if (word === "-t" || word === "--target-directory") {
			targetDir = words[i + 1] ?? null;
			i += 1;
			continue;
		}
		if (word.startsWith("--target-directory=")) {
			targetDir = word.slice("--target-directory=".length);
			continue;
		}
		if (word === "-S" || word === "--suffix") {
			i += 1; // value-taking flag
			continue;
		}
		if (word.startsWith("-") && word !== "-") continue;
		plain.push(word);
	}
	const isDir = (path: string): boolean => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	};
	const pairs: Array<[string, string]> = [];
	const intoDir = (dir: string, sources: string[]): void => {
		for (const source of sources) {
			const src = resolveTarget(source, cwd);
			if (src !== null) pairs.push([src, join(dir, pathBasename(src))]);
		}
	};
	if (targetDir !== null) {
		const dir = resolveTarget(targetDir, cwd);
		if (dir !== null) intoDir(dir, plain);
		return pairs;
	}
	if (plain.length < 2) return pairs;
	const dest = resolveTarget(plain[plain.length - 1] ?? "", cwd);
	if (dest === null) return pairs;
	const sources = plain.slice(0, -1);
	if (isDir(dest)) intoDir(dest, sources);
	else if (sources.length === 1) {
		const src = resolveTarget(sources[0] ?? "", cwd);
		if (src !== null) pairs.push([src, dest]);
	}
	return pairs;
}

/**
 * The new contents this tool call would give critical-path.json; null
 * marks a write whose content the shell hides.
 */
function resetCandidates(ctx: PredicateContext): Array<string | null> {
	const target = criticalPathFile();
	if (ctx.tool === "edit") {
		const path = typeof ctx.input.path === "string" ? ctx.input.path : "";
		if (resolveTarget(path, effectiveCwd(ctx)) !== target) return [];
		const base = readOrNull(target);
		if (base === null) return [];
		const patched = applyEdits(base, ctx.input.edits ?? []);
		// A missed patch fails in the edit tool itself.
		return patched === null ? [] : [patched];
	}
	if (ctx.tool === "bash") {
		const basename = ctx.input.basename ?? "";
		if (basename === "mv" || basename === "cp") {
			const words = (ctx.input.args ?? []).map((w) => w.value ?? w.text ?? "");
			return moveCopyPairs(words, effectiveCwd(ctx))
				.filter(([, dest]) => dest === target)
				.map(([src]) => readOrNull(src));
		}
	}
	return toolWrites(ctx)
		.filter((write) => write.path === target)
		.map((write) => {
			if (write.content === null) return null;
			if (!write.append) return write.content;
			return (readOrNull(target) ?? "") + write.content;
		});
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/** Removed unfinished items with no allowed way out, described. */
function unjustifiedDrops(old: CriticalPath, next: CriticalPath): string[] {
	const oldItems = (Array.isArray(old.items) ? old.items : []).filter(
		(item): item is CriticalPathItem & { id: string } =>
			nonEmpty(field(item, "id")),
	);
	const kept = new Set(
		(Array.isArray(next.items) ? (next.items as unknown[]) : [])
			.map((item) => field(item, "id"))
			.filter(nonEmpty),
	);
	const dropped = new Set(
		(Array.isArray(next.dropped) ? (next.dropped as unknown[]) : [])
			.filter(
				(d) =>
					nonEmpty(field(d, "id")) &&
					nonEmpty(field(d, "why")) &&
					nonEmpty(field(d, "told_owner_at")),
			)
			.map((d) => field(d, "id") as string),
	);
	const ledger = readOpenWork();
	const fresh = ledger !== null && ledgerFresh(ledger);
	const open =
		fresh && Array.isArray(ledger.open) ? (ledger.open as unknown[]) : [];
	const out: string[] = [];
	for (const item of oldItems) {
		if (kept.has(item.id)) continue;
		if (nonEmpty(item.done_at)) continue; // (a)
		if (String(item.status ?? "").toLowerCase() === "done") continue; // (a)
		if (dropped.has(item.id)) continue; // (c)
		const key = prKeyOf(item.pr);
		if (key !== null && fresh) {
			const entry = open.find((e) => prKeyOf(field(e, "pr")) === key);
			if (entry === undefined || field(entry, "state") === "parked") continue; // (b)
			out.push(`${item.id} (${item.pr}, open, not Parked)`);
			continue;
		}
		if (key !== null) {
			out.push(`${item.id} (${item.pr}, open-work ledger missing or stale)`);
		} else if (nonEmpty(item.pr)) out.push(`${item.id} ("${item.pr}")`);
		else out.push(item.id);
	}
	return out;
}

/** Why this tool call's critical-path.json write is refused, or null. */
function resetBlockReason(ctx: PredicateContext): string | null {
	const candidates = resetCandidates(ctx);
	if (candidates.length === 0) return null;
	const old = readCriticalPath();
	if (old === null) return null; // nothing to compare
	const target = criticalPathFile();
	for (const content of candidates) {
		if (content === null) {
			return `cannot verify the new ${target} through this shell write: use the write tool, or write the temp file in a separate call first and then mv it.`;
		}
		let next: unknown;
		try {
			next = JSON.parse(content);
		} catch {
			next = null;
		}
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			return `critical-path.json would not parse as a JSON object after this write (${target}).`;
		}
		const bad = unjustifiedDrops(old, next as CriticalPath);
		if (bad.length > 0) {
			return `critical-path reset drops unfinished item(s): ${bad.join(", ")}. Keep them, mark done_at, park the PR (tools/open-work.sh park ...), or add {id, why, told_owner_at} to a top-level "dropped" array.`;
		}
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
		criticalPathResetDrops: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return resetBlockReason(ctx) !== null;
		},
	},
};

function resetReason(ctx: PredicateContext): string {
	return (
		resetBlockReason(ctx) ??
		'critical-path reset drops unfinished item(s): keep them, mark done_at, park the PR, or add {id, why, told_owner_at} to a top-level "dropped" array.'
	);
}

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
	{
		name: "critical-path-reset",
		tool: "write" as const,
		field: "path" as const,
		pattern: /^/,
		when: { criticalPathResetDrops: true },
		reason: resetReason,
	},
	{
		name: "critical-path-reset-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { criticalPathResetDrops: true },
		reason: resetReason,
	},
	{
		name: "critical-path-reset-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh", "mv", "cp"] as const,
		when: { criticalPathResetDrops: true },
		reason: resetReason,
	},
];
