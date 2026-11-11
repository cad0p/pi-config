// SPDX-License-Identifier: MIT
/**
 * probe-scope-guard — an ad-hoc probe may not run unbounded.
 *
 * Incident 2026-11-11T10:31:57Z (subagent c80b6f4d at cwd /tmp/probe):
 * `bash v.sh & p=$!; sleep 0.5; kill -INT $p` where v.sh was a
 * `trap … EXIT` plus `while :; do :; done`. The pi bash tool spawns its
 * shell detached (new session, pgid = shell pid), and a background job
 * inherits SIGINT/SIGQUIT as IGNORED (`SigIgn 0x6`), so the `kill -INT`
 * was a no-op, the EXIT trap never ran, the tool call returned 0, and the
 * harness never reached its timeout `killProcessTree(-pid)`. The loop was
 * reparented to `systemd --user` and burned one core for 11 h 29 m,
 * invisible to every watchdog. The `probe.py` variant in the same
 * directory repeats the hole with `Popen(…, start_new_session=True)`.
 * Forensics: pc-host docs/pc-orphan-reap.md, Goldmine
 * personal/github/pc-host/issues/2026-11-11-issue-orphan-reap.md.
 *
 * Refused (bash refs whose text — the ref's own `basename + args`, ENV-
 * resolved — carries the shape and no runtime bound):
 *   - unbounded busy wait: `while :; do`, `while true; do`,
 *     `while [ 1 ]`, `for((;;))`;
 *   - deliberately detached launch: `setsid`, `nohup`,
 *     `start_new_session=True` in a python payload;
 *   - a sleep that cannot end inside a turn: `sleep infinity`,
 *     `sleep 999999` (any duration >= 600 s);
 *   - `systemd-run` without a positive `RuntimeMaxSec=` (an unbounded
 *     transient unit outlives the turn exactly like the specimen).
 *
 * Allowed (the same command carries a bound): `timeout <n>` with n > 0
 * (`timeout 0` is "no limit" and is not a bound), `--property=RuntimeMaxSec=<n>`
 * with n > 0 (`=0`/`=infinity` are not bounds), or `PC_PROBE_BOUNDED=1`
 * as a prefix assignment or an exported chain variable. Read-only
 * inspection is never routed: ps, grep, cat, pgrep, ls are not in the
 * routed basename set, so the pattern may be an argument.
 *
 * Known gaps (pinned in the test file):
 *   - the engine hands a predicate ONE command ref — `basename + args` —
 *     not the raw tool-call text. The `&` operator is not part of any
 *     ref, and a script's BODY is not either: the incident's literal
 *     `bash v.sh & …` shows up as three refs (`bash v.sh`,
 *     `sleep 0.5`, `kill -INT $p`) with no loop text anywhere, so this
 *     rule cannot see it. Reading the named script would catch it and is
 *     deliberately NOT done: pc-host's own tools/merge-pr.sh, converge.sh,
 *     tools/lib/pc-admission.sh … carry eight legitimate `while :; do`
 *     retry loops, so a body scan would refuse real CI. Prevention is
 *     the bound (systemd-run/timeout), the guard is the net for the
 *     text-visible forms.
 *   - a loop quoted as an argument INSIDE a shell payload
 *     (`bash -c "grep 'while :; do' f"`) is denied: the guard never
 *     re-parses the payload string.
 *   - `(while :; do :; done) &` extracts no command ref at all, so no
 *     rule can fire.
 *   - a variable-indirected launch (`$LAUNCHER`, an alias, a script that
 *     starts another script) is invisible; steering sees only the
 *     agent's own argv.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateShape,
} from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		/** `when.leaksUnboundedProbe` — this ref starts or is an unbounded probe. */
		leaksUnboundedProbe: PredicateShape<boolean>;
	}
}

/** Routed basenames: launchers, the detach verbs, the bound wrappers. */
export const PROBE_LAUNCHERS = [
	"bash",
	"sh",
	"setsid",
	"nohup",
	"timeout",
	"systemd-run",
	"python",
	"python3",
	"sleep",
] as const;

/**
 * Basenames another plugin already declares (agent-config-guard in
 * index.ts owns bash/sh/python/python3; tsh-guard owns timeout;
 * re-declaring a descriptor is a merger warning, and warnings disable
 * steering in strict mode).
 */
const DECLARED_ELSEWHERE = new Set([
	"bash",
	"sh",
	"python",
	"python3",
	"timeout",
]);

/** Read-only inspection: never routed, so the pattern may be an argument. */
export const READ_ONLY_INSPECTION = [
	"ps",
	"pgrep",
	"grep",
	"rg",
	"cat",
	"ls",
	"head",
	"tail",
	"less",
] as const;

/** A wait that cannot end on its own. */
export const UNBOUNDED_BUSY_WAIT =
	/\bwhile\s*:|\bwhile\s+true\b|\bwhile\s+\[\s*1\s*\]|\bfor\s*\(\(\s*;\s*;\s*\)\)/;

/** A launcher that leaves the harness's process group on purpose. */
export const DETACHED_LAUNCH =
	/\b(?:setsid|nohup)\b|start_new_session\s*=\s*(?:True|true|1)\b/;

/** A sleep that outlives any turn (>= 600 s, or infinity). */
const SLEEP_CALL = /\bsleep\s+([0-9]+(?:\.[0-9]+)?)\s*([smhd])?\b|\bsleep\s+(?:infinity|inf)\b/;

