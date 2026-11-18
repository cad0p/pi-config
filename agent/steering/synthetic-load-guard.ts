// SPDX-License-Identifier: MIT
/**
 * synthetic-load-guard — no uncapped synthetic CPU load on the shared lane.
 *
 * pc-host #1273. The operator laptop runs every repo's gate through one
 * CI lane, and the gate's per-job caps assume the load that real work
 * makes. Two incidents where prose did not hold:
 *
 *   - 2026-11-17 23:45-23:47Z: a builder ran `pc-probe-1262load2`, 24
 *     busy-loop spinners at nice 0, to time a suite under load.
 *     load1 reached 36.
 *   - 2026-11-18 from ~01:58Z: the #383 builder ran `383-burn.sh`
 *     (24 spinners of `while [ -e "$1" ]; do :; done`, nice 0, 300 s)
 *     twice while the H4 gate `pc-gate-388c` held the lane. load1
 *     reached 62 then 78; the first #388 gate had already failed from
 *     load (pc-tenant #388, one mutant timed out).
 *
 * Refused (bash refs whose text — the ref's own `basename + args` —
 * carries a CPU load generator and no cgroup cap):
 *   - a shell busy loop: `do :; done`, `do true; done`,
 *     `while :; do :`, `while true; do :`, `for((;;))`;
 *   - `stress` / `stress-ng` invoked with arguments;
 *   - `yes … > /dev/null` when the redirect is visible in the ref
 *     (nested payloads like `bash -c 'yes >/dev/null'` — see the gap
 *     below);
 *   - a script whose basename matches `*burn*.sh`, `*hog*.sh`,
 *     `*stress*.sh` (e.g. `bash /data/tmp/383-burn.sh`, whose body
 *     the rule cannot see — hence the write/edit content rule).
 *
 * The only escape is a cgroup cap, not politeness: the same ref must
 * launch it through `systemd-run` with BOTH `CPUQuota=` and
 * `RuntimeMaxSec=` (`-p X=Y` or `--property=X=Y`). `nice` alone
 * is not a cap — it keeps the load, it only reschedules who suffers.
 *
 * Write/edit companion: a file body carrying a busy loop is refused
 * unless the body also carries `CPUQuota=` — catches scripts like
 * 383-burn.sh at authoring time, where the launcher line cannot be
 * seen (the bash ref for `bash script.sh` names only the script).
 *
 * Known gaps (same engine limits as ./probe-scope-guard.ts):
 *   - one ref = `basename + args`; the `&` operator and a script's
 *     BODY belong to no ref, so the bash rule cannot see inside them
 *     (the write/edit rule covers the authoring side).
 *   - the cap check is textual: `systemd-run` + `CPUQuota=` +
 *     `RuntimeMaxSec=` in the same ref. It does not verify the values
 *     are attached via `-p`/`--property=` — an `echo CPUQuota=`
 *     inside the payload would slip, and a nonzero-but-huge quota
 *     passes; the reason text names the honest form.
 *   - a loop pasted as a bare compound command (`while :; do :; done`
 *     with no routed basename) extracts no ref and cannot fire.
 *   - a TOP-LEVEL `yes >/dev/null` is invisible: pi-steering exposes
 *     only `basename + args`, never redirect targets (the ref is bare
 *     `yes`, byte-identical to the `yes` ref of `yes | head -3`,
 *     which must stay allowed). The `>` survives only inside quoted
 *     payloads (`bash -c 'yes >/dev/null'`), where this rule does
 *     catch it. Same limit as dev-shm-guard's pinned redirect gap.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateShape,
} from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		/** `when.runsUncappedSyntheticLoad` — this ref starts a CPU load generator with no cgroup cap. */
		runsUncappedSyntheticLoad: PredicateShape<boolean>;
	}
}

/**
 * Routed basenames: launchers, wrappers, and the generators themselves.
 * Wrappers matter because their ref text carries the payload's argv
 * (`timeout 300 bash -c '…do :; done…'` — the timeout ref sees the
 * loop; a `timeout` is a time bound, never a CPU cap).
 */
export const SYNTHETIC_LOAD_ROUTED = [
	"bash",
	"sh",
	"env",
	"nice",
	"timeout",
	"systemd-run",
	"stress",
	"stress-ng",
	"yes",
	"setsid",
	"nohup",
] as const;

/**
 * Basenames another plugin in this config already describes
 * (agent-config-guard owns bash/sh; dev-shm-guard owns env; tsh-guard
 * owns timeout; probe-scope-guard owns systemd-run/setsid/nohup — a
 * second declaration is a descriptor collision, and collisions disable
 * steering in strict mode).
 */
const DECLARED_ELSEWHERE = new Set([
	"bash",
	"sh",
	"env",
	"timeout",
	"systemd-run",
	"setsid",
	"nohup",
]);

/** A pure-CPU loop body: `do :; done` or `do true; done`. */
export const BUSY_LOOP_BODY = /\bdo\s*(?::|true)\s*;?\s*done\b/;

/** `while :; do :` / `while true; do :` — a constant condition spinning an empty body. */
export const BUSY_LOOP_COND =
	/\bwhile\s*(?::|true)\s*;?\s*do\s*(?::|true)(?=[\s;]|$)/;

