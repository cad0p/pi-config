// SPDX-License-Identifier: MIT
/**
 * tsh guard — no agent may change the shared Teleport client state (~/.tsh).
 *
 * Every agent session on this laptop shares ONE Teleport client home,
 * '~/.tsh': one 'current-profile' file, one per-proxy yaml (user: field)
 * plus its key set. Incidents:
 *   - personal/github/pc-host/debugging/2026-10-23-tsh-shared-profile-switched-by-another-session.md
 *     (another session's 'tsh login' switched the profile mid-run; the
 *     bare switch-back without --ttl left an expired cert on 10-27).
 *   - Goldmine personal/github/pc-host/guides/2026-11-05-pin-a-tsh-command-to-one-profile-with-proxy.md
 *     (measured: --proxy=<host> pins the CLUSTER and is read-only, but
 *     NOT the identity — another session's 'tsh login --user=X' to the
 *     same proxy, or a 'tsh logout', changes what a pinned command uses).
 * The owner asked (2026-11-08): cover the risk with a steering rule — yes:
 * forbid the writes instead of isolating every reader. The owner does the
 * logins himself, in his own terminal, not through pi.
 *
 * Rules (all fail-closed: an unresolvable TELEPORT_HOME counts as shared):
 *   1. no-shared-tsh-login          — 'tsh login' in ANY form is refused
 *      unless the same command points TELEPORT_HOME at a path other than
 *      the shared home ('TELEPORT_HOME=/data/tmp/x tsh login',
 *      'export TELEPORT_HOME=...; tsh login'). The owner logs in himself:
 *      ask him for a tap.
 *   2. no-shared-tsh-logout         — same condition, same message family.
 *   3. no-shared-tsh-profile-write  — write/edit tools on a path under the
 *      shared home, and bash writers whose DESTINATION is under it
 *      (cp/mv destination, rm/tee operands, 'sed -i' files, or any of
 *      those with an effective cwd inside the home). Reads stay allowed:
 *      'cat ~/.tsh/current-profile', 'ls ~/.tsh', and
 *      'cp -a ~/.tsh /data/tmp/x' (source under the home, destination
 *      outside) are all fine.
 *   4. tsh-needs-proxy              — 'tsh ssh|scp|ls|status|proxy|db|kube'
 *      must carry --proxy= or a TELEPORT_PROXY= assignment while it runs
 *      against the shared home. An isolated TELEPORT_HOME (a single
 *      profile, e.g. the per-run copies in /data/tmp) needs no pin.
 *
 * How the environment is read — via the walker/envTracker, never by
 * re-parsing the shell: 'export TELEPORT_HOME=...' lands in
 * ctx.walkerState.env; a same-command prefix ('TELEPORT_HOME=... tsh ...')
 * lands in ctx.input.envAssignments (bash expands prefix words against the
 * PRE-command env, so the prefix is read from there). The prefix wins over
 * an exported value, exactly as bash applies it to the child.
 *
 * Wrappers: the walker expands sudo / env / bash -c / nice / nohup /
 * strace (and xargs/find) into their inner refs, so those forms are gated
 * by the inner 'tsh' ref. 'timeout' is NOT a walker wrapper — the rules
 * also route the 'timeout' basename and the predicates locate the wrapped
 * 'tsh <subcommand>' inside its argv.
 *
 * Known gaps (pinned in the test file):
 *   - an output redirect ('echo x > ~/.tsh/current-profile') — pi-steering
 *     does not expose redirect targets to predicates (input.command is the
 *     flattened ref text; args + envAssignments only). Same gap the
 *     dev-shm guard pins. 'tee' is covered.
 *   - a write reached through an unexpanded wrapper ('timeout 30 cp x
 *     ~/.tsh/y'), a script that writes internally, or an alias/variable
 *     command — steering sees only the agent's own commands.
 *   - a relative destination under an unresolvable cwd ('cd "$D" && cp x
 *     .tsh') cannot be placed; 'cd ~/.tsh && ...' and absolute/~/... forms
 *     are placed.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateShape,
} from "@cad0p/pi-steering";
import { homedir } from "node:os";
import { join } from "node:path";

declare global {
	interface PiSteeringPredicates {
		/**
		 * when.usesSharedTshHome — the command will run against the
		 * shared Teleport client home: TELEPORT_HOME is unset, resolves to
		 * ~/.tsh, or cannot be resolved statically (fail-closed).
		 * Boolean leaf.
		 */
		usesSharedTshHome: PredicateShape<boolean>;
		/**
		 * when.tshSubcommandIs — the ref runs 'tsh <subcommand>'
		 * (directly, or as the command wrapped by 'timeout'). Bare string
		 * form: tshSubcommandIs: "login".
		 */
		tshSubcommandIs: PredicateShape<string>;
		/**
		 * when.tshReadCommand — the ref runs one of the profile-reading
		 * Teleport subcommands (ssh/scp/ls/status/proxy/db/kube).
		 * Boolean leaf.
		 */
		tshReadCommand: PredicateShape<boolean>;
		/**
		 * when.noTshProxyPin — the command carries neither --proxy
		 * nor a TELEPORT_PROXY assignment. Boolean leaf.
		 */
		noTshProxyPin: PredicateShape<boolean>;
		/**
		 * when.writesSharedTsh — this bash ref WRITES into the shared
		 * Teleport client home (destination semantics per binary; reads
		 * from the home never match). Boolean leaf.
		 */
		writesSharedTsh: PredicateShape<boolean>;
	}
}

