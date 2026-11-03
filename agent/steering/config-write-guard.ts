// SPDX-License-Identifier: MIT
/**
 * Config-write guard — a TRIPWIRE, not a boundary.
 *
 * WHAT IT IS FOR. It catches an agent that, honestly mistaken, sets out
 * to write the configuration that decides which rails a session loads
 * (a repo's `.pi/steering`, the global layer, the framework source)
 * with the ordinary tools and the ordinary spellings, and tells it to
 * go through the owner instead. It is NOT a security boundary: an agent
 * running as the owner's uid can always rewrite its own configuration,
 * and three lens rounds found writers and path shapes this text match
 * does not see (round 1 R-F3; round 2 red-team F1-F4). The load-time
 * lock (`lockedRules` in this layer) refuses a project layer's DISARM
 * of a locked rail whatever wrote it; neither half keeps a determined
 * agent from changing the global layer itself. Where the boundary could
 * live (OS ownership, an integrity pin, or accepting the residual) is an
 * owner question in the design note, Goldmine
 * personal/github/pi-config/plans/2026-11-03-lock-global-rails.md.
 *
 * WHY (2026-11-03). Red-team F1 on the per-repo steering design: a
 * project layer's `disabledRules` was UNIONED with the global layer's,
 * so a repo whose `.pi/steering/index.ts` disabled
 * `agents-do-not-merge-directly` deleted the global merge guard
 * silently. The lock now refuses that disable at load time; this rule
 * makes the honest version of the plant (an agent "fixing" a rail that
 * annoys it) stop and ask.
 *
 * WHAT IT CATCHES — exactly what the code below matches (the test file
 * pins each row):
 *   write / edit tools: the path, `~/`-expanded, made absolute against
 *   the session cwd, `resolve`d (`//`, `.`, `..` collapse) and with
 *   its longest EXISTING prefix realpath'd (a symlinked `.pi` or repo
 *   root is followed), is protected when it contains
 *     - `.pi/steering` (any file below), `.pi/steering.ts` or
 *       `.pi/settings.json` — any repo's project layer and project
 *       settings, and also `~/.pi/settings.json`;
 *     - `.pi/agent/steering` (any file below) or
 *       `.pi/agent/settings.json` — the global layer at the DEFAULT
 *       agent dir, and pi's own settings (which declare the packages);
 *     - `node_modules/@cad0p/pi-steering` or
 *       `node_modules/@cad0p/pi-steering-<x>` (e.g. pi-steering-github),
 *       in the npm layout or the pnpm store.
 *   bash: the rule fires ONLY when one of the command's refs has a
 *   basename in STEERING_CONFIG_WRITERS (46 names below); for `cat`,
 *   `echo` and `printf` only when the text also has a `>`/`>>`
 *   redirect or a `tee`. Then the full tool_call text
 *   (`ctx.rawCommand`) is split on shell delimiters (whitespace, quotes,
 *   `; | & < > ( ) { } [ ] , =`), and each token that CONTAINS `.pi` or
 *   `pi-steering` is canonicalised as above (relative to the walker's
 *   effective cwd, else the session cwd) and matched against the same
 *   list.
 *
 * WHAT IT DOES NOT CATCH (each row pinned as ALLOWED in the test):
 *   - a write by a program not in the writer list, or by no program at
 *     all: `> file`, `: > file`, `jq … > file`, `yes | head > file`
 *     (a redirect target is not a ref, and the basename filter runs
 *     first) — red-team r2 F1;
 *   - a relative target whose token does not itself contain `.pi`:
 *     `cd ~/.pi/agent && echo x > steering/index.ts` (the `.pi`
 *     substring prefilter skips the token before cwd resolution).
 *     Conversely a `cd .pi/steering` in the same line trips the rule
 *     whatever the write target is (the `cd` argument matches) — a
 *     false positive, not coverage — red-team r2 F2;
 *   - the flat global-layer form `<agentDir>/steering.ts` (the loader
 *     uses it when the directory form is absent), a glob
 *     (`rm -rf ~/.pi/agent/steer*`), and removing or moving a parent
 *     (`rm -rf ~/.pi/agent`, `mv ~/.pi/agent …`) — red-team r2 F3;
 *   - every other package the global layer imports
 *     (`@cad0p/pi-napkin`, pi itself under `~/.pi/agent/install`) —
 *     red-team r2 F4;
 *   - `git` operations that write these files from a tree or a patch
 *     with no protected path in the text (`git -C ~/.pi reset --hard`,
 *     `git -C ~/.pi checkout <rev>`, `git -C ~/.pi apply x.patch`);
 *   - a path built at runtime or split across a quote boundary
 *     (`f=".pi/steer""ing/index.ts"`), `eval`, an encoded path, a
 *     script written elsewhere and then executed;
 *   - a relocated `PI_CODING_AGENT_DIR` (the match is path-shaped);
 *   - any other `~/.pi/agent/**` file (sessions, auth, extensions);
 *   - the OWNER, and any non-pi harness: it binds pi tool calls only.
 * These are not bugs to be fixed one by one: the writer and path space
 * is open, and closing it by enumeration is the claim three rounds
 * disproved. Keep the claim at "tripwire".
 *
 * Maintenance flow this deliberately ALLOWS: a pi-config worktree
 * (`<worktree>/agent/steering/**`, no `.pi/` segment) stays writable,
 * so config work is authored in a branch/worktree and only the live,
 * session-loading paths trip the rule.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { PredicateShape } from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		touchesSteeringConfig: PredicateShape<boolean>;
	}
}

/**
 * Is this CANONICAL absolute path one of the files that decides which
 * rails load? Segment-based, so a name that merely ends in the same
 * words (`notes/.pi/steering-old.md`, `.pi/settings.json.bak`) is not
 * caught.
 */
