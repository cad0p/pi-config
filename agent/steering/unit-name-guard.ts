// SPDX-License-Identifier: MIT
/**
 * unit-name-guard — the gate/land/queue unit names are the merge tools',
 * and a systemd-run ExecStart may not run a scratch or state wrapper script.
 *
 * Why (measured 2026-11-23):
 *   1. 05h1xZ — lane H4 (unit pc-gate-xbx1) launched a full CI run as
 *      'systemd-run --unit=pc-gate-xbx1 … pc-admit.sh run … tools/ci.sh
 *      --container'. Every lane reads a 'pc-gate-*' unit as "a gate is
 *      running" (owner rule r), so one CI run held every other lane's CI
 *      queue for the unit's whole life. Real gate/land/queue/preflight
 *      units always run Goldmine Scripts/orchestration/merge-run.sh (or
 *      tools/merge-pr.sh with gate|queue|land|preflight|absorb).
 *   2. Same hour, three lanes (pc-ci-sitesfix3 04h33Z, pc-renovate-114r2-ci
 *      05h01Z, pc-gate-xbx1) self-fired a CI outside their session's queue.
 *   3. 05h01Z — unit a2-four.service ran
 *      '/usr/bin/bash /home/pier/.local/state/h4-orchestration/tmp-1319/a2-four.sh'.
 *      That untracked script's body did 'git worktree add' outside pc-wt —
 *      a command no-worktree-outside-pc-wt refuses when typed inline. A
 *      script ExecStart hides every command from steering; the owner rule
 *      is: commands inline, never a /data/tmp (or state-dir) wrapper.
 *
 * Refused:
 *   A. unit-name-gate-reserved — a 'systemd-run' ref whose unit name
 *      (--unit/-u, separate or =/glued, a '.service' suffix allowed) starts
 *      with pc-gate, pc-land, pc-queue/pc-q or pc-preflight, UNLESS the
 *      same ref carries a merge-tool invocation with one of the merge
 *      verbs: merge-run.sh / merge-pr.sh + gate|queue|land|preflight|absorb.
 *      The verbs are read from the ref's own argv, which — for a
 *      systemd-run ExecStart — carries the whole payload (systemd-run is
 *      not an expandable wrapper, so '-- bash -c …' stays one ref's args;
 *      a real gate recipe reads
 *      'merge-run.sh <label> <note> -- queue land cad0p/pc-host').
 *      pc-ci-* / pc-mlux-ci-* / pc-testop-* / pc-probe-* / pc-wt-* are not
 *      reserved.
 *   B. systemd-run-no-script-execstart — a 'systemd-run' ref whose command
 *      operand (after '--', or the first non-flag word) executes a script
 *      file under /data/tmp, ~/.local/state/h4-orchestration or ~/.cache.
 *      Forms: 'bash <path>', '/usr/bin/bash <path>', 'sh <path>', the path
 *      itself as the command, and a leading env/nice/sudo/ionice wrapper
 *      before either. A relative path is resolved against the ref's
 *      effective cwd and refused when that cwd is under a scratch root
 *      ('cd /data/tmp/x && systemd-run …').
 *
 * Allowed: tracked repo tools (tools/*.sh in a checkout,
 * Goldmine/Scripts/orchestration/*), inline payloads ('-- bash -c …' —
 * nothing to hide), and every non-systemd-run ref; a unit name or script
 * path that is dynamically built ('--unit=$U', 'bash "$S"') is unreadable
 * and allowed (pinned in the tests).
 *
 * Known gaps (pinned in ./unit-name-guard.test.ts):
 *   - the checks are textual over the systemd-run ref's argv: a payload
 *     that merely echoes the words (echo 'merge-run.sh gate …') passes, and
 *     a tracked script allowed by name can still do anything inside;
 *   - a unit name the engine cannot resolve (a variable, a command
 *     substitution, a braced variable) reads as unreserved;
 *   - a script reached through a non-shell indirection (python3 script.py,
 *     a compiled helper) is not a shell exec form and is not refused;
 *   - a 'bash -c …' INSIDE the payload (systemd-run never expands it) is
 *     still one ref: the outer argv is all steering sees;
 *   - another lane self-firing a CI is NOT refused here: the CI queue is
 *     per-session state steering cannot read, so rule A only protects the
 *     shared gate/land/queue names.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateShape,
} from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		/** 'when.reservesGateUnitName' — a reserved merge-unit name, no merge tool. */
		reservesGateUnitName: PredicateShape<boolean>;
		/** 'when.execStartRunsScratchScript' — the unit's command is a scratch script. */
		execStartRunsScratchScript: PredicateShape<boolean>;
	}
}

