// SPDX-License-Identifier: MIT
/**
 * Global git identity guard — the agent never rewrites who signs commits.
 *
 * Incident 2026-10-30 00:43Z: something run from an agent session set
 * the GLOBAL `user.name` / `user.email` (`~/.config/git/config`) to
 * `t` / `t@t`. Every later commit in a repo without its own identity was
 * signed with the right key but authored as `t@t`, so GitHub could not
 * verify it and the `required_signatures` rulesets rejected the pushes
 * (pi-napkin #115, pi-timestamps #26 on 2026-11-02).
 *
 * Incident 2026-11-06 03:22Z: a scratch `HOME=/data/tmp/scratch-home
 * git config --global …` was allowed because the guard ignored the
 * inherited XDG_CONFIG_HOME. Git then wrote the REAL
 * ~/.config/git/config. The guard now resolves GIT_CONFIG_GLOBAL /
 * XDG_CONFIG_HOME from the command, the walker env and the inherited
 * process env, and treats an empty value as unset (as git does).
 *
 * Blocked (scope: global / system / a `--file` that IS the real global
 * or system config):
 *   - `git config` writes of identity keys — `user|author|committer` .
 *     `name|email|signingkey`, `commit|tag|push.gpgsign`, `gpg.*` —
 *     in both the legacy (`--global k v`, `--unset`, `--add`,
 *     `--replace-all`, `--remove-section user`, `-e`) and the git 2.46+
 *     subcommand forms (`config set|unset|edit|remove-section …`).
 *   - write / edit tool calls on `~/.gitconfig` or `~/.config/git/config`.
 *   - shell writers (sed, tee, cp, perl, …) whose command names either file.
 * Allowed: reads (`--get`, `-l`, a bare key), repo-local identity
 * (`git config user.email …` without a scope flag), one-off
 * `git -c user.email=… commit`, non-identity global keys, and isolated
 * test homes (`HOME=/tmp/h` plus `XDG_CONFIG_HOME=/tmp/h/.config`, or
 * `GIT_CONFIG_GLOBAL=/tmp/…`, pointing away from the real files).
 *
 * Known gap: a test runner or script that calls `git config --global`
 * internally is invisible here — steering sees only the agent's own
 * commands. Isolate those at the source (HOME / GIT_CONFIG_GLOBAL).
 */

import type { PredicateShape } from "@cad0p/pi-steering";
import { homedir } from "node:os";
import { join } from "node:path";

declare global {
	interface PiSteeringPredicates {
		writesGlobalGitIdentity: PredicateShape<boolean>;
		touchesGlobalGitConfig: PredicateShape<boolean>;
	}
}

const HOME = homedir();
const REAL_GLOBAL = new Set([join(HOME, ".gitconfig"), join(HOME, ".config", "git", "config")]);
const REAL_SYSTEM = new Set(["/etc/gitconfig"]);

const IDENTITY_KEY = /^(?:(?:user|author|committer)\.(?:name|email|signingkey)|(?:commit|tag|push)\.gpgsign|gpg\..+)$/i;
const IDENTITY_SECTION = /^(?:user|author|committer|gpg|commit|tag|push)$/i;

/** git global options that consume the next word. */
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
/** `git config` options that consume the next word. */
const CONFIG_OPTS_WITH_VALUE = new Set(["--file", "-f", "--blob", "--type", "-t", "--default", "--comment", "--value"]);
const CONFIG_SUBCOMMANDS = new Set(["get", "set", "unset", "list", "edit", "rename-section", "remove-section", "get-color", "get-colorbool"]);
const WRITE_SUBCOMMANDS = new Set(["set", "unset", "edit", "rename-section", "remove-section"]);
const LEGACY_WRITE_FLAGS = new Set(["--unset", "--unset-all", "--add", "--replace-all"]);
const LEGACY_SECTION_FLAGS = new Set(["--rename-section", "--remove-section"]);
const READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list", "--get-color", "--get-colorbool"]);

