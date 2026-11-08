// SPDX-License-Identifier: MIT
/**
 * Open-work gate (pc-host #703, design note 2026-11-08 D7): no new
 * brief while the open-work ledger lists dropped PRs.
 *
 * Ledger: `<state>/open-work.json`, written atomically by pc-host's
 * `tools/open-work.sh sweep` (every 15 min) and by each of its write
 * commands. The gate reads `armed`, `ok`, `error`, `generated_at`
 * and `listed: [{pr, why, scope: all|session, session, detail}]`.
 *
 * DORMANT until armed: the arm marker is `"armed": true` in
 * `<state>/open-work.json` (the sweep copies it from
 * `<state>/open-work/config.json`, which `open-work.sh arm
 * --owner-quote` sets). A missing, unparsable or unarmed ledger allows
 * every brief.
 *
 * Sessions are compared by id8 (brief-gates.ts sessionId8: the last 8
 * hex of PI_SESSION_ID, never the UUIDv7 timestamp prefix), on both
 * the brief's `session:` header and each entry's `session`.
 *
 * Armed, for each brief write with a complete header:
 *   1. effective list = every `scope:"all"` entry, plus the
 *      `scope:"session"` entries whose `session` equals the brief's
 *      `session:` header (all of them when the brief has none), plus a
 *      synthetic `ledger-stale` when `generated_at` is over 60 min old
 *      and no valid ack lifts it;
 *   2. drop the entries the brief itself handles (`pr:` / `split-of:`
 *      equal to the entry's PR, and the entry is `scope:"all"` or owned
 *      by the brief's session): writing that brief is resuming the PR;
 *   3. refuse when anything is left.
 *
 * A failed sweep (`ok:false`) under 60 min enforces the kept list.
 * Entries with an unparsable `pr` are dropped and counted.
 *
 * Stale ack: `<state>/open-work-ack.json` = `{at, until, reason,
 * session, generated_at, owner_quote?}`. It lifts `ledger-stale` only
 * while now < min(until, at + 2 h), only for the ledger generation it
 * names (`generated_at`), and needs a reason and a session. Once per
 * outage is enforced by `open-work.sh ack-stale` (a second ack needs
 * `--owner-quote`); the gate enforces the 2 h ceiling.
 *
 * Owner calls (design note O1-O3), each one constant here:
 *   O1 ORPHAN_TAKEOVER_BY_ANY_SESSION (recommended true): a brief from
 *      any session for an `orphaned` PR handles it. false = only the
 *      recorded (dead) owner session's brief does.
 *   O2 triage defaults: no steering surface (tools/open-work.sh triage).
 *   O3 SESSION_MAY_ACK_STALE (recommended true): a session's own ack
 *      lifts `ledger-stale`. false = only an ack carrying `owner_quote`.
 *
 * Fail table: ledger missing / unparsable / `armed` not true -> allow;
 * ack missing / unparsable / expired -> no lift. Tripwire, not a
 * boundary (ruling C: editing the state files is out of scope).
 *
 * Surfaces: write / edit / tee + `bash -c` / `sh -c` payload, via
 * brief-gates.ts (same top-level-redirect gap). An unverifiable or
 * header-less brief is left to `design-check-gate`, which runs first.
 */

import type { PredicateContext } from "@cad0p/pi-steering";
import {
	type BriefHeader,
	type BriefWrite,
	briefContent,
	briefWrites,
	openWorkAckFile,
	openWorkFile,
	parseBriefHeader,
	readOrNull,
	sessionId8,
} from "./brief-gates.ts";

