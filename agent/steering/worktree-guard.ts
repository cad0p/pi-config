// SPDX-License-Identifier: MIT
/**
 * Worktree guard - one creation path, one placement, one removal path.
 *
 * Owner calls 8 and 10 (pc-host #764 design, 2026-11-09). A worktree is
 * a real sibling of its primary checkout, `<area>/github/<repo>-<slug>`
 * (`<area>` is the primary's own parent: /home/pier/personal for private
 * repos, /home/pier/open-source for public ones). `pc-wt new` computes
 * that path itself, refuses the scratch roots, the /home floor and a
 * vault checkout, and records the session that made the worktree.
 *
 * Refused, in an agent command:
 *   - `git worktree add`, `move`, `remove` (plain or --force) and
 *     `prune`: creation goes through `pc-wt new`, removal through the
 *     hourly reap (or `pc-wt done`), and a repo-wide prune unregisters a
 *     sibling gate's worktree whose directory is momentarily missing
 *     (merge-pr.sh #444 R4). Allowed: `list`, `lock`, `unlock`,
 *     `repair` - they change no placement and delete nothing.
 *   - `git clone` whose destination is under a scratch root
 *     (/data/tmp, /tmp, /var/tmp, /dev/shm) or is
 *     `<area>/github/<existing-primary>-<anything>` (a clone used as a
 *     worktree). A new primary at a fresh name is allowed.
 *   - a Goldmine or `~/.pi` worktree of any kind: there are no vault
 *     worktrees. Writers commit on main in the vault and in the agent
 *     dir, their own paths only - the message says so verbatim.
 *
 * The rule is generic: it names no /data/tmp/wt path (owner call 8: "any
 * write under /data/tmp/wt could be too specific to our setup"). Old
 * contents there are drained by pc-wt's migration and reap.
 *
 * Known gaps, pinned here the way primary-checkout-guard pins its own:
 *   - a script that runs git internally (steering sees only the agent's
 *     own commands);
 *   - a wrapper other than bash or sh (zsh, dash, `env bash -c`);
 *   - a destination held in a variable or a command substitution, and a
 *     `cd` inside a `-c` payload behind a variable;
 *   - `--git-dir` / `--work-tree` pointing elsewhere.
 * The reap is the backstop for whatever slips through: an unmarked
 * worktree is still found by enumeration and still reaped, only on the
 * slower legacy window.
 */

import type { PredicateContext, PredicateShape } from "@cad0p/pi-steering";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseGitCall } from "./primary-checkout-guard.ts";

declare global {
	interface PiSteeringPredicates {
		mutatesWorktree: PredicateShape<boolean>;
	}
}

/** The two areas a primary checkout lives in (private and public repos). */
export const AREAS = [
	"/home/pier/personal/github",
	"/home/pier/open-source/github",
];

/** Roots a worktree or a clone never lands in: a reboot or a tmpfiles rule eats them. */
export const SCRATCH_ROOTS = ["/data/tmp", "/tmp", "/var/tmp", "/dev/shm"];

/** The vault: no worktree, commit on main. */
export const VAULT = "/home/pier/personal/github/Goldmine";

/** The agent dir: no worktree, commit on main. */
export const AGENT_DIR = join(homedir(), ".pi");

/** The worktree verbs that change a placement, a registration or a tree. */
const REFUSED_VERBS = new Set(["add", "move", "remove", "prune"]);

/** The worktree verbs that are read-only or git's own lock bit. */
const ALLOWED_VERBS = new Set(["list", "lock", "unlock", "repair"]);

/** git global options whose following word is a value, not the subcommand. */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
	"--config-env",
	"--attr-source",
]);

function wordValue(word: unknown): string {
	const w = word as { value?: unknown; text?: unknown } | null | undefined;
	if (typeof w?.value === "string") return w.value;
	if (typeof w?.text === "string") return w.text;
	return typeof word === "string" ? word : "";
}

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

/** rc 0 when `path` is `root` or below it (component boundary, never a prefix). */
export function under(path: string, root: string): boolean {
	return path === root || path.startsWith(root + "/");
}

/** Is `dir` a primary checkout? A primary's .git is a DIRECTORY (a worktree's is a file). */
export function isPrimary(dir: string): boolean {
	try {
		return lstatSync(join(dir, ".git")).isDirectory();
	} catch {
		return false;
	}
}

