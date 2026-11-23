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
 *   4. tsh-discovery-all-clusters   — a bare 'tsh ls' (no --all / -R)
 *      against the shared home is refused, with or without a pin: it
 *      lists ONE cluster and that narrow view reads as authoritative —
 *      exactly how the 2026-11-22 incident happened (H4 listed
 *      teleport-admin only, saw pc-host-01, and concluded pc-control was
 *      unreachable; pc-control is a node in the SECOND cluster,
 *      teleport-control.piercloud.net:443). The message teaches the native
 *      all-clusters form ('tsh ls --all', alias -R) and names the machines
 *      in both clusters. 'tsh ls --all' / 'tsh ls -R' pass, pinned or not
 *      (they are not tied to one profile), and 'tsh status' is never
 *      refused: it is read-only and already prints every profile in the
 *      home (owner ruling 2026-11-23: no wrapper, use what tsh has).
 *      An isolated TELEPORT_HOME keeps the old semantics (naming is fine:
 *      that home holds one profile by construction).
 *   5. tsh-node-wrong-cluster       — 'tsh ssh|scp' naming a node that the
 *      known node->cluster map places in a different cluster than the
 *      pinned proxy is refused with the right proxy. Static map (see
 *      NODE_CLUSTERS): the client home does not carry node->cluster, and
 *      'tsh ls' hides nodes the user is denied (pc-admin,
 *      pc-control-mail). Unknown node names and unknown proxy pins fall
 *      through — this rule only refuses a pair it can name.
 *   6. tsh-needs-proxy              — 'tsh ssh|scp|proxy|db|kube'
 *      must carry --proxy= or a TELEPORT_PROXY= assignment while it runs
 *      against the shared home. An isolated TELEPORT_HOME (a single
 *      profile, e.g. the per-run copies in /data/tmp) needs no pin.
 *      (ls/status left this set: a bare ls is refused by rule 4, a bare
 *      status is read-only and shows every profile, and 'ls --all' spans
 *      profiles, so a pin is moot for all three.)
 *
 * Cross-cluster discovery is native: 'tsh ls --all' lists the nodes of
 * every cluster in the home, 'tsh status' the profiles. No wrapper.
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
		 * Teleport subcommands (ssh/scp/proxy/db/kube).
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
		/**
		 * when.tshSingleClusterListing — the ref runs 'tsh ls' WITHOUT
		 * --all / -R, i.e. it lists the nodes of one cluster only.
		 * Boolean leaf.
		 */
		tshSingleClusterListing: PredicateShape<boolean>;
		/**
		 * when.tshNodeWrongCluster — the ref runs 'tsh ssh|scp' against a
		 * KNOWN cluster proxy and names a node the static map places in
		 * the OTHER cluster. Boolean leaf.
		 */
		tshNodeWrongCluster: PredicateShape<boolean>;
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

/**
 * Teleport subcommands that act through the CURRENT profile's identity (so
 * they need a pin while the home is shared). 'ls' and 'status' are absent:
 * a bare ls is refused by tsh-discovery-all-clusters, 'ls --all' spans every
 * profile, and 'status' only reads them.
 */
const READ_SUBCOMMANDS = new Set(["ssh", "scp", "proxy", "db", "kube"]);

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
 * This ref's tsh argv, split at the subcommand. Direct tsh refs take their
 * first non-flag positional; timeout refs (not a walker wrapper) carry the
 * wrapped argv, so the token after 'tsh' is the subcommand.
 */
function tshArgv(ctx: {
	input?: { tool?: string; basename?: string };
	command: { positionals: () => string[] };
}): { sub?: string | undefined; rest: string[] } {
	if (ctx.input?.tool !== "bash") return { rest: [] };
	const basename = ctx.input?.basename;
	const pos = ctx.command.positionals();
	let start: number;
	if (basename === "tsh") start = 0;
	else if (basename === "timeout") {
		const i = pos.indexOf("tsh");
		if (i < 0) return { rest: [] };
		start = i + 1;
	} else return { rest: [] };
	const idx = pos.findIndex((p, j) => j >= start && !p.startsWith("-"));
	if (idx < 0) return { rest: [] };
	return { sub: pos[idx], rest: pos.slice(idx + 1) };
}