declare global {
	interface PiSteeringPredicates {
		briefBlockedByOpenWork: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

/** O1: any session may take over an orphaned PR (recommended). */
export const ORPHAN_TAKEOVER_BY_ANY_SESSION = true;
/** O3: a session may ack a stale ledger itself (recommended). */
export const SESSION_MAY_ACK_STALE = true;

const MINUTE = 60_000;
/** Ledger older than this is stale (thresholds.stale_minutes). */
export const STALE_MINUTES = 60;
/** The longest one ack lifts `ledger-stale`. */
export const ACK_MAX_MS = 120 * MINUTE;
/** Refusal shows at most this many PRs. */
export const MAX_SHOWN = 15;

const PR_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;

export interface OpenWorkLedger {
	armed?: unknown;
	ok?: unknown;
	error?: unknown;
	generated_at?: unknown;
	attempted_at?: unknown;
	open?: unknown;
	listed?: unknown;
}

/** A well-formed `owner/repo#n`, lowercased; null otherwise. */
export function prKeyOf(value: unknown): string | null {
	return typeof value === "string" && PR_REF.test(value)
		? value.toLowerCase()
		: null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
	const raw = readOrNull(path);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** The ledger, or null when missing / unparsable. */
export function readOpenWork(): OpenWorkLedger | null {
	return readJsonObject(openWorkFile());
}

/** Age of the last good sweep in ms; null when `generated_at` is unusable. */
export function ledgerAgeMs(ledger: OpenWorkLedger, now = Date.now()): number | null {
	const at =
		typeof ledger.generated_at === "string"
			? Date.parse(ledger.generated_at)
			: Number.NaN;
	return Number.isFinite(at) ? now - at : null;
}

/** `ok` and swept within STALE_MINUTES (the reset guard's rule (b)). */
export function ledgerFresh(ledger: OpenWorkLedger, now = Date.now()): boolean {
	const age = ledgerAgeMs(ledger, now);
	return ledger.ok === true && age !== null && age <= STALE_MINUTES * MINUTE;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** Does a valid ack lift `ledger-stale` right now? */
export function staleAckValid(ledger: OpenWorkLedger, now = Date.now()): boolean {
	const ack = readJsonObject(openWorkAckFile());
	if (ack === null) return false;
	if (!nonEmpty(ack.reason) || !nonEmpty(ack.session)) return false;
	if (!SESSION_MAY_ACK_STALE && !nonEmpty(ack.owner_quote)) return false;
	const at = typeof ack.at === "string" ? Date.parse(ack.at) : Number.NaN;
	const until =
		typeof ack.until === "string" ? Date.parse(ack.until) : Number.NaN;
	if (!Number.isFinite(at) || !Number.isFinite(until)) return false;
	if (at > now) return false;
	// The ack belongs to one ledger generation (one outage).
	if (
		typeof ack.generated_at === "string" &&
		typeof ledger.generated_at === "string" &&
		ack.generated_at !== ledger.generated_at
	) {
		return false;
	}
	return now < Math.min(until, at + ACK_MAX_MS);
}

/** One normalized `listed` entry. */
export interface ListedEntry {
	pr: string;
	prKey: string;
	why: string;
	scope: "all" | "session";
	session: string | null;
	detail: string;
}

/** The effective list for a brief, before the "handled" filter. */
interface Effective {
	entries: ListedEntry[];
	malformed: number;
	stale: boolean;
}

function normalize(raw: unknown): ListedEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const entry = raw as Record<string, unknown>;
	const prKey = prKeyOf(entry.pr);
	if (prKey === null) return null;
	return {
		pr: entry.pr as string,
		prKey,
		why: nonEmpty(entry.why) ? entry.why : "listed",
		// Anything but an explicit session scope is everyone's (fail-safe).
		scope: entry.scope === "session" ? "session" : "all",
		session: nonEmpty(entry.session)
			? (sessionId8(entry.session) ?? entry.session.toLowerCase())
			: null,
		detail: typeof entry.detail === "string" ? entry.detail : "",
	};
}

function effectiveList(
	ledger: OpenWorkLedger,
	header: BriefHeader,
	now: number,
): Effective {
	const raw = Array.isArray(ledger.listed) ? ledger.listed : [];
	const entries: ListedEntry[] = [];
	let malformed = 0;
	for (const item of raw) {
		const entry = normalize(item);
		if (entry === null) {
			malformed += 1;
			continue;
		}
		if (
			entry.scope === "session" &&
			header.session !== null &&
			entry.session !== header.session
		) {
			continue; // another session's own item
		}
		entries.push(entry);
	}
	const age = ledgerAgeMs(ledger, now);
	const stale =
		(age === null || age > STALE_MINUTES * MINUTE) &&
		!staleAckValid(ledger, now);
	return { entries, malformed, stale };
}

/** Is writing this brief the act of resuming the entry's PR? */
function handles(entry: ListedEntry, header: BriefHeader): boolean {
	const keys = [header.prKey, header.splitOfKey].filter(
		(k): k is string => k !== null,
	);
	if (!keys.includes(entry.prKey)) return false;
	const ownBySession =
		header.session !== null && entry.session === header.session;
	if (entry.scope === "session") return ownBySession;
	if (entry.why === "orphaned" && !ORPHAN_TAKEOVER_BY_ANY_SESSION)
		return ownBySession;
	return true;
}

function clock(iso: unknown, now: number): string {
	if (typeof iso !== "string") return "never";
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return String(iso);
	const stamp = new Date(at).toISOString();
	const today = new Date(now).toISOString().slice(0, 10);
	return stamp.slice(0, 10) === today
		? `${stamp.slice(11, 16)}Z`
		: `${stamp.slice(0, 16)}Z`;
}

function staleText(ledger: OpenWorkLedger, now: number): string {
	const last =
		ledger.ok === false
			? `last attempt failed: ${nonEmpty(ledger.error) ? ledger.error : "unknown error"}`
			: `no sweep since (last attempt ${clock(ledger.attempted_at, now)})`;
	return [
		`open-work ledger is stale (last good sweep ${clock(ledger.generated_at, now)}, ${last}).`,
		"Check: systemctl --user status pc-open-work.service; retry: tools/open-work.sh sweep",
		'If GitHub is down: tools/open-work.sh ack-stale --reason "<why>" (allows briefs for 2 h, once per outage).',
	].join("\n");
}

function listText(
	ledger: OpenWorkLedger,
	entries: ListedEntry[],
	malformed: number,
	header: BriefHeader,
	now: number,
): string {
	const sorted = [...entries].sort(
		(a, b) => a.why.localeCompare(b.why) || a.prKey.localeCompare(b.prKey),
	);
	const shown = sorted.slice(0, MAX_SHOWN);
	const lines = [
		`open-work ledger (swept ${clock(ledger.generated_at, now)}, ${entries.length} PR${entries.length === 1 ? "" : "s"} need a state before a new brief):`,
	];
	for (const entry of shown) {
		const you =
			header.session !== null && entry.session === header.session
				? " (you)"
				: "";
		lines.push(
			`  ${entry.pr.padEnd(22)} ${entry.why.padEnd(13)} ${entry.detail}${you}`.trimEnd(),
		);
	}
	if (sorted.length > shown.length) {
		lines.push(
			`  ... and ${sorted.length - shown.length} more: tools/open-work.sh list`,
		);
	}
	if (malformed > 0) {
		lines.push(`  (${malformed} listed entr${malformed === 1 ? "y" : "ies"} with an unparsable pr ignored)`);
	}
	lines.push(
		"Ways out, per PR (run from ~/.local/share/pc-merge/pc-host):",
		'  resume: tools/open-work.sh resume <owner/repo#n> --next "<step>"   (or write the brief for that PR itself)',
		'  park:   tools/open-work.sh park <owner/repo#n> --until YYYY-MM-DD --reason "<why>"',
		'  close:  tools/open-work.sh close <owner/repo#n> --reason "<why>"',
		"Each command refreshes the ledger; the timer also sweeps every 15 minutes.",
	);
	return lines.join("\n");
}

/** Why this brief write is refused, or null. */
export function openWorkBlockReason(
	write: BriefWrite,
	now = Date.now(),
): string | null {
	const content = briefContent(write);
	if (content === null) return null; // design-check-gate owns unverifiable
	const header = parseBriefHeader(content);
	if (!header.complete) return null; // design-check-gate owns the header
	const ledger = readOpenWork();
	if (ledger === null || ledger.armed !== true) return null; // dormant
	const effective = effectiveList(ledger, header, now);
	const left = effective.entries.filter((entry) => !handles(entry, header));
	if (left.length === 0 && !effective.stale) return null;
	const parts: string[] = [];
	if (left.length > 0)
		parts.push(listText(ledger, left, effective.malformed, header, now));
	if (effective.stale) parts.push(staleText(ledger, now));
	return parts.join("\n");
}

function firstBlock(ctx: PredicateContext): string | null {
	for (const write of briefWrites(ctx)) {
		const why = openWorkBlockReason(write);
		if (why !== null) return why;
	}
	return null;
}

export const openWorkGatePlugin = {
	name: "brief-open-work",
	predicates: {
		briefBlockedByOpenWork: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return firstBlock(ctx) !== null;
		},
	},
};

function reason(ctx: PredicateContext): string {
	return (
		firstBlock(ctx) ??
		"open-work ledger lists PRs with no state: run tools/open-work.sh list."
	);
}

export const openWorkGateRules = [
	{
		name: "open-work-gate",
		tool: "write" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefBlockedByOpenWork: true },
		reason,
	},
	{
		name: "open-work-gate-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefBlockedByOpenWork: true },
		reason,
	},
	{
		name: "open-work-gate-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { briefBlockedByOpenWork: true },
		reason,
	},
];