/** The shared Teleport client home: ~/.tsh on this host. */
export const SHARED_TSH = join(homedir(), ".tsh");

/**
 * write/edit path surface: the absolute home path, ~ and $HOME all denote
 * the same home (the write tool receives the path verbatim). The home path
 * itself carries no regex metacharacters on a normal host, so it is
 * interpolated raw.
 */
export const SHARED_TSH_PATH = new RegExp(
	"^(?:" + homedir() + "|~|\\$HOME)/\\.tsh(?:/|$)",
);

/**
 * Binaries whose bash form can WRITE a file. rm is declared by the rm
 * plugin; cp/mv/tee/sed by index.ts's agent-config guard — this plugin
 * declares none of them (re-declaring only produces descriptor-collision
 * warnings).
 */
const WRITER_BASENAMES = new Set(["cp", "mv", "rm", "tee", "sed"]);

/** Teleport subcommands that read the current profile's identity. */
const READ_SUBCOMMANDS = new Set([
	"ssh",
	"scp",
	"ls",
	"status",
	"proxy",
	"db",
	"kube",
]);

/**
 * Normalize one path token: strip surrounding quotes, expand a leading
 * ~ or $HOME, drop trailing slashes. Returns null when the token still
 * carries an unresolved variable or command substitution (fail-closed
 * callers decide what unknown means).
 */