/** The primary checkouts under the areas, by directory name. */
export function primaries(): string[] {
	const out: string[] = [];
	for (const area of AREAS) {
		for (const name of safeRead(area)) {
			const dir = join(area, name);
			if (isPrimary(dir)) out.push(dir);
		}
	}
	return out;
}

function safeRead(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Is the path the vault, or inside the agent dir? Both are commit-on-main trees. */
export function isVaultOrAgentDir(path: string): boolean {
	return under(path, VAULT) || under(path, AGENT_DIR);
}

/** The worktree or clone a git invocation would create, move or delete. */
export type WorktreeCall =
	| { kind: "worktree"; verb: string; repo: string | null }
	| { kind: "clone"; dest: string | null; repo: string | null };

/**
 * Classify one git invocation. `null` means "not a worktree verb this
 * guard owns" (a read, a lock, a plain clone elsewhere).
 */
export function worktreeCall(
	words: readonly string[],
	baseCwd: string | null,
): WorktreeCall | null {
	const call = parseGitCall(words, baseCwd);
	if (call === null) return null;
	if (call.subcommand === "worktree") {
		const verb = call.rest.find((w) => !isFlag(w)) ?? "";
		if (verb === "") return null;
		return { kind: "worktree", verb, repo: call.repo };
	}
	if (call.subcommand === "clone") {
		// `git clone [flags] <url> [<dir>]`: the url is the first non-flag word,
		// the destination the second; without one git names the directory after
		// the url's basename.
		const positionals = call.rest.filter((w) => !isFlag(w));
		const url = positionals[0] ?? "";
		const explicit = positionals[1];
		let dest: string | null = null;
		if (explicit !== undefined) {
			dest =
				baseCwd === null
					? isAbsolute(explicit)
						? resolve(explicit)
						: null
					: resolve(baseCwd, explicit);
		} else if (url !== "" && baseCwd !== null) {
			const name = basename(url.replace(/[\/]+$/, "")).replace(/\.git$/, "");
			dest = name === "" ? null : resolve(baseCwd, name);
		}
		return { kind: "clone", dest, repo: call.repo };
	}
	return null;
}

/** Does the destination name a worktree of an existing primary (`<primary>-<slug>`)? */
export function namesAWorktree(dest: string): boolean {
	const dir = resolve(dest);
	for (const primary of primaries()) {
		const parent = dir.slice(0, dir.lastIndexOf("/"));
		if (parent !== primary.slice(0, primary.lastIndexOf("/"))) continue;
		const name = dir.slice(dir.lastIndexOf("/") + 1);
		const primaryName = primary.slice(primary.lastIndexOf("/") + 1);
		if (name.startsWith(primaryName + "-")) return true;
	}
	return false;
}

/** Is the destination one this guard refuses? */
export function badDestination(dest: string | null): boolean {
	if (dest === null) return false;
	if (SCRATCH_ROOTS.some((root) => under(dest, root))) return true;
	return namesAWorktree(dest);
}

/** The effective cwd of a bash ref ("unknown" when the walker bailed). */
function effectiveCwd(ctx: PredicateContext): string | null {
	const fromWalker = ctx.walkerState?.cwd;
	if (typeof fromWalker === "string" && fromWalker !== "" && fromWalker !== "unknown") {
		return fromWalker;
	}
	return typeof ctx.cwd === "string" && ctx.cwd !== "" && ctx.cwd !== "unknown"
		? ctx.cwd
		: null;
}

/** The classification of the ref's own command, or null. */
function callOf(ctx: PredicateContext): WorktreeCall | null {
	const words = (ctx.input.args ?? []).map(wordValue);
	return worktreeCall(words, effectiveCwd(ctx));
}

/** Shell wrappers whose `-c` payload is re-read here (primary-checkout-guard's set). */
const SHELL_WRAPPERS = new Set(["bash", "sh"]);

/** The `-c` payload of a wrapper ref, or null. */
export function wrapperPayload(words: readonly string[]): string | null {
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] ?? "";
		if (word === "--") return null;
		if (word === "-o" || word === "+o") {
			i += 1;
			continue;
		}
		if (!isFlag(word)) return null;
		if (word.slice(1).includes("c")) return words[i + 1] ?? null;
	}
	return null;
}