/** The 'tsh <subcommand>' run of this ref (undefined for other binaries). */
function tshSubcommand(ctx: {
	input?: { tool?: string; basename?: string };
	command: { positionals: () => string[] };
}): string | undefined {
	return tshArgv(ctx).sub;
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

// ---------------------------------------------------------------------
// Cross-cluster discovery (incident 2026-11-22)
// ---------------------------------------------------------------------

/**
 * The two Teleport clusters this laptop's client is logged into, by host
 * (the port is always 443; profiles spell it 'host:443'). The cluster list
 * is NOT hard-coded as a source of truth for discovery — 'tsh status' and
 * 'tsh ls --all' read it off the client home. These two names only let the
 * node map below be compared against a --proxy pin.
 */
const ADMIN_PROXY_HOST = "teleport-admin.piercloud.net";
const CONTROL_PROXY_HOST = "teleport-control.piercloud.net";

/**
 * node -> cluster (plus the node's plane label).
 *
 * SOURCE: the 2026-11-22 cluster facts in the H4 board (~L1989-1993):
 *   teleport-admin.piercloud.net: pc-host-01 (plane host), pc-admin (plane
 *     admin; pier is denied by design, seat pc-admin-super + MFA tap)
 *   teleport-control.piercloud.net:443: pc-control (plane control, role
 *     pc-control-near-root -> login deploy), pc-control-mail (plane mail).
 *
 * The map is STATIC and INCOMPLETE by construction, and cannot be derived
 * from the client state: '~/.tsh/<proxy>.yaml' names only the proxy + user,
 * and 'tsh ls --all' hides the nodes the user is denied on (on 2026-11-22
 * 'tsh ls --proxy=teleport-admin' listed pc-host-01 only, and
 * pc-control-mail was invisible in its own cluster; a 'tsh ssh' to a node
 * you are denied also fails as 'not found').
 * So the node rule below fires ONLY for a name listed here: an unlisted
 * node name, or a pin to an unknown proxy, falls through to the pinned
 * command (fail-open on the unknown).
 */
const NODE_CLUSTERS: Readonly<
	Record<string, { cluster: string; plane: string }>
> = {
	"pc-host-01": { cluster: ADMIN_PROXY_HOST, plane: "host" },
	"pc-admin": { cluster: ADMIN_PROXY_HOST, plane: "admin" },
	"pc-control": { cluster: CONTROL_PROXY_HOST, plane: "control" },
	"pc-control-mail": { cluster: CONTROL_PROXY_HOST, plane: "mail" },
};

/**
 * The flags that widen 'tsh ls' to every cluster in the client home:
 * --all, and its -R alias ("List nodes from all clusters and proxies").
 */
function listsEveryCluster(ctx: {
	input?: { args?: ReadonlyArray<{ value?: string; text?: string }> };
}): boolean {
	for (const w of ctx.input?.args ?? []) {
		const tok = (w?.value ?? w?.text ?? "").trim();
		if (tok === "--all" || tok.startsWith("--all=") || tok === "-R")
			return true;
	}
	return false;
}

/** Bare host of a proxy value ('https://host:443/' -> 'host'). */
function proxyHost(raw: string | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const stripped = raw.trim().replace(/^https?:\/\//, "");
	const host = stripped.split(":")[0];
	return host === undefined || host === "" ? undefined : host.toLowerCase();
}

/**
 * The proxy this ref pins: --proxy=<v> / --proxy <v> (on the tsh ref or
 * inside a timeout-wrapped argv), else a TELEPORT_PROXY prefix assignment,
 * else an exported TELEPORT_PROXY.
 */
function pinnedProxy(ctx: {
	input?: {
		args?: ReadonlyArray<{ value?: string; text?: string }>;
		envAssignments?: ReadonlyArray<{ value?: string; text?: string }>;
	};
	walkerState?: { env?: { get?: (key: string) => string | undefined } };
}): string | undefined {
	const args = ctx.input?.args ?? [];
	for (let i = 0; i < args.length; i++) {
		const tok = args[i]?.value ?? args[i]?.text ?? "";
		if (tok.startsWith("--proxy=")) return tok.slice("--proxy=".length);
		if (tok === "--proxy") {
			const next = args[i + 1]?.value ?? args[i + 1]?.text;
			if (typeof next === "string" && next !== "") return next;
		}
	}
	const fromPrefix = prefixValue(ctx, "TELEPORT_PROXY");
	if (fromPrefix !== undefined && fromPrefix.trim() !== "") return fromPrefix;
	const fromEnv = ctx.walkerState?.env?.get?.("TELEPORT_PROXY");
	return typeof fromEnv === "string" && fromEnv.trim() !== ""
		? fromEnv
		: undefined;
}

/**
 * Node names this ssh/scp call targets: ssh -> its first operand (the
 * target; the rest is the remote command), scp -> every operand that carries
 * a 'host:' side. 'user@' prefixes and a trailing dot are dropped.
 */
function nodeCandidates(
	sub: string,
	rest: readonly string[],
): string[] {
	const name = (tok: string): string | undefined => {
		let t = tok.trim();
		if (t === "") return undefined;
		if (sub === "scp") {
			const colon = t.indexOf(":");
			if (colon <= 0) return undefined; // a local path
			t = t.slice(0, colon);
		}
		const at = t.lastIndexOf("@");
		if (at >= 0) t = t.slice(at + 1);
		t = t.replace(/\.$/, "").toLowerCase();
		return t === "" ? undefined : t;
	};
	const toks = sub === "ssh" ? rest.slice(0, 1) : rest;
	return toks.map(name).filter((v): v is string => v !== undefined);
}

/**
 * The (node, cluster, plane) triple when this ssh/scp call names a node the
 * map places in a DIFFERENT cluster than the pinned proxy; undefined when
 * the call is fine, unpinned, or beyond what the map can judge.
 */
function wrongClusterNode(ctx: {
	input?: {
		tool?: string;
		basename?: string;
		args?: ReadonlyArray<{ value?: string; text?: string }>;
	};
	command: { positionals: () => string[] };
	walkerState?: { env?: { get?: (key: string) => string | undefined } };
}): { node: string; cluster: string; plane: string } | undefined {
	const { sub, rest } = tshArgv(ctx);
	if (sub !== "ssh" && sub !== "scp") return undefined;
	const pin = proxyHost(pinnedProxy(ctx));
	// Only the two clusters the map covers; an unknown pin (a leaf cluster,
	// a future third one) means this map cannot judge the call.
	if (pin !== ADMIN_PROXY_HOST && pin !== CONTROL_PROXY_HOST) return undefined;
	for (const node of nodeCandidates(sub, rest)) {
		const where = NODE_CLUSTERS[node];
		if (where !== undefined && where.cluster !== pin)
			return { node, cluster: where.cluster, plane: where.plane };
	}
	return undefined;
}

/**
 * when.tshSingleClusterListing — 'tsh ls' without --all / -R. That is the
 * one-cluster node view that produced the 2026-11-22 false "no access"
 * conclusion; the native all-clusters form is 'tsh ls --all' (alias -R).
 */
export const tshSingleClusterListing = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		const single = tshSubcommand(ctx) === "ls" && !listsEveryCluster(ctx);
		return single === expected;
	},
);

