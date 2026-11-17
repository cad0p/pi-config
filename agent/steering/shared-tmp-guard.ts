// SPDX-License-Identifier: MIT
/**
 * Shared-tmp guard — machine-local: keeps agent scratch out of /tmp and
 * /var/tmp on a machine that names its own scratch root.
 *
 * Why (2026-11-17, owner): on this laptop /tmp is a 16G tmpfs (RAM) and
 * /var/tmp sits on the nearly full root disk. Every agent already has
 * TMPDIR=/data/tmp, but briefs and agents typed /tmp/… and /var/tmp/…
 * by hand: /tmp held 13G of RAM and /var/tmp 34G of stale lens scratch.
 *
 * Machine parameter, never carried by pi-config: the rule is OFF unless
 * the machine-local file ~/.config/pi-steering/scratch-root exists and
 * names an absolute directory (this laptop: /data/tmp). The file is read
 * on every check, so creating or deleting it takes effect at once. Tests
 * point PI_STEERING_SCRATCH_ROOT_FILE at a fixture file instead.
 *
 * Exempt: unix sockets (a path ending in .sock; socket paths have a
 * 108-byte limit, so /tmp is their right home). Reads and cleanup
 * (ls, du, df, cat, rm) stay allowed: only writer binaries are routed,
 * the same list as the /dev/shm guard. Known gap, as there: an absolute
 * redirect target (`> /tmp/x`) is not visible to predicates.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PredicateShape } from "@cad0p/pi-steering";
import { DEV_SHM_WRITERS } from "./dev-shm-guard.ts";

declare global {
	interface PiSteeringPredicates {
		touchesSharedTmp: PredicateShape<boolean>;
		sharedTmpPathOnScratchMachine: PredicateShape<boolean>;
	}
}

/** The machine's scratch root, or undefined when this machine has not opted in. */
export function machineScratchRoot(): string | undefined {
	const file =
		process.env.PI_STEERING_SCRATCH_ROOT_FILE ??
		join(process.env.HOME ?? homedir(), ".config", "pi-steering", "scratch-root");
	try {
		if (!existsSync(file)) return undefined;
		const root = readFileSync(file, "utf8").trim();
		return root.startsWith("/") ? root : undefined;
	} catch {
		return undefined;
	}
}

/** Every /tmp or /var/tmp path token in a command (not /data/tmp, not /tmpfoo). */
const SHARED_TMP_TOKEN = /(?<![\w.\/-])\/(?:var\/)?tmp(?:\/[^\s"'`;|&)<>]*)?(?=$|[\s"'`;|&)<>])/g;
const SHARED_TMP_PATH = /^\/(?:var\/)?tmp(?:\/|$)/;
const SOCKET = /\.sock$/;

function hitsSharedTmp(text: string): boolean {
	for (const m of text.matchAll(SHARED_TMP_TOKEN)) {
		if (!SOCKET.test(m[0])) return true;
	}
	return false;
}

export const sharedTmpGuardPlugin = {
	name: "shared-tmp-guard",
	// Every writer binary is already declared by the /dev/shm guard or another plugin.
	cliDescriptors: {},
	predicates: {
		touchesSharedTmp: (
			args: unknown,
			ctx: {
				input?: { command?: string; envAssignments?: ReadonlyArray<{ value?: string; text?: string }> };
				walkerState?: { cwd?: unknown; env?: ReadonlyMap<string, string> };
			},
		) => {
			if (args !== true) return false;
			if (machineScratchRoot() === undefined) return false;
			const cmd = typeof ctx?.input?.command === "string" ? ctx.input.command : "";
			if (hitsSharedTmp(cmd)) return true;
			const tmpdir = ctx?.walkerState?.env?.get?.("TMPDIR");
			if (typeof tmpdir === "string" && SHARED_TMP_PATH.test(tmpdir)) return true;
			for (const w of ctx?.input?.envAssignments ?? []) {
				const tok = (w?.value ?? w?.text ?? "").replace(/^["']|["']$/g, "");
				const m = /^TMPDIR=["']?(.*?)["']?$/.exec(tok);
				if (m && SHARED_TMP_PATH.test(m[1] ?? "")) return true;
			}
			const cwd = ctx?.walkerState?.cwd;
			if (typeof cwd === "string" && SHARED_TMP_PATH.test(cwd)) return true;
			return false;
		},
		sharedTmpPathOnScratchMachine: (args: unknown) => args === true && machineScratchRoot() !== undefined,
	},
};

const reason = () => {
	const root = machineScratchRoot() ?? "$TMPDIR";
	return `Do not put scratch in /tmp or /var/tmp on this machine: /tmp is RAM (tmpfs) and /var/tmp is the nearly full root disk. Use ${root} (it is already $TMPDIR: \`d=$(mktemp -d)\`), and do not override TMPDIR. Unix sockets (*.sock) are exempt; reading and removing under /tmp and /var/tmp are allowed. This rule is machine-local: ~/.config/pi-steering/scratch-root turns it on.`;
};

export const sharedTmpRules = [
	{
		name: "no-shared-tmp-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: SHARED_TMP_PATH,
		unless: SOCKET,
		when: { sharedTmpPathOnScratchMachine: true },
		reason,
	},
	{
		name: "no-shared-tmp-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: SHARED_TMP_PATH,
		unless: SOCKET,
		when: { sharedTmpPathOnScratchMachine: true },
		reason,
	},
	{
		name: "no-shared-tmp-bash",
		tool: "bash" as const,
		command: [...DEV_SHM_WRITERS],
		when: { touchesSharedTmp: true },
		reason,
	},
];