/** The one basename both rules route (probe-scope-guard declares its descriptor). */
export const SYSTEMD_RUN = "systemd-run";

/**
 * Reserved unit-name stems. Any suffix after the stem is fine: the
 * reservation lives on the stem, because that is what every lane greps for
 * in 'systemctl --user list-units pc-gate-*'.
 */
export const RESERVED_UNIT_NAME =
	/^pc-(?:gate|land|preflight)(?:[-_.]|$)|^pc-q/;

/** The verbs a real gate/queue/land/preflight unit runs (merge-run.sh / merge-pr.sh). */
export const MERGE_VERBS = [
	"gate",
	"queue",
	"land",
	"preflight",
	"absorb",
] as const;

/** The merge tools whose invocation releases rule A. */
export const MERGE_TOOL = /\b(?:merge-run|merge-pr)\.sh\b/;

/** The merge verbs, for token equality (a unit name is not a verb). */
const MERGE_VERB_SET: ReadonlySet<string> = new Set(MERGE_VERBS);

/**
 * Scratch roots whose ExecStart scripts hide commands from steering. The
 * home-relative forms are expanded so the rule follows the user, not a
 * hard-coded /home path; the incident's literal paths are these values on
 * this host.
 */
export const SCRATCH_ROOTS: readonly string[] = [
	"/data/tmp",
	join(homedir(), ".local", "state", "h4-orchestration"),
	join(homedir(), ".cache"),
];

/** systemd-run options that consume the NEXT word as their value. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
	"-p",
	"--property",
	"-u",
	"--unit",
	"-E",
	"--setenv",
	"-D",
	"--working-directory",
	"-H",
	"--host",
	"-M",
	"--machine",
	"-n",
	"--nice",
	"--slice",
	"--slice-inherit",
	"--description",
	"--uid",
	"--gid",
	"--setenv-replace",
	"--drop-in",
	"--on-active",
	"--on-boot",
	"--on-startup",
	"--on-unit-active",
	"--on-unit-inactive",
	"--on-calendar",
	"--timer-property",
	"--path-property",
	"--socket-property",
	"--service-type",
	"--kill-whom",
	"--kill-signal",
	"--signal",
	"--output",
	"--log-target",
]);

/** Shells whose script operand is the ExecStart's real content. */
const SHELLS: ReadonlySet<string> = new Set([
	"bash",
	"sh",
	"dash",
	"zsh",
	"ksh",
	"ash",
]);

/** Passthrough launchers that may sit before the shell or the path. */
const PASSTHROUGH: ReadonlySet<string> = new Set([
	"env",
	"nice",
	"sudo",
	"ionice",
	"setsid",
	"nohup",
	"timeout",
]);

/** Drop one layer of matching shell quotes and trim. */
export function unquote(raw: string): string {
	const s = raw.trim();
	if (s.length >= 2) {
		const q = s[0];
		if ((q === '"' || q === "'") && s.endsWith(q)) return s.slice(1, -1).trim();
	}
	return s;
}

/** The last path segment, unquoted. */
export function pathBase(raw: string): string {
	const s = unquote(raw).replace(/\/+$/, "");
	const cut = s.lastIndexOf("/");
	return cut >= 0 ? s.slice(cut + 1) : s;
}

/** A word a resolver (variable, substitution) could change: unresolvable. */
export function isDynamic(word: string): boolean {
	return word.includes("$") || word.includes("\u0060");
}

/** The unit name when it is statically readable, else null. */
function staticUnit(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	const name = unquote(raw);
	if (name === "" || isDynamic(name)) return null;
	return name;
}

/**
 * The unit name a systemd-run argv names: '--unit=X', '--unit X', '-uX',
 * '-u X'. Null when the ref names none, or names one this rule cannot
 * resolve (a variable or substitution — allowed, see the header).
 */
export function unitNameOf(words: readonly string[]): string | null {
	for (let i = 0; i < words.length; i++) {
		const w = unquote(words[i] ?? "");
		if (w === "--") break;
		if (w === "--unit" || w === "-u") return staticUnit(words[i + 1]);
		if (w.startsWith("--unit=")) return staticUnit(w.slice("--unit=".length));
		if (w.startsWith("-u") && w.length > 2) return staticUnit(w.slice(2));
	}
	return null;
}

/** Is this unit name one of the merge-tool names? */
export function isReservedUnitName(name: string | null): boolean {
	if (name === null) return false;
	return RESERVED_UNIT_NAME.test(name);
}

/**
 * Does the text carry a merge-tool invocation followed by a merge verb?
 * merge-run.sh puts the verb after '<label> <note> --', so the whole
 * command segment is scanned, not just the next word.
 */