/**
 * when.tshNodeWrongCluster — 'tsh ssh|scp' pinned to one known cluster while
 * naming a node the map places in the other.
 */
export const tshNodeWrongCluster = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		return (wrongClusterNode(ctx) !== undefined) === expected;
	},
);

/** The owner's message, verbatim (brief tsh-guard-impl, rule 1). */
const LOGIN_REASON =
	"tsh login changes the shared Teleport client state (~/.tsh: current-profile, per-proxy yaml user: field, keys) that every session on this laptop uses. The owner does the logins himself — ask him (one question) for a tap. To work against an isolated home instead, set TELEPORT_HOME to a path other than ~/.tsh (e.g. TELEPORT_HOME=/data/tmp/tshhome-x/.tsh tsh login).";

const LOGOUT_REASON =
	"tsh logout changes the shared Teleport client state (~/.tsh: current-profile, per-proxy yaml user: field, keys) that every session on this laptop uses — another session's pinned command loses its identity. The owner handles logouts himself — ask him (one question) for a tap. To work against an isolated home instead, set TELEPORT_HOME to a path other than ~/.tsh.";

const PROFILE_WRITE_REASON =
	"Do not write into the shared Teleport client state (~/.tsh: current-profile, per-proxy yaml user: field, keys) — every session on this laptop shares it, and another session's login/logout changes what it means. Reads are fine (cat, ls, cp -a ~/.tsh /data/tmp/x). The owner manages ~/.tsh himself; ask him (one question) for a change. For an isolated run, copy ~/.tsh into a TELEPORT_HOME under $TMPDIR and write there.";

