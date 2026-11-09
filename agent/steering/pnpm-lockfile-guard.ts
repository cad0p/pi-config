// SPDX-License-Identifier: MIT
/**
 * pnpm-lockfile guard — where a repo has a `pnpm-lock.yaml`, npm may not
 * install into it.
 *
 * Owner call 11 (2026-11-09), verbatim: "yes, move to pnpm, one global
 * store, the steering rule" — cad0p/pc-website#80. pc-website installed
 * with `npm ci` from `package-lock.json`, so every worktree and every
 * gate snapshot carried its own 394 MB `node_modules`; the repo moves to
 * pnpm on the one global store (`~/.local/share/pnpm/store`, hardlinked
 * `node_modules`). The rule is generic and keyed on the LOCKFILE, not on
 * a repo list: any repo that carries a `pnpm-lock.yaml` is a pnpm repo,
 * and an npm install there is the drift this guard refuses.
 *
 * Refused: an `npm` ref whose subcommand installs into the project —
 * `install`, `i`, `ci`, `add` (the alias set; `npm install-test`/`it`
 * are not covered) — when the effective directory is inside a pnpm repo.
 * The message is the owner's, verbatim.
 *
 * How the effective directory is resolved — never by re-parsing the
 * shell. The walker's per-ref cwd already models `cd <dir> &&` prefixes
 * (`ctx.walkerState.cwd`, resolved through the same env tracker the
 * other guards read), and `npm --prefix <dir>` is read through the
 * descriptor-bound facade (`ctx.command.getFlagValue`), so the argv view
 * and the flag view cannot disagree. `--prefix` wins over the cwd,
 * exactly as npm applies it.
 *
 * What "is a pnpm repo" means: walk up from the effective directory,
 * checking each level for `pnpm-lock.yaml`. That covers the effective
 * directory itself, the nearest ancestor carrying a `package.json`, and
 * the workspace root above a nested `package.json` (a pnpm workspace
 * keeps its single lockfile at the root — stopping at the nearest
 * `package.json` would open exactly the bypass this guard exists for).
 * The walk stops at the first directory carrying `.git` (a repo root,
 * checked AFTER the lockfile so a root with both is still found): a
 * lockfile above the repo boundary belongs to another checkout, never to
 * this one.
 *
 * Fail-closed: an install whose directory cannot be placed statically —
 * a walker-unknown cwd (`cd "$X" && npm install`), a `--prefix` carrying
 * an unresolved variable — returns the `"unknown"` sentinel, which the
 * rule's default `onUnknown: "block"` policy turns into a refusal.
 * Unknown is not "a repo without a pnpm-lock.yaml".
 *
 * Allowed: every npm verb that does not install (`npm view`,
 * `npm --version`, `npm run build`, `npm test`, `npm ls`, `npm outdated`,
 * `npm exec`), every npm install in a repo without a `pnpm-lock.yaml`,
 * and every pnpm command (`pnpm install --frozen-lockfile`).
 *
 * Known gaps (pinned in the test file):
 *   - a wrapper payload that `cd`s first — `bash -c 'cd <pnpm repo> && npm
 *     install'` from elsewhere: the walker starts a payload's refs from
 *     the OUTER cwd (the subshell `cd` is not threaded), so the install
 *     is placed in the outer directory. `bash -c 'npm install'` from a
 *     pnpm repo IS caught (the inner ref keeps the outer cwd);
 *   - `npx` (a different basename, and it does not rewrite the lockfile);
 *   - a script or Makefile that runs npm internally — steering sees only
 *     the agent's own commands.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateContext,
	PredicateShape,
} from "@cad0p/pi-steering";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

declare global {
	interface PiSteeringPredicates {
		/**
		 * `when.npmInstallInPnpmRepo` — this bash ref is an npm install
		 * verb (`install` / `i` / `ci` / `add`) whose effective
		 * directory sits in a repo carrying a `pnpm-lock.yaml`. Boolean
		 * leaf; `"unknown"` when the directory cannot be placed.
		 */
		npmInstallInPnpmRepo: PredicateShape<boolean>;
	}
}

/** The lockfile that makes a repo a pnpm repo. */
export const PNPM_LOCKFILE = "pnpm-lock.yaml";

/** The repo-boundary marker the walk-up stops at (after the lockfile check). */
const REPO_MARKER = ".git";

/**
 * npm subcommands that install into the project (and would rewrite a
 * lockfile): `install`, its alias `i`, `ci`, and `add`.
 */
export const NPM_INSTALL_VERBS: ReadonlySet<string> = new Set([
	"install",
	"i",
	"ci",
	"add",
]);

/** `--prefix` — the one npm global option that relocates the project root. */
const PREFIX_FLAG = { aliases: ["--prefix"], takesValue: true } as const;

