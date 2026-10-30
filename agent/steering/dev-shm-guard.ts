// SPDX-License-Identifier: MIT
/**
 * /dev/shm guard — keeps agent scratch out of /dev/shm.
 *
 * Incident 2026-10-30 07:39Z: lens subagents (mutant copies, `go test`
 * with TMPDIR=/dev/shm, lane CI clones) filled the 16 GiB /dev/shm
 * tmpfs. Hyprland writes each keymap into a fresh shm_open() file in
 * /dev/shm; on the full tmpfs the write faulted and Hyprland died with
 * SIGBUS, taking the whole desktop session with it. /dev/shm is shared
 * with the compositor, browsers and PipeWire: agents never get to fill it.
 *
 * Scratch goes in $TMPDIR (`mktemp -d`; /data/tmp on this host, /tmp
 * elsewhere). Exempt: /dev/shm/tshhome, the isolated Teleport HOME
 * (a few KB). Reads and cleanup (ls, du, df, cat, rm) stay allowed:
 * only writer binaries are routed. Shell scripts that hardcode
 * /dev/shm internally are not visible here — fix those at the source.
 *
 * Known gap: an output redirect to an absolute /dev/shm path from
 * outside /dev/shm (`awk … > /dev/shm/x`) is not seen — pi-steering
 * does not expose redirect targets to predicates (PredicateToolInput
 * carries args + envAssignments only). Pinned in the test file.
 */

import type { PredicateShape } from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		touchesDevShm: PredicateShape<boolean>;
	}
}

/** A path at or under /dev/shm, except the tshhome exemption. */
const DEV_SHM = /\/dev\/shm(?!\/tshhome(?![^/\s"'`;|&)]))(?=$|[/\s"'`;|&)])/;
const DEV_SHM_PATH = /^\/dev\/shm(?!\/tshhome(?:\/|$))(?:\/|$)/;

/** Binaries that create or fill files (writers, interpreters, builders). */
export const DEV_SHM_WRITERS = [
	"cp",
	"mv",
	"mkdir",
	"rsync",
	"git",
	"tar",
	"tee",
	"touch",
	"install",
	"ln",
	"dd",
	"truncate",
	"fallocate",
	"mktemp",
	"unzip",
	"curl",
	"wget",
	"go",
	"make",
	"cargo",
	"npm",
	"pnpm",
	"docker",
	"python",
	"python3",
	"perl",
	"awk",
	"sed",
	"node",
	"bash",
	"sh",
	"env",
] as const;

/** Names already declared by other plugins (git plugin; agentConfigGuardPlugin in index.ts). */
const DECLARED_ELSEWHERE = new Set([
	"git",
	"sed",
	"cp",
	"tee",
	"mv",
	"python",
	"python3",
	"perl",
	"awk",
	"node",
	"bash",
	"sh",
]);

export const devShmGuardPlugin = {
	name: "dev-shm-guard",
	cliDescriptors: Object.fromEntries(
		DEV_SHM_WRITERS.filter((b) => !DECLARED_ELSEWHERE.has(b)).map((b) => [b, {}]),
	),
	predicates: {
		touchesDevShm: (
			args: unknown,
			ctx: {
				input?: { command?: string; envAssignments?: ReadonlyArray<{ value?: string; text?: string }> };
				walkerState?: { cwd?: unknown; env?: ReadonlyMap<string, string> };
			},
		) => {
			if (args !== true) return false;
			const cmd = typeof ctx?.input?.command === "string" ? ctx.input.command : "";
			if (DEV_SHM.test(cmd)) return true;
			// TMPDIR from the chain (`export TMPDIR=…`) or the ref's own prefix (`TMPDIR=… go test`).
			const tmpdir = ctx?.walkerState?.env?.get?.("TMPDIR");
			if (typeof tmpdir === "string" && DEV_SHM_PATH.test(tmpdir)) return true;
			for (const w of ctx?.input?.envAssignments ?? []) {
				const tok = (w?.value ?? w?.text ?? "").replace(/^["']|["']$/g, "");
				const m = /^TMPDIR=["']?(.*?)["']?$/.exec(tok);
				if (m && DEV_SHM_PATH.test(m[1] ?? "")) return true;
			}
			const cwd = ctx?.walkerState?.cwd;
			if (typeof cwd === "string" && DEV_SHM_PATH.test(cwd)) return true;
			return false;
		},
	},
};

const REASON =
	"Do not put scratch in /dev/shm: it is shared with the compositor (Hyprland), browsers and PipeWire, and filling it crashed the desktop on 2026-10-30. Use $TMPDIR instead (`d=$(mktemp -d)`; it is /data/tmp on this host, /tmp elsewhere), and do not override TMPDIR. Reads and cleanup of /dev/shm are allowed; /dev/shm/tshhome is exempt.";

export const devShmRules = [
	{
		name: "no-dev-shm-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: DEV_SHM_PATH,
		reason: REASON,
	},
	{
		name: "no-dev-shm-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: DEV_SHM_PATH,
		reason: REASON,
	},
	{
		name: "no-dev-shm-bash",
		tool: "bash" as const,
		command: [...DEV_SHM_WRITERS],
		when: { touchesDevShm: true },
		reason: REASON,
	},
];
