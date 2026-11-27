// SPDX-License-Identifier: MIT
/**
 * Commit-hook guard — no commit-time git hooks, anywhere.
 *
 * Owner ruling 2026-11-27: "No pre-commit hooks. Please ban them ...
 * they slow down everyone." Every agent commits through the same
 * checkouts, so a hook in one repo taxes every lane's every commit.
 * Checks belong in CI or in the tick duty, never on the commit path.
 *
 * Banned hook names (the ones that run on `git commit`): pre-commit,
 * prepare-commit-msg, commit-msg, pre-merge-commit. Refused shapes:
 *   - write/edit of a hook file under .git/hooks, .githooks, .husky or
 *     any `hooks/` dir, or of a hook-manager config
 *     (.pre-commit-config.yaml, lefthook.yml, .husky/);
 *   - a shell writer (cp, ln, mv, tee, install, touch, chmod, interpreters)
 *     whose command names such a hook path;
 *   - `pre-commit install`, `husky`/`husky install`, `lefthook install`;
 *   - setting core.hooksPath (git config or git -c), except to /dev/null
 *     (that disables hooks) and except --get/--unset.
 * Allowed: reading, listing and removing hooks.
 *
 * Known gap (same as ./dev-shm-guard.ts): a bare redirect
 * (`cat > .git/hooks/pre-commit`) is invisible to predicates.
 */

import type { PredicateShape } from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		installsCommitHook: PredicateShape<boolean>;
		setsHooksPath: PredicateShape<boolean>;
	}
}

const HOOK_NAMES = "(?:pre-commit|prepare-commit-msg|commit-msg|pre-merge-commit)";

/** A commit-time hook file path (write/edit tools). */
export const HOOK_FILE_PATH = new RegExp(
	`(?:^|/)(?:hooks|\\.githooks|\\.husky)/${HOOK_NAMES}$|(?:^|/)\\.pre-commit-config\\.ya?ml$|(?:^|/)\\.?lefthook(?:-local)?\\.ya?ml$`,
);

/** The same, inside a command string. */
const HOOK_IN_CMD = new RegExp(
	`(?:^|[\\s/"'=])(?:hooks|\\.githooks|\\.husky)/${HOOK_NAMES}(?=$|[\\s"'\`;|&)])|\\.pre-commit-config\\.ya?ml|lefthook\\.ya?ml`,
);

/** Writers that can put a hook in place. */
export const HOOK_WRITERS = [
	"cp",
	"ln",
	"mv",
	"tee",
	"install",
	"touch",
	"chmod",
	"python",
	"python3",
	"perl",
	"node",
	"bash",
	"sh",
	"sed",
	"awk",
] as const;

/** Hook managers: any install verb is refused. */
export const HOOK_MANAGERS = ["pre-commit", "husky", "lefthook"] as const;

const cmdOf = (ctx: { input?: { command?: string } }) =>
	typeof ctx?.input?.command === "string" ? ctx.input.command : "";

export const commitHookGuardPlugin = {
	name: "commit-hook-guard",
	cliDescriptors: Object.fromEntries(HOOK_MANAGERS.map((b) => [b, {}])),
	predicates: {
		installsCommitHook: (args: unknown, ctx: { input?: { command?: string } }) => {
			if (args !== true) return false;
			return HOOK_IN_CMD.test(cmdOf(ctx));
		},
		setsHooksPath: (args: unknown, ctx: { input?: { command?: string } }) => {
			if (args !== true) return false;
			const cmd = cmdOf(ctx);
			// git -c core.hooksPath=<x> (allowed only for /dev/null)
			const inline = /core\.hooksPath=(\S+)/i.exec(cmd);
			if (inline && !/^["']?\/dev\/null["']?$/.test(inline[1] ?? "")) return true;
			// git config [scope] core.hooksPath <value>
			if (!/\bconfig\b/.test(cmd)) return false;
			if (/--(?:get|get-all|get-regexp|unset|unset-all|list)\b|\bconfig\s+(?:get|unset|list)\b/.test(cmd)) return false;
			const m = /core\.hooksPath\s+(["']?)(\S+?)\1(?=$|[\s;|&)])/i.exec(cmd);
			return !!m && m[2] !== "/dev/null";
		},
	},
};

const REASON =
	"No commit-time git hooks (pre-commit, prepare-commit-msg, commit-msg, pre-merge-commit), no hook managers (pre-commit, husky, lefthook) and no core.hooksPath: owner ruling 2026-11-27, hooks slow down every lane's every commit. Put the check in CI or in the tick duty instead. Reading, listing and removing existing hooks is allowed.";

export const commitHookRules = [
	{ name: "no-commit-hook-write", tool: "write" as const, field: "path" as const, pattern: HOOK_FILE_PATH, reason: REASON },
	{ name: "no-commit-hook-edit", tool: "edit" as const, field: "path" as const, pattern: HOOK_FILE_PATH, reason: REASON },
	{
		name: "no-commit-hook-bash",
		tool: "bash" as const,
		command: [...HOOK_WRITERS],
		when: { installsCommitHook: true },
		reason: REASON,
	},
	{ name: "no-hook-manager", tool: "bash" as const, command: [...HOOK_MANAGERS], reason: REASON },
	{ name: "no-hooks-path", tool: "bash" as const, command: "git", when: { setsHooksPath: true }, reason: REASON },
];