const PROXY_REASON =
	"tsh ssh/scp/proxy/db/kube against the shared Teleport home (~/.tsh) needs an explicit --proxy= so the command cannot drift onto whatever profile another session left behind. Pin it: tsh --proxy=teleport-admin.piercloud.net:443 <subcommand> ... (or TELEPORT_PROXY=... tsh ...). An isolated TELEPORT_HOME with a single profile needs no pin.";

const DISCOVERY_REASON =
	"tsh ls lists one cluster's nodes; use tsh ls --all (or -R) to list every cluster you are logged into. Machines: admin cluster = pc-host-01, pc-admin; control cluster = pc-control, pc-control-mail.";

/** Fallback text; the rule's reason function names the node when it can. */
const NODE_WRONG_CLUSTER_REASON =
	"Teleport nodes live in ONE cluster, and --proxy selects the cluster. pc-host-01 and pc-admin are in teleport-admin.piercloud.net; pc-control and pc-control-mail are in teleport-control.piercloud.net:443. Pin the proxy of the cluster that holds the node you are targeting (tsh --proxy=teleport-control.piercloud.net:443 ssh --user=pier deploy@pc-control), and before concluding a machine is unreachable list every cluster with tsh ls --all.";

const nodeWrongClusterReason = (ctx: Parameters<typeof wrongClusterNode>[0]) => {
	const hit = wrongClusterNode(ctx);
	if (hit === undefined) return NODE_WRONG_CLUSTER_REASON;
	return `'${hit.node}' is a node in ${hit.cluster}:443 (plane ${hit.plane}), not in the cluster you pinned — a wrong-cluster lookup fails as 'not found' and reads like an unreachable machine (incident 2026-11-22: 'tsh ls --proxy=teleport-admin.piercloud.net' listed pc-host-01 only, and the missing pc-control was taken as 'no access'). Re-pin: tsh --proxy=${hit.cluster}:443 ssh --user=pier deploy@${hit.node} ... (or the matching scp form), and drop the wrong --proxy / TELEPORT_PROXY value. List every cluster first: tsh ls --all.`;
};

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
		// A bare 'tsh ls' is never authoritative (2026-11-22): it shows one
		// cluster, and a --proxy pin only makes that narrow view look
		// right. The native all-clusters form is 'tsh ls --all' / -R.
		name: "tsh-discovery-all-clusters",
		tool: "bash" as const,
		command: ["tsh", "timeout"] as const,
		when: {
			tshSingleClusterListing: true,
			usesSharedTshHome: true,
		},
		reason: DISCOVERY_REASON,
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
	{
		// Static node->cluster map (see NODE_CLUSTERS); only a pair it can
		// name is refused, an unknown node or proxy pin falls through.
		name: "tsh-node-wrong-cluster",
		tool: "bash" as const,
		command: ["tsh", "timeout"] as const,
		when: {
			tshNodeWrongCluster: true,
			usesSharedTshHome: true,
		},
		reason: nodeWrongClusterReason,
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
				// 'tsh ls --all' / -R lists every cluster in the home.
				all: { aliases: ["--all"], takesValue: false },
				recursive: { aliases: ["-R"], takesValue: false },
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
		tshSingleClusterListing,
		tshNodeWrongCluster,
	},
} as const satisfies Plugin;