/**
 * The nearest `pnpm-lock.yaml` at or above `start`, or null. Stops at
 * the first directory carrying `.git` (the repo boundary) — the lockfile
 * check runs first, so a repo root that carries both is still found.
 */
export function findPnpmLockfile(start: string): string | null {
	let dir = resolve(start);
	for (;;) {
		const lockfile = join(dir, PNPM_LOCKFILE);
		if (existsSync(lockfile)) return lockfile;
		if (existsSync(join(dir, REPO_MARKER))) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Place one path token against `base`: absolute stays as-is, `~` /
 * `$HOME` expand, a relative path joins `base`. null when the token or
 * the base cannot be resolved statically (fail-closed callers decide
 * what unknown means).
 */
function placePath(raw: string, base: string | null): string | null {
	let p = raw.trim().replace(/^["']+|["']+$/g, "");
	if (p === "") return null;
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	else if (p === "$HOME" || p.startsWith("$HOME/")) p = join(homedir(), p.slice(5));
	if (p.includes("$")) return null;
	if (isAbsolute(p)) return resolve(p);
	if (base === null) return null;
	return resolve(base, p);
}

/** The walker's effective cwd for this ref, or null when it is unknown. */
function effectiveCwd(ctx: PredicateContext): string | null {
	const fromWalker = ctx.walkerState?.cwd;
	if (typeof fromWalker === "string" && fromWalker !== "" && fromWalker !== "unknown") {
		return fromWalker;
	}
	return typeof ctx.cwd === "string" && ctx.cwd !== "" && ctx.cwd !== "unknown"
		? ctx.cwd
		: null;
}

/**
 * The directory this npm ref installs into: `--prefix` (last wins, as
 * npm applies it) placed against the effective cwd, else the effective
 * cwd itself. null when it cannot be placed statically.
 */
export function installDir(ctx: PredicateContext): string | null {
	const base = effectiveCwd(ctx);
	let prefix: string | null = null;
	try {
		prefix = ctx.command.getFlagValue(PREFIX_FLAG);
	} catch {
		prefix = null; // no descriptor bound — fall through to the cwd
	}
	if (prefix === null || prefix.trim() === "") return base;
	return placePath(prefix, base);
}

/** The npm subcommand of a positional view: its first non-flag word. */
export function npmVerb(positionals: readonly string[]): string | undefined {
	return positionals.find((word) => !word.startsWith("-"));
}

/**
 * `when.npmInstallInPnpmRepo` — an npm install verb whose effective
 * directory is inside a pnpm repo. `"unknown"` when the directory cannot
 * be placed (fail-closed: the rule's default `onUnknown` policy blocks).
 */
export const npmInstallInPnpmRepo = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		if (ctx.input?.basename !== "npm") return false;
		const verb = npmVerb(ctx.command.positionals());
		if (verb === undefined || !NPM_INSTALL_VERBS.has(verb)) return false;
		const dir = installDir(ctx);
		if (dir === null) return "unknown";
		return (findPnpmLockfile(dir) !== null) === expected;
	},
);

/** The owner's message, verbatim (brief pnpm-steering-build). */
const REASON =
	"this repo uses pnpm: run pnpm install --frozen-lockfile (one global store)";

export const pnpmLockfileRules = [
	{
		name: "no-npm-install-in-pnpm-repo",
		tool: "bash" as const,
		command: "npm" as const,
		when: { npmInstallInPnpmRepo: true },
		reason: REASON,
	},
];

export const pnpmLockfilePlugin = {
	name: "pnpm-lockfile-guard",
	// The npm descriptor lives HERE (dev-shm-guard used to declare the
	// bare basename): one owner per basename, or the merger reports a
	// descriptor collision. The value-taking flags are declared so
	// positionals() skips their values — 'npm --prefix /x install' still
	// reads the verb 'install', and the same table backs the
	// getFlagValue('--prefix') read above.
	cliDescriptors: {
		npm: {
			flags: {
				prefix: { aliases: ["--prefix"], takesValue: true },
				registry: { aliases: ["--registry"], takesValue: true },
				userconfig: { aliases: ["--userconfig"], takesValue: true },
				globalconfig: { aliases: ["--globalconfig"], takesValue: true },
				cache: { aliases: ["--cache"], takesValue: true },
				loglevel: { aliases: ["--loglevel"], takesValue: true },
				tag: { aliases: ["--tag"], takesValue: true },
				workspace: { aliases: ["-w", "--workspace"], takesValue: true },
				omit: { aliases: ["--omit"], takesValue: true },
				include: { aliases: ["--include"], takesValue: true },
				location: { aliases: ["--location"], takesValue: true },
				scope: { aliases: ["--scope"], takesValue: true },
				otp: { aliases: ["--otp"], takesValue: true },
				depth: { aliases: ["--depth"], takesValue: true },
			},
		},
	},
	predicates: { npmInstallInPnpmRepo },
} as const satisfies Plugin;