export function runsMergeToolVerb(text: string): boolean {
	const re = new RegExp(MERGE_TOOL.source, "g");
	let m = re.exec(text);
	while (m !== null) {
		const rest = text.slice(m.index + m[0].length);
		const segment = rest.split(/[;|\n]|&&/)[0] ?? "";
		// TOKEN equality, not a word match: 'pc-gate-x' and a note path are
		// not verbs, so a reserved unit name can never satisfy the release.
		for (const token of segment.split(/\s+/)) {
			if (MERGE_VERB_SET.has(unquote(token).toLowerCase())) return true;
		}
		m = re.exec(text);
	}
	return false;
}

/**
 * The command operand of a systemd-run argv: everything after '--', else
 * from the first non-flag word (skipping options and their values).
 */
export function commandOperand(words: readonly string[]): string[] {
	const dd = words.indexOf("--");
	if (dd >= 0) return words.slice(dd + 1);
	for (let i = 0; i < words.length; i++) {
		const w = unquote(words[i] ?? "");
		if (w === "") continue;
		if (w.startsWith("-")) {
			// A value-taking option spelled separately consumes the next word;
			// a glued form (-pX=Y, --unit=X, --property=X) is self-contained.
			if (VALUE_FLAGS.has(w)) i++;
			continue;
		}
		return words.slice(i);
	}
	return [];
}

/**
 * The script path the unit's command would execute, or null when it runs
 * anything else (an inline 'bash -c' payload, a binary, no command).
 */
export function scriptOperand(words: readonly string[]): string | null {
	let i = 0;
	// Passthrough launchers, and their own value-taking flags.
	while (i < words.length) {
		const head = pathBase(words[i] ?? "");
		if (!PASSTHROUGH.has(head)) break;
		i++;
		while (i < words.length) {
			const w = unquote(words[i] ?? "");
			if (!w.startsWith("-")) break;
			i++;
			if (w === "-n" || w === "-u" || w === "-s" || w === "-g") i++;
		}
		if (head === "timeout") {
			if (i < words.length && !unquote(words[i] ?? "").startsWith("-")) i++;
		}
	}
	const head = words[i];
	if (head === undefined) return null;
	const headBase = pathBase(head);
	if (SHELLS.has(headBase)) {
		i++;
		while (i < words.length) {
			const w = unquote(words[i] ?? "");
			if (w === "") break;
			if (!w.startsWith("-") && !w.startsWith("+")) {
				return isDynamic(w) ? null : w;
			}
			// 'bash -c <payload>' is inline: nothing to hide, nothing to refuse.
			if (w === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(w)) return null;
			if (w === "-o" || w === "-O" || w === "+o" || w === "+O") i++;
			i++;
		}
		return null;
	}
	// The path itself as the command ('-- /data/tmp/x/run.sh').
	const bare = unquote(head);
	if (isDynamic(bare)) return null;
	if (/\.(?:sh|bash|zsh|ksh)$/i.test(bare)) return bare;
	return null;
}

/** Expand '~', '$HOME', a braced HOME, '$XDG_CACHE_HOME'; leave the rest alone. */
export function expandPath(raw: string, home: string = homedir()): string {
	let p = unquote(raw);
	const xdg = process.env.XDG_CACHE_HOME;
	if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
	p = p.replace(/^\$(?:\{HOME\}|HOME)(?=\/|$)/, home);
	if (typeof xdg === "string" && xdg !== "") {
		p = p.replace(/^\$(?:\{XDG_CACHE_HOME\}|XDG_CACHE_HOME)(?=\/|$)/, xdg);
	}
	return p;
}

/** Resolve a path for the root test: absolute as-is, relative against the cwd. */
export function absolutePath(raw: string, cwd?: string): string | null {
	const expanded = expandPath(raw);
	if (isAbsolute(expanded)) return resolve(expanded);
	if (typeof cwd !== "string" || cwd === "" || cwd === "unknown") return null;
	return resolve(cwd, expanded);
}

/** Is this path under one of the scratch roots? */
export function isUnderScratchRoot(path: string): boolean {
	return SCRATCH_ROOTS.some((root) => {
		const r = expandPath(root).replace(/\/+$/, "");
		return path === r || path.startsWith(r + "/");
	});
}

/** The scratch script an ExecStart would run, or null. */
export function scratchScriptOf(
	words: readonly string[],
	cwd?: string,
): string | null {
	const script = scriptOperand(words);
	if (script === null) return null;
	const abs = absolutePath(script, cwd);
	if (abs === null) return null;
	return isUnderScratchRoot(abs) ? abs : null;
}

/** The ref's argv as resolved words (the engine's value wins over the text). */
function refWords(ctx: {
	input?: { args?: ReadonlyArray<{ value?: string; text?: string }> };
}): string[] {
	return (ctx.input?.args ?? []).map((w) => w?.value ?? w?.text ?? "");
}