/** Naive tokenizer for a wrapper payload: whitespace split, quotes stripped. */
function payloadWords(segment: string): string[] {
	const out: string[] = [];
	for (const token of segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
		out.push(token.replace(/^["']|["']$/g, ""));
	}
	return out;
}

/** Every worktree or clone call a wrapper payload makes, with its own `cd` threaded. */
export function payloadCalls(
	payload: string,
	baseCwd: string | null,
): WorktreeCall[] {
	const out: WorktreeCall[] = [];
	let base = baseCwd;
	for (const segment of payload.split(/&&|\|\||[;|\n]|&/)) {
		const words = payloadWords(segment);
		const head = words[0] ?? "";
		if (head === "cd") {
			const target = words[1] ?? "";
			if (target === "") continue;
			base =
				base === null
					? isAbsolute(target)
						? resolve(target)
						: null
					: resolve(base, target);
			continue;
		}
		if (head !== "git") continue;
		const call = worktreeCall(words.slice(1), base);
		if (call !== null) out.push(call);
	}
	return out;
}

/** The calls one bash ref makes: its own command, or its wrapper payload's. */
function callsOf(ctx: PredicateContext): WorktreeCall[] {
	const words = (ctx.input.args ?? []).map(wordValue);
	const basename_ = ctx.input.basename;
	if (basename_ !== undefined && SHELL_WRAPPERS.has(basename_)) {
		const payload = wrapperPayload(words);
		if (payload !== null) return payloadCalls(payload, effectiveCwd(ctx));
	}
	const call = callOf(ctx);
	return call === null ? [] : [call];
}

/** Does this call have to be refused? */
export function refused(call: WorktreeCall): boolean {
	if (call.kind === "clone") return badDestination(call.dest);
	if (ALLOWED_VERBS.has(call.verb)) return false;
	if (REFUSED_VERBS.has(call.verb)) return true;
	// An unknown verb on `git worktree` fails closed: a future verb that
	// changes a registration is refused until this list is reviewed.
	return true;
}

/** The vault/config message, verbatim from the owner's call 10. */
export function vaultMessage(repo: string | null): string {
	const where = repo ?? "this checkout";
	return `no worktree for ${where}: commit on main, your paths only (git commit -- <paths> in the main checkout, then push). The vault and the agent dir are committed directly by design; a worktree there is a second copy nobody reaps.`;
}

/** The generic message, with the repo and the exact command to run instead. */
export function worktreeMessage(repo: string | null): string {
	const name = repo === null ? "<repo>" : basename(repo);
	return `worktrees are created by pc-wt: run \`pc-wt new ${name} <slug> --branch <branch>\` (it places the worktree as a sibling of the primary checkout, refuses the scratch roots and the /home floor, and records the session). git worktree add|move|remove|prune and a clone into a worktree path are refused: removal has one path too (the hourly pc-wt reap, or pc-wt done).`;
}

/** The refusal message for a bash ref, or null when the ref is allowed. */
export function refusal(ctx: PredicateContext): string | null {
	for (const call of callsOf(ctx)) {
		if (!refused(call)) continue;
		if (call.repo !== null && isVaultOrAgentDir(call.repo)) return vaultMessage(call.repo);
		if (call.kind === "clone" && call.dest !== null && isVaultOrAgentDir(call.dest)) {
			return vaultMessage(call.dest);
		}
		return worktreeMessage(call.repo);
	}
	return null;
}

export const worktreeGuardPlugin = {
	name: "worktree-guard",
	// No cliDescriptors: `git` is declared by the git plugin.
	predicates: {
		mutatesWorktree: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			const calls = callsOf(ctx);
			if (calls.length === 0) return false;
			return calls.some(refused);
		},
	},
};

export const worktreeGuardRules = [
	{
		name: "no-worktree-outside-pc-wt",
		tool: "bash" as const,
		// bash / sh: the `-c` payload scan (the walker does not thread a `cd`
		// through a subshell, so the wrapper is re-read here).
		command: ["git", "bash", "sh"],
		when: { mutatesWorktree: true },
		reason: (ctx: PredicateContext) =>
			refusal(ctx) ??
			worktreeMessage(null),
	},
];