/** Seconds per duration suffix. */
const SLEEP_UNIT: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** `timeout [opts] <duration> cmd` — the duration is the bound. */
const TIMEOUT_BOUND =
	/\btimeout\b\s+(?:--?[A-Za-z][\w-]*(?:=\S+)?\s+)*(\d+(?:\.\d+)?)([smhd])?\b/;

/** `--property=RuntimeMaxSec=<n>` (or `RuntimeMaxSec=` inside a unit file line). */
const RUNTIME_MAX = /\bRuntimeMaxSec\s*=\s*["']?(\d+(?:\.\d+)?)/;

/** A truthy `PC_PROBE_BOUNDED` value. */
function isTruthyBound(value: string | undefined): boolean {
	if (typeof value !== "string") return false;
	const v = value.trim().replace(/^["']|["']$/g, "").toLowerCase();
	return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Does the ref's text carry a positive timeout duration? */
export function hasTimeoutBound(text: string): boolean {
	const m = TIMEOUT_BOUND.exec(text);
	if (m === null) return false;
	const n = Number(m[1] ?? "");
	// Any positive duration is a real bound; 0 means "no limit" (GNU coreutils).
	return Number.isFinite(n) && n > 0;
}

/** Does the ref's text carry a positive `RuntimeMaxSec=`? */
export function hasRuntimeMaxSec(text: string): boolean {
	const m = RUNTIME_MAX.exec(text);
	if (m === null) return false;
	const n = Number(m[1] ?? "");
	return Number.isFinite(n) && n > 0;
}

/** `sleep infinity` / `sleep 999999` / `sleep 15m` — cannot end in a turn. */
export function isEndlessSleep(text: string): boolean {
	const m = SLEEP_CALL.exec(text);
	if (m === null) return false;
	// The second alternative (`infinity` / `inf`) carries no numeric group.
	if (m[1] === undefined) return true;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return false;
	return n * (SLEEP_UNIT[m[2] ?? ""] ?? 1) >= 600;
}

/** The probe shape itself, independent of any bound. */
export function isProbeShape(text: string): boolean {
	return (
		UNBOUNDED_BUSY_WAIT.test(text) ||
		DETACHED_LAUNCH.test(text) ||
		isEndlessSleep(text)
	);
}

/** The bound, read from the ref's text, its prefix env and the chain env. */
export function hasRuntimeBound(
	text: string,
	ctx: {
		input?: { envAssignments?: ReadonlyArray<{ text?: string; value?: string }> };
		walkerState?: { env?: ReadonlyMap<string, string> };
	},
): boolean {
	if (isTruthyBound(ctx?.walkerState?.env?.get?.("PC_PROBE_BOUNDED"))) return true;
	for (const assignment of ctx?.input?.envAssignments ?? []) {
		const tok = (assignment?.text ?? assignment?.value ?? "").replace(
			/^["']|["']$/g,
			"",
		);
		const m = /^PC_PROBE_BOUNDED=(.*)$/i.exec(tok);
		if (m !== null && isTruthyBound(m[1])) return true;
	}
	if (hasRuntimeMaxSec(text)) return true;
	if (hasTimeoutBound(text)) return true;
	return false;
}

/**
 * The decision: does this ref start (or is) an unbounded probe?
 *
 * `systemd-run` is refused whenever no positive `RuntimeMaxSec=` is
 * present — an unbounded transient unit is the specimen's escape with a
 * unit name. Everything else is refused only when its own text carries
 * the shape.
 */
export function probeIsUnbounded(
	basename: string | undefined,
	text: string,
	ctx: {
		input?: { envAssignments?: ReadonlyArray<{ text?: string; value?: string }> };
		walkerState?: { env?: ReadonlyMap<string, string> };
	},
): boolean {
	if (hasRuntimeBound(text, ctx)) return false;
	if (basename === "systemd-run") return true;
	if (basename === "sleep") return isEndlessSleep(text);
	return isProbeShape(text);
}

/** `when.leaksUnboundedProbe` — a boolean leaf; unknown arg never fires. */
export const leaksUnboundedProbePredicate = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		const text =
			typeof ctx.input.command === "string" ? ctx.input.command : "";
		const fires = probeIsUnbounded(ctx.input.basename, text, ctx);
		return fires === expected;
	},
);

/** Agent-facing message: the incident, the bound, why kill -INT fails. */
const REASON =
	"unbounded probe: an ad-hoc busy wait or detached launch with no runtime bound. On 2026-11-11 a backgrounded `bash v.sh & …; kill -INT $p` probe outlived its turn and burned one core for 11.5 h: a backgrounded shell in this harness ignores SIGINT, so kill -INT is a no-op and the process outlives the turn. Bound it: systemd-run --user --wait --collect --pipe --unit=pc-probe-<name> --property=RuntimeMaxSec=900 -- <cmd> (the unit's cgroup dies with it, even a setsid grandchild), or wrap it in timeout <n> (n > 0), or set PC_PROBE_BOUNDED=1 when you really mean to leave it running (docs/pc-orphan-reap.md, incident 2026-11-11).";

export const probeScopeGuardRules = [
	{
		name: "no-unbounded-probe",
		tool: "bash" as const,
		command: [...PROBE_LAUNCHERS],
		when: { leaksUnboundedProbe: true },
		reason: REASON,
	},
];

export const probeScopeGuardPlugin = {
	name: "probe-scope-guard",
	cliDescriptors: Object.fromEntries(
		PROBE_LAUNCHERS.filter((b) => !DECLARED_ELSEWHERE.has(b)).map((b) => [
			b,
			{},
		]),
	),
	predicates: { leaksUnboundedProbe: leaksUnboundedProbePredicate },
} as const satisfies Plugin;