/**
 * The ref's text: its resolved argv when the engine handed one over, else
 * the raw ref text. Never both — a doubled command would let a token from
 * one copy satisfy a check aimed at the other (a unit name reading as a
 * merge verb, 2026-11-23).
 */
function refText(ctx: {
	input?: {
		command?: string;
		args?: ReadonlyArray<{ value?: string; text?: string }>;
	};
}): string {
	const joined = refWords(ctx).join(" ");
	if (joined !== "") return joined;
	return typeof ctx.input?.command === "string" ? ctx.input.command : "";
}

/** The ref's effective cwd, when the walker resolved one. */
function refCwd(ctx: { walkerState?: { cwd?: unknown } }): string | undefined {
	const cwd = ctx.walkerState?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/** 'when.reservesGateUnitName' — a reserved name with no merge-tool verb. */
export const reservesGateUnitNamePredicate = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		if (ctx.input.basename !== SYSTEMD_RUN) return false;
		const reserved = isReservedUnitName(unitNameOf(refWords(ctx)));
		const fires = reserved && !runsMergeToolVerb(refText(ctx));
		return fires === expected;
	},
);

/** 'when.execStartRunsScratchScript' — the unit's ExecStart is a scratch script. */
export const execStartRunsScratchScriptPredicate =
	definePredicate<BooleanLeafArgs>((args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		if (ctx.input.basename !== SYSTEMD_RUN) return false;
		const hit = scratchScriptOf(commandOperand(refWords(ctx)), refCwd(ctx));
		return (hit !== null) === expected;
	});

/**
 * Agent-facing message A: the reserved namespace, the CI naming, and the
 * allowed gate recipe.
 */
export const RESERVED_UNIT_REASON =
	"pc-gate-/pc-land-/pc-q*/pc-preflight- names mean a merge-tool gate to every lane (owner rule r): every session reads a pc-gate-* unit as 'a gate is running' and holds its CI queue for the unit's whole life — on 2026-11-23 05h1xZ a lane named a full CI run pc-gate-xbx1 and held every other lane's CI queue for its run. A CI run is named pc-ci-<label> (or pc-mlux-ci-<label>) and goes through your session's CI queue: systemd-run --user --collect -p RuntimeMaxSec=600 --unit=pc-ci-<label> -- <the CI command>. Those names belong to the merge tools only — the same command must run merge-run.sh (or tools/merge-pr.sh) with a verb gate|queue|land|preflight|absorb, e.g. systemd-run --user --unit=pc-land-<pr> -p RuntimeMaxSec=3600 --working-directory=<merge clone> -- bash <vault>/Scripts/orchestration/merge-run.sh <label> <PR note> -- queue land cad0p/pc-host.";

/**
 * Agent-facing message B: inline the command, and name the tracked tools
 * that stay allowed.
 */
export const SCRIPT_EXECSTART_REASON =
	"a systemd-run ExecStart may not run a script under /data/tmp, ~/.local/state/h4-orchestration or ~/.cache: a wrapper script hides every command inside it from steering — on 2026-11-23 05h01Z unit a2-four.service ran ~/.local/state/h4-orchestration/tmp-1319/a2-four.sh, whose body did git worktree add outside pc-wt (no-worktree-outside-pc-wt refuses that command when typed inline). Write the command inline in the unit: systemd-run ... -- bash -c '<commands>' (single quotes keep $ literal; escape $ inside double quotes) so every worktree/fetch/delete command in it is visible to the guards. Tracked tools stay fine: tools/*.sh inside a checkout, Goldmine Scripts/orchestration/*, or a committed merge-run.sh recipe.";

export const unitNameGuardRules = [
	{
		name: "unit-name-gate-reserved",
		tool: "bash" as const,
		command: [SYSTEMD_RUN] as const,
		when: { reservesGateUnitName: true },
		reason: RESERVED_UNIT_REASON,
	},
	{
		name: "systemd-run-no-script-execstart",
		tool: "bash" as const,
		command: [SYSTEMD_RUN] as const,
		when: { execStartRunsScratchScript: true },
		reason: SCRIPT_EXECSTART_REASON,
	},
];

export const unitNameGuardPlugin = {
	name: "unit-name-guard",
	// No cliDescriptors: probe-scope-guard already declares systemd-run (a
	// second declaration is a descriptor collision, and collisions disable
	// steering in strict mode).
	predicates: {
		reservesGateUnitName: reservesGateUnitNamePredicate,
		execStartRunsScratchScript: execStartRunsScratchScriptPredicate,
	},
} as const satisfies Plugin;