/** `for((;;))` — the C-style forever loop. */
export const FOR_EVER = /\bfor\s*\(\(\s*;\s*;\s*\)\)/;

/** `stress` / `stress-ng` with an argument (bare `stress` does no work). */
export const STRESS_CALL = /\bstress(?:-ng)?\s+(?:--?[A-Za-z]|\d)/;

/** `yes > /dev/null` (any pipeline/args before the redirect; `yes | head -3` has no redirect and stays allowed). */
export const YES_DISCARD = /\byes\b[^;&\n]*>\s*\/dev\/null\b/;

/** A script basename matching *burn*.sh / *hog*.sh / *stress*.sh. */
export const GENERATOR_SCRIPT = /\S*(?:burn|hog|stress)\S*\.sh\b/;

/** The generator shape, independent of any cap. */
export function isLoadGeneratorShape(text: string): boolean {
	return (
		BUSY_LOOP_BODY.test(text) ||
		BUSY_LOOP_COND.test(text) ||
		FOR_EVER.test(text) ||
		STRESS_CALL.test(text) ||
		YES_DISCARD.test(text) ||
		GENERATOR_SCRIPT.test(text)
	);
}

/**
 * The cgroup cap: the SAME ref text must carry `systemd-run` plus both
 * `CPUQuota=` and `RuntimeMaxSec=`. A `timeout` is not a cap (it
 * bounds duration, not cores — the 383-burn specimen ran under
 * `timeout 300` at load1 78); `nice` is not a cap either.
 */
export function hasCgroupCap(text: string): boolean {
	return (
		/\bsystemd-run\b/.test(text) &&
		/\bCPUQuota\s*=/.test(text) &&
		/\bRuntimeMaxSec\s*=/.test(text)
	);
}

/** The decision: does this ref run a CPU load generator with no cgroup cap? */
export function isUncappedSyntheticLoad(
	_basename: string | undefined,
	text: string,
): boolean {
	if (hasCgroupCap(text)) return false;
	return isLoadGeneratorShape(text);
}

/** `when.runsUncappedSyntheticLoad` — a boolean leaf; unknown arg never fires. */
export const runsUncappedSyntheticLoadPredicate =
	definePredicate<BooleanLeafArgs>((args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		const text =
			typeof ctx.input.command === "string" ? ctx.input.command : "";
		const fires = isUncappedSyntheticLoad(ctx.input.basename, text);
		return fires === expected;
	});

/**
 * Write/edit content: a busy loop with no `CPUQuota=` anywhere in the
 * body. The `^(?![\s\S]*CPUQuota\s*=)` lookahead fails fast on a
 * capped script; the `[\s\S]*` then reaches a loop anywhere in the file.
 */
export const UNCAPPED_BUSY_LOOP_CONTENT = new RegExp(
	"^(?![\\s\\S]*CPUQuota\\s*=)[\\s\\S]*(?:" +
		[BUSY_LOOP_BODY.source, BUSY_LOOP_COND.source, FOR_EVER.source].join(
			"|",
		) +
		")",
);

/** Agent-facing message: what was refused, why, and the one allowed form. */
const REASON =
	"uncapped synthetic CPU load refused (pc-host #1273): this host is shared with the gates — pc-gate/pc-land/pc-testop/pc-ci units — and a load generator beside a gate fails or flakes it (on 2026-11-18 a 24-spinner busy loop under 'timeout 300' took load1 to 78 while pc-gate-388c held the lane; the first #388 gate had already failed from load). A timeout bounds duration, not cores, and nice alone is not a cap. If synthetic load is genuinely needed, run it inside a capped unit: systemd-run --user --collect -p CPUQuota=200% -p RuntimeMaxSec=300 -p Nice=19 -- <cmd> (BOTH properties required, or the --property= forms), and only while no pc-gate/pc-land/pc-testop/pc-ci unit is active; otherwise measure under the load that exists and say so. A written/edited script carrying a busy loop needs CPUQuota= in the file itself (the bash rule cannot see inside 'bash script.sh').";

export const syntheticLoadGuardRules = [
	{
		name: "no-uncapped-synthetic-load",
		tool: "bash" as const,
		command: [...SYNTHETIC_LOAD_ROUTED],
		when: { runsUncappedSyntheticLoad: true },
		reason: REASON,
	},
	{
		name: "no-uncapped-synthetic-load-write",
		tool: "write" as const,
		field: "content" as const,
		pattern: UNCAPPED_BUSY_LOOP_CONTENT,
		reason: REASON,
	},
	{
		name: "no-uncapped-synthetic-load-edit",
		tool: "edit" as const,
		field: "content" as const,
		pattern: UNCAPPED_BUSY_LOOP_CONTENT,
		reason: REASON,
	},
];

export const syntheticLoadGuardPlugin = {
	name: "synthetic-load-guard",
	cliDescriptors: Object.fromEntries(
		SYNTHETIC_LOAD_ROUTED.filter((b) => !DECLARED_ELSEWHERE.has(b)).map(
			(b) => [b, {}],
		),
	),
	predicates: {
		runsUncappedSyntheticLoad: runsUncappedSyntheticLoadPredicate,
	},
} as const satisfies Plugin;