export function isProtectedConfigPath(canonical: string): boolean {
	const segments = canonical.split("/");
	for (let i = 0; i + 1 < segments.length; i++) {
		if (segments[i] !== ".pi") continue;
		const next = segments[i + 1];
		if (next === "steering" || next === "steering.ts") return true;
		if (next === "settings.json") return true;
		if (next === "agent") {
			const leaf = segments[i + 2];
			if (leaf === "steering" || leaf === "settings.json") return true;
		}
	}
	for (let i = 0; i + 2 < segments.length; i++) {
		if (segments[i] !== "node_modules") continue;
		if (segments[i + 1] !== "@cad0p") continue;
		if (/^pi-steering(?:-[^/]+)?$/.test(segments[i + 2] ?? "")) return true;
	}
	return false;
}

/**
 * Canonicalise a path for the match: absolute (resolved against `base`
 * when relative), then realpath the longest EXISTING prefix so symlinks
 * and `//` / `.` / `..` spellings cannot smuggle a protected path past
 * the check. A path that does not exist yet (the plant) canonicalises
 * its nearest existing parent and re-appends the rest.
 */
export function canonicalConfigPath(path: string, base: string): string {
	const absolute = isAbsolute(path) ? path : resolve(base, path);
	let head = resolve(absolute);
	let tail = "";
	for (;;) {
		if (existsSync(head)) {
			try {
				head = realpathSync(head);
			} catch {
				// keep the lexical form
			}
			break;
		}
		const parent = dirname(head);
		if (parent === head) break;
		tail = tail === "" ? basename(head) : join(basename(head), tail);
		head = parent;
	}
	const joined = tail === "" ? head : join(head, tail);
	return joined.split(sep).join("/");
}

/** True when `path` (relative to `base`) is protected after canonicalisation. */
export function isProtectedConfigWrite(path: string, base: string): boolean {
	if (path === "") return false;
	let candidate = path;
	if (candidate.startsWith("~/")) candidate = join(homedir(), candidate.slice(2));
	return isProtectedConfigPath(canonicalConfigPath(candidate, base));
}

/**
 * Split shell text into path-shaped tokens. The delimiter set is every
 * shell metacharacter that can abut a path, which is what catches
 * `>file` and `--file=path` without a space.
 */