function normalizePath(raw: string): string | null {
	let p = raw.trim().replace(/^["']+|["']+$/g, "");
	if (p === "") return null;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	else if (p.startsWith("$HOME/")) p = homedir() + p.slice(p.indexOf("/"));
	if (p.includes("$")) return null;
	if (p.length > 1) p = p.replace(/\/+$/, "");
	return p;
}

/** Is this token at or under the shared Teleport client home? */
function isSharedTshPath(raw: string): boolean {
	const p = normalizePath(raw);
	if (p === null) return false;
	return p === SHARED_TSH || p.startsWith(SHARED_TSH + "/");
}

/**
 * Place one operand: absolute stays as-is, relative is joined to the
 * ref's effective cwd. null when either side is unresolvable
 * (unknown cwd, $VAR operand).
 */
function resolveOperand(raw: string, cwd: string | undefined): string | null {
	const p = normalizePath(raw);
	if (p === null) return null;
	if (p.startsWith("/")) return p;
	if (typeof cwd !== "string" || cwd === "" || cwd === "unknown")
		return null;
	const base = normalizePath(cwd);
	if (base === null || !base.startsWith("/")) return null;
	return normalizePath(join(base, p));
}

/** Read a NAME=value shell prefix assignment (last one wins, like bash). */
function prefixValue(
	ctx: {
		input?: {
			envAssignments?: ReadonlyArray<{ value?: string; text?: string }>;
		};
	},
	name: string,
): string | undefined {
	let found: string | undefined;
	for (const w of ctx.input?.envAssignments ?? []) {
		const tok = w?.value ?? w?.text ?? "";
		const eq = tok.indexOf("=");
		if (eq > 0 && tok.slice(0, eq) === name)
			found = tok.slice(eq + 1).replace(/^["']+|["']+$/g, "");
	}
	return found;
}

/** Effective cwd for this ref, or undefined when the walker could not place it. */
function effectiveCwd(ctx: { walkerState?: { cwd?: unknown } }): string | undefined {
	const cwd = ctx.walkerState?.cwd;
	return typeof cwd === "string" && cwd !== "unknown" ? cwd : undefined;
}

/**
 * when.usesSharedTshHome — true when the ref runs against the shared home
 * (unset / ~/.tsh / unresolvable TELEPORT_HOME, fail-closed).
 */
export const usesSharedTshHome = definePredicate<BooleanLeafArgs>((args, ctx) => {
	const expected = unwrapBooleanLeafArg(args);
	if (expected === undefined) return false;
	const raw =
		prefixValue(ctx, "TELEPORT_HOME") ??
		ctx.walkerState?.env?.get?.("TELEPORT_HOME");
	let shared: boolean;
	if (raw === undefined || raw.trim() === "") {
		shared = true; // unset — the shared home
	} else {
		const placed = resolveOperand(raw, effectiveCwd(ctx));
		// Unresolvable (unknown $VAR, unknown cwd for a relative value)
		// counts as shared, per the owner's fail-closed policy.
		shared = placed === null || isSharedTshPath(placed);
	}
	return shared === expected;
});

/**
 * The 'tsh <subcommand>' run of this ref. Direct tsh refs take their first
 * non-flag positional; timeout refs (not a walker wrapper) carry the
 * wrapped argv, so the token after 'tsh' is the subcommand.
 */
function tshSubcommand(ctx: {
	input?: { tool?: string; basename?: string };
	command: { positionals: () => string[] };
}): string | undefined {
	if (ctx.input?.tool !== "bash") return undefined;
	const basename = ctx.input?.basename;
	const pos = ctx.command.positionals();
	const firstNonFlag = (from: number): string | undefined =>
		pos.slice(from).find((p) => !p.startsWith("-"));
	if (basename === "tsh") return firstNonFlag(0);
	if (basename === "timeout") {
		const i = pos.indexOf("tsh");
		return i < 0 ? undefined : firstNonFlag(i + 1);
	}
	return undefined;
}

/** Unwrap the bare-string / { pattern } forms of tshSubcommandIs. */
function subcommandArg(args: unknown): string | undefined {
	if (typeof args === "string") return args;
	if (args !== null && typeof args === "object") {
		const p = (args as { pattern?: unknown }).pattern;
		if (typeof p === "string") return p;
	}
	return undefined;
}

/** when.tshSubcommandIs — exact subcommand equality ("push" != "pushback"). */
export const tshSubcommandIs = definePredicate<unknown>((args, ctx) => {
	const want = subcommandArg(args);
	if (want === undefined) return false;
	return tshSubcommand(ctx) === want;
});

/** when.tshReadCommand — one of the profile-reading subcommands. */
export const tshReadCommand = definePredicate<BooleanLeafArgs>((args, ctx) => {
	const expected = unwrapBooleanLeafArg(args);
	if (expected === undefined) return false;
	const sub = tshSubcommand(ctx);
	return (sub !== undefined && READ_SUBCOMMANDS.has(sub)) === expected;
});

/**
 * when.noTshProxyPin — neither --proxy (attached or separate, on the tsh
 * ref or inside a timeout-wrapped argv) nor a TELEPORT_PROXY assignment
 * (prefix or in-chain export) is present.
 */
export const noTshProxyPin = definePredicate<BooleanLeafArgs>((args, ctx) => {
	const expected = unwrapBooleanLeafArg(args);
	if (expected === undefined) return false;
	const proxyFlag = { aliases: ["--proxy"] as const, takesValue: true };
	let pinned = false;
	try {
		pinned = ctx.command.hasFlag(proxyFlag);
	} catch {
		pinned = false; // no descriptor bound — fall through to the word scan
	}
	if (!pinned) {
		for (const w of ctx.input?.args ?? []) {
			const tok = w?.value ?? w?.text ?? "";
			if (tok === "--proxy" || tok.startsWith("--proxy=")) {
				pinned = true;
				break;
			}
		}
	}
	if (!pinned) {
		const fromPrefix = prefixValue(ctx, "TELEPORT_PROXY");
		const fromEnv = ctx.walkerState?.env?.get?.("TELEPORT_PROXY");
		pinned =
			(fromPrefix !== undefined && fromPrefix.trim() !== "") ||
			(typeof fromEnv === "string" && fromEnv.trim() !== "");
	}
	return !pinned === expected;
});

/**
 * Destination candidates of a cp/mv: -t/--target-directory values plus the
 * last plain operand (the ordinary destination slot).
 */
function destinations(ops: readonly string[]): string[] {
	const out: string[] = [];
	const plain: string[] = [];
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (op === undefined) continue;
		if (op === "--") {
			plain.push(...ops.slice(i + 1));
			break;
		}
		if (op === "-t" || op === "--target-directory") {
			const v = ops[i + 1];
			if (v !== undefined) {
				out.push(v);
				i++;
			}
			continue;
		}
		if (op.startsWith("--target-directory=")) {
			out.push(op.slice("--target-directory=".length));
			continue;
		}
		if (op.startsWith("-")) continue;
		plain.push(op);
	}
	const last = plain[plain.length - 1];
	if (last !== undefined) out.push(last);
	return out;
}

/** sed is a writer only in place (-i, -i.bak, --in-place). */
function isInPlace(ops: readonly string[]): boolean {
	return ops.some(
		(op) =>
			op === "-i" ||
			op.startsWith("-i.") ||
			op === "--in-place" ||
			op.startsWith("--in-place="),
	);
}

/**
 * when.writesSharedTsh — the ref writes INTO the shared home:
 *   - any writer run with an effective cwd inside the home;
 *   - cp with a destination inside it;
 *   - mv/rm/tee with ANY operand inside it (mv/rm also REMOVE from it —
 *     'mv ~/.tsh/keys/k /data/tmp/x' deletes the key from the home);
 *   - cp with any operand inside it;
 *   - sed with -i and a file operand inside it.
 * Reads from the home (source side of cp, cat, ls, non-in-place sed) never
 * match.
 */
export const writesSharedTsh = definePredicate<BooleanLeafArgs>((args, ctx) => {
	const expected = unwrapBooleanLeafArg(args);
	if (expected === undefined) return false;
	if (ctx.input?.tool !== "bash") return false;
	const basename = ctx.input?.basename;
	if (basename === undefined || !WRITER_BASENAMES.has(basename)) return false;
	const cwd = effectiveCwd(ctx);
	// Any write performed from inside the home targets the home.
	if (cwd !== undefined && isSharedTshPath(cwd)) return true === expected;
	const ops = ctx.command.positionals();
	const hit = (() => {
		switch (basename) {
			case "cp":
				return destinations(ops).some((d) => {
					const p = resolveOperand(d, cwd);
					return p !== null && isSharedTshPath(p);
				});
			case "mv":
			case "rm":
			case "tee":
				return ops.some((op) => {
					if (op.startsWith("-")) return false;
					const p = resolveOperand(op, cwd);
					return p !== null && isSharedTshPath(p);
				});
			case "sed":
				return (
					isInPlace(ops) &&
					ops.some((op) => {
						if (op.startsWith("-")) return false;
						const p = resolveOperand(op, cwd);
						return p !== null && isSharedTshPath(p);
					})
				);
			default:
				return false;
		}
	})();
	return hit === expected;
});

/** The owner's message, verbatim (brief tsh-guard-impl, rule 1). */
const LOGIN_REASON =
	"tsh login changes the shared Teleport client state (~/.tsh: current-profile, per-proxy yaml user: field, keys) that every session on this laptop uses. The owner does the logins himself — ask him (one question) for a tap. To work against an isolated home instead, set TELEPORT_HOME to a path other than ~/.tsh (e.g. TELEPORT_HOME=/data/tmp/tshhome-x/.tsh tsh login).";

const LOGOUT_REASON =
	"tsh logout changes the shared Teleport client state (~/.tsh: current-profile, per-proxy yaml user: field, keys) that every session on this laptop uses — another session's pinned command loses its identity. The owner handles logouts himself — ask him (one question) for a tap. To work against an isolated home instead, set TELEPORT_HOME to a path other than ~/.tsh.";

const PROFILE_WRITE_REASON =
	"Do not write into the shared Teleport client state (~/.tsh: current-profile, per-proxy yaml user: field, keys) — every session on this laptop shares it, and another session's login/logout changes what it means. Reads are fine (cat, ls, cp -a ~/.tsh /data/tmp/x). The owner manages ~/.tsh himself; ask him (one question) for a change. For an isolated run, copy ~/.tsh into a TELEPORT_HOME under $TMPDIR and write there.";

const PROXY_REASON =
	"tsh ssh/scp/ls/status/proxy/db/kube against the shared Teleport home (~/.tsh) needs an explicit --proxy= so the command cannot drift onto whatever profile another session left behind. Pin it: tsh --proxy=teleport-admin.piercloud.net:443 <subcommand> ... (or TELEPORT_PROXY=... tsh ...). An isolated TELEPORT_HOME with a single profile needs no pin.";

export const tshGuardRules = [
	{
		name: "no-shared-tsh-login",
		tool: "bash" as const,
		command: ["tsh", "timeout"] as const,
		when: { tshSubcommandIs: "login", usesSharedTshHome: true },
		reason: LOGIN_REASON,
	},
	{
		name: "no-shared-tsh-logout",
		tool: "bash" as const,
		command: ["tsh", "timeout"] as const,
		when: { tshSubcommandIs: "logout", usesSharedTshHome: true },
		reason: LOGOUT_REASON,
	},
	{
		name: "no-shared-tsh-profile-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: SHARED_TSH_PATH,
		reason: PROFILE_WRITE_REASON,
	},
	{
		name: "no-shared-tsh-profile-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: SHARED_TSH_PATH,
		reason: PROFILE_WRITE_REASON,
	},
	{
		name: "no-shared-tsh-bash-write",
		tool: "bash" as const,
		command: ["cp", "mv", "rm", "tee", "sed"] as const,
		when: { writesSharedTsh: true },
		reason: PROFILE_WRITE_REASON,
	},
	{
		name: "tsh-needs-proxy",
		tool: "bash" as const,
		command: ["tsh", "timeout"] as const,
		when: {
			tshReadCommand: true,
			noTshProxyPin: true,
			usesSharedTshHome: true,
		},
		reason: PROXY_REASON,
	},
];

export const tshGuardPlugin = {
	name: "tsh-guard",
	cliDescriptors: {
		// Teleport client. The value-taking flags are declared so
		// positionals()/subcommand extraction skips their values
		// ('tsh --proxy host login' still reads 'login').
		tsh: {
			flags: {
				proxy: { aliases: ["--proxy"], takesValue: true },
				user: { aliases: ["--user"], takesValue: true },
				ttl: { aliases: ["--ttl"], takesValue: true },
				identity: { aliases: ["--identity"], takesValue: true },
				auth: { aliases: ["--auth"], takesValue: true },
				format: { aliases: ["--format"], takesValue: true },
				out: { aliases: ["--out"], takesValue: true },
				"keys-dir": { aliases: ["--keys-dir"], takesValue: true },
			},
		},
		// Not a walker wrapper — the rules route it so a wrapped
		// 'tsh login' / 'tsh ssh' cannot slip through. Declared so the
		// facade binds (undeclared basenames throw) and 'timeout 30 tsh ...'
		// keeps the tsh argv placeable.
		timeout: {
			flags: {
				signal: { aliases: ["-s", "--signal"], takesValue: true },
				"kill-after": { aliases: ["-k", "--kill-after"], takesValue: true },
			},
		},
	},
	predicates: {
		usesSharedTshHome,
		tshSubcommandIs,
		tshReadCommand,
		noTshProxyPin,
		writesSharedTsh,
	},
} as const satisfies Plugin;