function expandHome(p: string, home: string): string {
	return p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

type Env = { get(name: string): string | undefined };

/** Git treats an empty config-path variable as unset. */
function nonEmpty(env: Env, name: string): string | undefined {
	const v = env.get(name);
	return v === "" ? undefined : v;
}

/** Does `scope` resolve to the real global / system config file? */
function targetsRealConfig(scope: { kind: "global" | "system" | "file"; file?: string }, env: Env): boolean {
	const home = nonEmpty(env, "HOME") ?? HOME;
	if (scope.kind === "system") {
		const sys = nonEmpty(env, "GIT_CONFIG_SYSTEM");
		return sys === undefined || REAL_SYSTEM.has(expandHome(sys, home));
	}
	if (scope.kind === "file") {
		const f = expandHome(scope.file ?? "", home);
		return REAL_GLOBAL.has(f) || REAL_SYSTEM.has(f);
	}
	const g = nonEmpty(env, "GIT_CONFIG_GLOBAL");
	if (g !== undefined) return REAL_GLOBAL.has(expandHome(g, home));
	const xdg = nonEmpty(env, "XDG_CONFIG_HOME") ?? join(home, ".config");
	// Git may pick either `~/.gitconfig` or the XDG file: refuse when
	// EITHER candidate is one of the real home's config files.
	return REAL_GLOBAL.has(join(home, ".gitconfig")) || REAL_GLOBAL.has(join(xdg, "git", "config"));
}

/** Exported for tests: `words` are the args AFTER the `git` basename. */
export function isGlobalIdentityWrite(words: readonly string[], env: Env): boolean {
	let i = 0;
	while (i < words.length) {
		const w = words[i] ?? "";
		if (GIT_OPTS_WITH_VALUE.has(w)) { i += 2; continue; }
		if (w.startsWith("-")) { i++; continue; }
		break;
	}
	if (words[i] !== "config") return false;

	let scope: { kind: "global" | "system" | "file"; file?: string } | undefined;
	let sub: string | undefined;
	let edit = false;
	let write = false;
	let read = false;
	let sectionOp = false;
	const positionals: string[] = [];
	for (let j = i + 1; j < words.length; j++) {
		const w = words[j] ?? "";
		if (w === "--global") scope = { kind: "global" };
		else if (w === "--system") scope = { kind: "system" };
		else if (w === "--file" || w === "-f") { scope = { kind: "file", file: words[j + 1] ?? "" }; j++; }
		else if (w.startsWith("--file=")) scope = { kind: "file", file: w.slice(7) };
		else if (w === "-e" || w === "--edit") edit = true;
		else if (LEGACY_WRITE_FLAGS.has(w)) write = true;
		else if (LEGACY_SECTION_FLAGS.has(w)) { write = true; sectionOp = true; }
		else if (READ_FLAGS.has(w)) read = true;
		else if (CONFIG_OPTS_WITH_VALUE.has(w)) j++;
		else if (w.startsWith("-")) { /* other flag */ }
		else if (sub === undefined && positionals.length === 0 && CONFIG_SUBCOMMANDS.has(w)) sub = w;
		else positionals.push(w);
	}
	if (!scope || !targetsRealConfig(scope, env)) return false;

	if (sub !== undefined) {
		if (!WRITE_SUBCOMMANDS.has(sub)) return false;
		if (sub === "edit") return true;
		const name = positionals[0] ?? "";
		if (sub === "rename-section" || sub === "remove-section") return IDENTITY_SECTION.test(name);
		return IDENTITY_KEY.test(name);
	}
	if (edit) return true;
	const name = positionals[0] ?? "";
	if (sectionOp) return IDENTITY_SECTION.test(name);
	if (read && !write) return false;
	if (!write && positionals.length < 2) return false; // bare key = read
	return IDENTITY_KEY.test(name);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HOME_PREFIX = `(?:~|\\$HOME|\\$\\{HOME\\}|${escapeRe(HOME)})`;
/** A path naming the real global git config, in a command string. */
const GLOBAL_GIT_CONFIG_IN_CMD = new RegExp(`${HOME_PREFIX}/(?:\\.gitconfig|\\.config/git/config)(?![\\w./-])`);
/** write / edit tool `path`. */
export const GLOBAL_GIT_CONFIG_PATH = new RegExp(`^${HOME_PREFIX}/(?:\\.gitconfig|\\.config/git/config)$`);
const GLOBAL_GIT_CONFIG_DIR = join(HOME, ".config", "git");

/**
 * Does the command string name a real global config? Expand the two
 * inherited path variables first so `$XDG_CONFIG_HOME/git/config` is
 * judged against the value git will actually use.
 */
function commandTargetsRealGlobal(cmd: string, env: Env): boolean {
	if (GLOBAL_GIT_CONFIG_IN_CMD.test(cmd)) return true;
	const home = nonEmpty(env, "HOME") ?? HOME;
	const xdg = nonEmpty(env, "XDG_CONFIG_HOME") ?? join(home, ".config");
	const g = nonEmpty(env, "GIT_CONFIG_GLOBAL");
	const expanded = cmd
		.replace(/\$(?:\{XDG_CONFIG_HOME\}|XDG_CONFIG_HOME\b)/g, xdg)
		.replace(/\$(?:\{GIT_CONFIG_GLOBAL\}|GIT_CONFIG_GLOBAL\b)/g, g ?? "");
	return GLOBAL_GIT_CONFIG_IN_CMD.test(expanded);
}

/** Shell writers that could rewrite the file. All are declared by other plugins already. */
export const GIT_CONFIG_WRITERS = [
	"sed", "cp", "tee", "mv", "perl", "python", "python3", "awk", "node", "bash", "sh",
	"ln", "install", "dd", "truncate", "rsync",
] as const;

type Ctx = {
	input?: {
		command?: string;
		args?: ReadonlyArray<{ value?: string; text?: string }>;
		envAssignments?: ReadonlyArray<{ value?: string; text?: string }>;
	};
	walkerState?: { cwd?: unknown; env?: ReadonlyMap<string, string> };
};

function commandEnv(prefix: Map<string, string>, chain: ReadonlyMap<string, string> | undefined): Env {
	return { get: (n) => prefix.get(n) ?? chain?.get?.(n) ?? process.env[n] };
}

/** The command's child env: its own prefix assignments win, then the walker, then the inherited process env. */
function envOf(ctx: Ctx): Env {
	const prefix = new Map<string, string>();
	for (const a of ctx?.input?.envAssignments ?? []) {
		const tok = (a?.value ?? a?.text ?? "").replace(/^["']|["']$/g, "");
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=["']?(.*?)["']?$/.exec(tok);
		if (m) prefix.set(m[1] as string, m[2] ?? "");
	}
	return commandEnv(prefix, ctx?.walkerState?.env);
}

/**
 * The env for word expansion in the command string: same-command prefix
 * assignments do NOT bind here (bash expands words before applying them),
 * so only the walker's snapshot and the inherited process env apply.
 */
function ambientEnvOf(ctx: Ctx): Env {
	return commandEnv(new Map(), ctx?.walkerState?.env);
}

export const gitIdentityGuardPlugin = {
	name: "git-identity-guard",
	// No cliDescriptors: git comes from the git plugin, the writers from
	// agent-config-guard / dev-shm-guard. Re-declaring them only produces
	// duplicate-descriptor warnings.
	predicates: {
		writesGlobalGitIdentity: (args: unknown, ctx: Ctx) => {
			if (args !== true) return false;
			const words = (ctx?.input?.args ?? []).map((w) => w?.value ?? w?.text ?? "");
			return isGlobalIdentityWrite(words, envOf(ctx));
		},
		touchesGlobalGitConfig: (args: unknown, ctx: Ctx) => {
			if (args !== true) return false;
			const cmd = typeof ctx?.input?.command === "string" ? ctx.input.command : "";
			if (commandTargetsRealGlobal(cmd, ambientEnvOf(ctx))) return true;
			const cwd = ctx?.walkerState?.cwd;
			return typeof cwd === "string" && cwd === GLOBAL_GIT_CONFIG_DIR && /(?:^|\s)config(?:\s|$)/.test(cmd);
		},
	},
};

const REASON =
	"Do not change the global git identity (user.name / user.email / signing key / gpgsign) or rewrite ~/.gitconfig / ~/.config/git/config: on 2026-10-30 it was set to `t <t@t>` and every later push failed signature verification. Use a one-off `git -c user.email=… commit`, a repo-local `git config user.email …`, or an isolated HOME / GIT_CONFIG_GLOBAL for tests. Ask the user for global changes.";

export const gitIdentityRules = [
	{
		name: "no-global-git-identity",
		tool: "bash" as const,
		command: "git",
		when: { writesGlobalGitIdentity: true },
		reason: REASON,
	},
	{
		name: "no-global-git-config-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: GLOBAL_GIT_CONFIG_PATH,
		reason: REASON,
	},
	{
		name: "no-global-git-config-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: GLOBAL_GIT_CONFIG_PATH,
		reason: REASON,
	},
	{
		name: "no-global-git-config-bash-mutation",
		tool: "bash" as const,
		command: [...GIT_CONFIG_WRITERS],
		when: { touchesGlobalGitConfig: true },
		reason: REASON,
	},
];