const TOKEN_SPLIT = /[\s"'\`;|&<>(){}\[\],=]+/;

/** Does this shell text mention a protected config path? */
export function mentionsProtectedConfigPath(
	text: string,
	cwd: string,
): boolean {
	for (const token of text.split(TOKEN_SPLIT)) {
		if (token === "") continue;
		if (!token.includes(".pi") && !token.includes("pi-steering")) continue;
		if (isProtectedConfigWrite(token, cwd)) return true;
	}
	return false;
}

/**
 * Binaries that can create or mutate a file: shell interpreters, text
 * writers, redirect producers, copies, patch tools and version control.
 * Routing on the basename is the rule's first filter; the path-shaped
 * `touchesSteeringConfig` predicate decides the verdict.
 */
export const STEERING_CONFIG_WRITERS = [
	"bash",
	"sh",
	"zsh",
	"dash",
	"fish",
	"env",
	"xargs",
	"find",
	"sed",
	"awk",
	"perl",
	"python",
	"python3",
	"node",
	"ruby",
	"php",
	"tee",
	"cp",
	"mv",
	"ln",
	"install",
	"dd",
	"truncate",
	"touch",
	"rm",
	"mkdir",
	"rmdir",
	"chmod",
	"chown",
	"rsync",
	"patch",
	"tar",
	"unzip",
	"curl",
	"wget",
	"echo",
	"printf",
	"cat",
	"npx",
	"npm",
	"pnpm",
	"git",
	"go",
	"make",
	"cargo",
	"docker",
] as const;

/**
 * Basenames whose `cliDescriptors` another plugin in this config
 * already declares (the rm plugin, the inline agent-config guard and
 * dev-shm-guard). Re-declaring one produces a descriptor-collision
 * warning, so the rest are declared here.
 */
const DECLARED_ELSEWHERE = new Set([
	// rm plugin (pi-steering core)
	"rm",
	// inline agent-config-guard (index.ts)
	"sed",
	"cp",
	"tee",
	"mv",
	"chmod",
	"chattr",
	"python",
	"python3",
	"perl",
	"awk",
	"node",
	"bash",
	"sh",
	// dev-shm-guard
	"mkdir",
	"rsync",
	"git",
	"tar",
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
	"env",
]);

export const configWriteGuardPlugin = {
	name: "config-write-guard",
	cliDescriptors: Object.fromEntries(
		STEERING_CONFIG_WRITERS.filter((b) => !DECLARED_ELSEWHERE.has(b)).map(
			(b) => [b, {}],
		),
	),
	predicates: {
		/**
		 * Does this bash command write a protected config path?
		 *
		 * Reads the FULL tool_call text (`ctx.rawCommand`) as well as the
		 * per-ref view: a redirect target is not a ref, so `echo x >
		 * .pi/steering/index.ts` only appears in the raw text. Tokens are
		 * canonicalised before the match (see the header).
		 */
		touchesSteeringConfig: (
			args: unknown,
			ctx: {
				cwd?: string;
				input?: { command?: string; basename?: string };
				rawCommand?: string;
				walkerState?: { cwd?: unknown };
			},
		) => {
			if (args !== true) return false;
			const raw = typeof ctx?.rawCommand === "string" ? ctx.rawCommand : "";
			const view =
				typeof ctx?.input?.command === "string" ? ctx.input.command : "";
			const text = raw === "" ? view : raw;
			if (text === "") return false;
			// Read-only uses of the print/read trio stay allowed: reading a
			// repo's project layer is legitimate review work. Only a redirect
			// (or a downstream tee, which is its own ref and matches on its
			// own) turns them into writers.
			const basename0 = ctx?.input?.basename;
			if (basename0 === "cat" || basename0 === "echo" || basename0 === "printf") {
				if (!/>>?(?![>&])/.test(text) && !/\btee\b/.test(text)) return false;
			}
			// Relative tokens resolve against the walker's effective cwd (an
			// unresolvable cwd falls back to the session cwd). Only tokens
			// that contain `.pi` or `pi-steering` reach this resolution
			// (the prefilter in mentionsProtectedConfigPath), so a bare
			// `index.ts` after `cd ~/.pi/agent/steering` is NOT seen — a
			// declared tripwire gap (header, red-team r2 F2).
			const walkerCwd = ctx?.walkerState?.cwd;
			const cwd =
				typeof walkerCwd === "string" && walkerCwd !== "unknown"
					? walkerCwd
					: typeof ctx?.cwd === "string"
						? ctx.cwd
						: "/";
			return mentionsProtectedConfigPath(text, cwd);
		},
	},
};

const REASON =
	"Do not write pi steering configuration (.pi/steering/**, .pi/steering.ts, .pi/settings.json, the global ~/.pi/agent/steering/**, or the installed @cad0p/pi-steering source). A project layer's disabledRules / disabledPlugins / exemptions silently rewrite the global rails — that is how any repo could switch off agents-do-not-merge-directly (red-team F1, 2026-11-03) — and project steering is arbitrary TypeScript executed at session start. Steering changes go through the owner: author them in a pi-config worktree and ask, do not write the live paths.";

export const configWriteGuardRules = [
	{
		name: "no-steering-config-edit",
		tool: "edit" as const,
		field: "path" as const,
		// Loose on purpose: a symlinked `.pi` hides the segment from a raw
		// pattern pre-filter, and the condition canonicalises the path
		// before deciding. Any non-empty path reaches it.
		pattern: /./,
		when: {
			condition: (ctx: { input: { path?: unknown }; cwd: string }) =>
				typeof ctx.input.path === "string" &&
				isProtectedConfigWrite(ctx.input.path, ctx.cwd),
		},
		reason: REASON,
	},
	{
		name: "no-steering-config-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: /./,
		when: {
			condition: (ctx: { input: { path?: unknown }; cwd: string }) =>
				typeof ctx.input.path === "string" &&
				isProtectedConfigWrite(ctx.input.path, ctx.cwd),
		},
		reason: REASON,
	},
	{
		name: "no-steering-config-bash-mutation",
		tool: "bash" as const,
		command: [...STEERING_CONFIG_WRITERS],
		when: { touchesSteeringConfig: true },
		reason: REASON,
	},
];
