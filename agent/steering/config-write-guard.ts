// SPDX-License-Identifier: MIT
/**
 * Config-write guard — agents do not write the configuration that
 * decides which rails a session loads.
 *
 * WHY (2026-11-03). Red-team F1 on the per-repo steering design: a
 * project layer's `disabledRules` is UNIONED with the global layer's, so
 * a repo whose `.pi/steering/index.ts` said
 * `{ disabledRules: ["agents-do-not-merge-directly"] }` deleted the
 * global merge guard with no collision, no prompt and no diagnostic.
 * Nothing stopped an agent from writing that file (the inline
 * agent-config guard covers only `~/.pi/agent/agents/**` and
 * `~/.pi/agent/settings.json`), and README "Security" says the project
 * layer is "arbitrary TypeScript executed at the first `session_start`".
 * The lens round-1 review added two more reachable targets: the GLOBAL
 * layer itself (one call, no trickery — it is the file that declares the
 * lock) and the installed framework source the lock is implemented in.
 *
 * WHAT THIS COVERS (the test matrix pins every row):
 *   - any repo's project layer: `<repo>/.pi/steering/**`,
 *     `<repo>/.pi/steering.ts`, `<repo>/.pi/settings.json`;
 *   - the global layer: `<agentDir>/steering/**` under `.pi/agent`
 *     (default `~/.pi/agent/steering/`) and its `settings.json`;
 *   - the installed framework: the `@cad0p/pi-steering` package under
 *     any `node_modules` (its `src` and `dist` — the lock's own
 *     implementation, and rewriting the loader defeats every lock by
 *     definition).
 * Paths are NORMALISED before matching: `resolve` collapses repeated
 * separators and `.`/`..` segments, and the longest EXISTING prefix is
 * realpath'd, so `.pi//steering`, `.pi/./steering`, a symlinked `.pi`
 * directory and a symlinked repo root all land on the same canonical
 * path. Shell text is tokenised and canonicalised the same way, and the
 * token boundary is any shell delimiter (`>`, `|`, `;`, quotes, `=`,
 * brackets, whitespace), so `echo x >.pi/steering/index.ts` and
 * `tee .pi//steering/index.ts` are seen.
 *
 * WHAT IT DOES NOT COVER (stated as part of the claim; the test file
 * pins each known gap):
 *   - a path built at runtime and split across a quote boundary or a
 *     variable (`f=".pi/steer""ing/index.ts"`), `eval`, an encoded
 *     path, or a script written elsewhere and then executed;
 *   - `git` operations that write these files from a tree/commit
 *     (`git checkout`, `git reset --hard`, `git apply`) when the
 *     command text carries no path;
 *   - a relocated `PI_CODING_AGENT_DIR` (the global-layer match is
 *     path-shaped, not resolved from the environment);
 *   - the pi package declaration in `<agentDir>/settings.json` and any
 *     other `~/.pi/agent/**` file outside the two patterns above;
 *   - the OWNER: this binds agent tool calls only, and any non-pi
 *     harness.
 * It is the anti-plant half. The load-time half (`lockedRules` in the
 * global layer, refusing a project-layer disarm of a locked rule) is
 * what closes the hole; this rule must never be the only defense.
 *
 * Maintenance flow this deliberately ALLOWS: a pi-config worktree
 * (`<worktree>/agent/steering/**`, no `.pi/` segment) stays writable,
 * so config work is authored in a branch/worktree and only the live,
 * session-loading paths are off-limits to agents.
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
			// The walker resolves `cd .pi && cd steering` to the effective
			// cwd, so a bare `index.ts` token still lands on the protected
			// path. An unresolvable cwd falls back to the session cwd.
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
