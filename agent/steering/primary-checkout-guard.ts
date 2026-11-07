// SPDX-License-Identifier: MIT
/**
 * Primary-checkout guard - the primary checkout stays on main.
 *
 * Owner rule: every pc-* repo has ONE primary checkout at
 * /home/pier/personal/github/pc-<name>. The primary is never used for
 * editing: all work happens in a worktree (git worktree add), and the
 * primary only ever fast-forwards to origin/main after a merge.
 *
 * Incident 2026-11-06: pc-website's primary sat on
 * docs/privacy-category-level-review for three days - a branch whose
 * PR (#45) had merged long before - because an agent created the branch
 * and committed on it in the primary. The other primaries had drifted
 * behind origin/main the same way. tools/merge-pr.sh (pc-host) merges
 * through its own operator clones under ~/.local/share/pc-merge/ and
 * never touches the primaries, so nothing was watching them.
 *
 * Refused, in a primary checkout only:
 *   - checkout / switch to anything but main, and every create form
 *     (-b, -B, -c, -C, --orphan, --detach, --track, --force);
 *   - commit, merge (except --ff-only origin/main while on main),
 *     pull (except --ff-only while on main), rebase, reset,
 *     cherry-pick, revert, am, stash;
 *   - the edit / write tools on any path inside the primary, except
 *     its .local/ directory (agent scratch, never tracked).
 *
 * Allowed (the primary's read + sync surface): fetch, status, log,
 * show, diff, worktree add/list/remove/prune, branch --show-current,
 * switch/checkout main, merge --ff-only origin/main, pull --ff-only,
 * and everything else git does that does not move HEAD or the index.
 *
 * How the target repo is resolved: the effective cwd of the command
 * (so `cd <primary> && git commit` and a wrapper `bash -c '...'` both
 * resolve) with every `git -C <path>` applied on top, cumulatively, as
 * git itself does. A primary is a directory
 * /home/pier/personal/github/pc-<name> whose .git is a DIRECTORY - a
 * linked worktree has a .git FILE, so pc-website-demo, pc-host-123 and
 * /data/tmp/wt/* worktrees never match.
 *
 * Fail-closed: a mutating git verb whose repo cannot be resolved
 * statically (dynamic `cd "$VAR"`, command substitution, and no `-C`)
 * is refused. The merge / pull fast-forward allow needs the branch:
 * the walker's branch tracker answers when the chain contains a
 * checkout, otherwise one `git rev-parse --abbrev-ref HEAD` probe
 * decides - an unresolvable branch refuses the sync.
 *
 * Known gaps (deliberately out of scope, pinned here):
 *   - `git restore`, `git clean`, `git apply`, `git checkout -- <path>`
 *     style worktree writes other than the verbs above;
 *   - `--git-dir` / `--work-tree` pointing at a primary from elsewhere;
 *   - a wrapper other than bash / sh (zsh, dash, env bash -c, `bash script`);
 *   - the `-c` payload is re-read textually (the walker starts the
 *     payload's refs from the OUTER cwd, so a `cd` inside it is invisible
 *     otherwise): a path hidden behind a variable or a command
 *     substitution in the payload is not resolved;
 *   - a script that runs git internally (steering sees only the agent's
 *     own commands);
 *   - `git branch -f` / `update-ref` on a non-main ref (the shipped
 *     no-main-ref-write rail owns the main ref).
 */

import type { PredicateContext, PredicateShape } from "@cad0p/pi-steering";
import { NO_CHECKOUT_IN_CHAIN } from "@cad0p/pi-steering/plugins/git";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

declare global {
	interface PiSteeringPredicates {
		mutatesPrimaryCheckout: PredicateShape<boolean>;
		writesPrimaryCheckout: PredicateShape<boolean>;
	}
}

/** Every primary checkout lives here, one directory per repo. */
export const PRIMARY_ROOT = "/home/pier/personal/github";

/** The default branch every primary must stay on. */
const MAIN = "main";

/** A primary's directory name: `pc-<name>`. */
const PRIMARY_NAME = /^pc-.+/;

/** The agent's own scratch inside a primary - never tracked, never guarded. */
const LOCAL_DIR = ".local";

/** Read the quote-resolved word text pi-steering exposes for a bash arg. */
function wordValue(word: unknown): string {
	const w = word as { value?: unknown; text?: unknown } | null | undefined;
	if (typeof w?.value === "string") return w.value;
	if (typeof w?.text === "string") return w.text;
	return typeof word === "string" ? word : "";
}

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

/** Is `dir` a primary checkout? A primary's .git is a DIRECTORY; a worktree's is a file. */
export function isPrimaryCheckout(dir: string): boolean {
	try {
		return lstatSync(join(dir, ".git")).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The primary checkout `path` lives in (or is), or null when it is
 * outside ""PRIMARY_ROOT, not under a pc-* directory, or that
 * directory is not a primary (a worktree, a plain clone, a missing path).
 */
export function primaryOfPath(path: string): string | null {
	const abs = resolve(path);
	if (!abs.startsWith(PRIMARY_ROOT + "/")) return null;
	const first = abs.slice(PRIMARY_ROOT.length + 1).split("/")[0] ?? "";
	if (!PRIMARY_NAME.test(first)) return null;
	const repo = join(PRIMARY_ROOT, first);
	return isPrimaryCheckout(repo) ? repo : null;
}

/** Is `path` inside the primary's .local/ scratch directory? */
export function isLocalScratch(path: string, primary: string): boolean {
	const abs = resolve(path);
	const local = join(primary, LOCAL_DIR);
	return abs === local || abs.startsWith(local + "/");
}

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

/** A parsed `git` invocation: which repo it acts on and what it runs. */
export interface GitCall {
	/** Absolute repo path, or null when it cannot be resolved statically. */
	repo: string | null;
	subcommand: string;
	rest: string[];
}

/**
 * Split `<global flags> <subcommand> <rest>` and resolve the target
 * repo. `-C` is applied cumulatively against the running base, exactly
 * as git does (`-C a -C b` = `a/b`); `baseCwd` is null when the
 * walker could not resolve the effective cwd.
 */
export function parseGitCall(
	words: readonly string[],
	baseCwd: string | null,
): GitCall | null {
	let base = baseCwd;
	let i = 0;
	while (i < words.length) {
		const word = words[i] ?? "";
		if (word === "--") {
			i += 1;
			break;
		}
		if (!isFlag(word)) break;
		if (word === "-C") {
			const target = words[i + 1] ?? "";
			base =
				base === null
					? isAbsolute(target)
						? resolve(target)
						: null
					: resolve(base, target);
			i += 2;
			continue;
		}
		if (word.startsWith("-C") && word.length > 2) {
			const target = word.slice(2);
			base =
				base === null
					? isAbsolute(target)
						? resolve(target)
						: null
					: resolve(base, target);
			i += 1;
			continue;
		}
		if (word.includes("=")) {
			i += 1; // --git-dir=/x, --exec-path=/y
			continue;
		}
		if (GIT_GLOBAL_VALUE_FLAGS.has(word)) {
			i += 2; // -c k=v, --git-dir /x
			continue;
		}
		i += 1; // -p, --no-pager, --bare, ...
	}
	const subcommand = words[i];
	if (subcommand === undefined || subcommand === "") return null;
	return { repo: base, subcommand, rest: words.slice(i + 1) };
}

/** Flags that create, detach or force a checkout - never a plain "go to main". */
const CHECKOUT_CREATE_FLAGS = new Set([
	"-b",
	"-B",
	"-c",
	"-C",
	"-d",
	"-f",
	"-t",
	"--create",
	"--force-create",
	"--orphan",
	"--detach",
	"--track",
	"--no-track",
	"--force",
	"--discard-changes",
]);

/** Non-flag words, skipping the value of `--`-separated path lists. */
function positionals(rest: readonly string[]): string[] {
	return rest.filter((word) => !isFlag(word));
}

/**
 * `git checkout` / `git switch` that only moves HEAD to main. Anything
 * with a create/detach/force flag, a `--` path separator, or a target
 * other than main (a branch, a sha, `-`, `.`) is a mutation.
 */
export function isMainSwitch(rest: readonly string[]): boolean {
	if (rest.includes("--")) return false;
	for (const word of rest) {
		if (CHECKOUT_CREATE_FLAGS.has(word)) return false;
		// Bundled short form: -bmain, -Cmain, -tmain.
		if (/^-[bBcCdt]./.test(word)) return false;
	}
	const targets = positionals(rest);
	return targets.length === 0 || (targets.length === 1 && targets[0] === MAIN);
}

/** `git merge --ff-only origin/main` and nothing else. */
export function isFfOnlyOriginMain(rest: readonly string[]): boolean {
	if (!rest.includes("--ff-only")) return false;
	const targets = positionals(rest);
	return targets.length === 1 && targets[0] === "origin/main";
}

/** `git pull --ff-only` (bare, or with origin / origin main). */
export function isFfOnlyPull(rest: readonly string[]): boolean {
	if (!rest.includes("--ff-only")) return false;
	const targets = positionals(rest);
	if (targets.length === 0) return true;
	if (targets[0] !== "origin") return false;
	return targets.length === 1 || (targets.length === 2 && targets[1] === MAIN);
}

/** Subcommands that always move HEAD, the index or the worktree. */
const ALWAYS_MUTATING = new Set([
	"commit",
	"rebase",
	"reset",
	"cherry-pick",
	"revert",
	"am",
	"stash",
]);

/** What a git invocation does to the checkout: nothing, a mutation, or the one allowed sync. */
export type MutationKind = "mutation" | "ff-only";

/**
 * Classify one git invocation. `null` means "not a checkout mutation"
 * (a read, or a verb this guard deliberately leaves alone).
 */
export function mutationKind(
	subcommand: string,
	rest: readonly string[],
): MutationKind | null {
	if (ALWAYS_MUTATING.has(subcommand)) return "mutation";
	if (subcommand === "checkout" || subcommand === "switch") {
		return isMainSwitch(rest) ? null : "mutation";
	}
	if (subcommand === "merge") {
		return isFfOnlyOriginMain(rest) ? "ff-only" : "mutation";
	}
	if (subcommand === "pull") {
		return isFfOnlyPull(rest) ? "ff-only" : "mutation";
	}
	return null;
}

/**
 * Shell wrappers whose `-c` payload the walker does not thread a cwd
 * through. Exactly the basenames the rule routes on (a wrapper outside
 * this set is a known gap, listed in the header).
 */
const SHELL_WRAPPERS = new Set(["bash", "sh"]);

/**
 * The command string a shell wrapper runs, or null. `bash -c '<payload>'`,
 * `bash -lc '<payload>'`, `sh -ec '<payload>'` — the first bundled short
 * flag containing `c`; `-o <opt>` keeps its value off the flag scan.
 */
export function wrapperPayload(words: readonly string[]): string | null {
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] ?? "";
		if (word === "--") return null;
		if (word === "-o" || word === "+o") {
			i += 1; // -o pipefail
			continue;
		}
		if (!isFlag(word)) return null; // a script file / stdin, not -c
		if (word.slice(1).includes("c")) return words[i + 1] ?? null;
	}
	return null;
}

/** Naive shell tokenizer for a wrapper payload: whitespace split, quotes stripped. */
function payloadWords(segment: string): string[] {
	const out: string[] = [];
	for (const token of segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
		out.push(token.replace(/^["']|["']$/g, ""));
	}
	return out;
}

/** What a shell wrapper's `-c` payload does to a primary checkout. */
export interface PayloadScan {
	/** The first primary the payload names (for the block message). */
	primary: string | null;
	/** The payload mutates a primary. */
	mutates: boolean;
	/** The primary a fast-forward sync targets, when that is all it does. */
	ffOnly: string | null;
}

/**
 * Re-read a shell wrapper's `-c` payload. The walker descends into the
 * payload's git refs but starts them from the OUTER cwd — a `cd` inside
 * the payload is a subshell scope it does not thread — so
 * `bash -c 'cd <primary> && git commit'` would otherwise slip through.
 * Segments split on the shell separators; `cd <dir>` moves the running
 * base and `git <verb>` is classified exactly like a top-level ref.
 */
export function scanPayload(payload: string, baseCwd: string | null): PayloadScan {
	const scan: PayloadScan = { primary: null, mutates: false, ffOnly: null };
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
		const call = parseGitCall(words.slice(1), base);
		if (call === null) continue;
		const kind = mutationKind(call.subcommand, call.rest);
		if (kind === null) continue;
		const primary = call.repo === null ? null : primaryOfPath(call.repo);
		if (primary === null) {
			// Unresolvable repo with a mutating verb: fail closed.
			if (call.repo === null) scan.mutates = true;
			continue;
		}
		scan.primary ??= primary;
		if (kind === "ff-only") scan.ffOnly ??= primary;
		else scan.mutates = true;
	}
	return scan;
}

/** The effective cwd of a bash ref (`"unknown"` when the walker bailed). */
function effectiveCwd(ctx: PredicateContext): string | null {
	const fromWalker = ctx.walkerState?.cwd;
	if (typeof fromWalker === "string" && fromWalker !== "" && fromWalker !== "unknown") {
		return fromWalker;
	}
	return typeof ctx.cwd === "string" && ctx.cwd !== "" && ctx.cwd !== "unknown"
		? ctx.cwd
		: null;
}

/** The git invocation this bash ref carries, if any. */
function gitCallOf(ctx: PredicateContext): GitCall | null {
	const words = (ctx.input.args ?? []).map(wordValue);
	return parseGitCall(words, effectiveCwd(ctx));
}

/**
 * Is the repo on main? The walker's branch tracker answers when the
 * chain itself contains a checkout; otherwise one rev-parse probe
 * decides. Anything unresolvable is "not on main" (fail closed).
 */
async function isOnMain(ctx: PredicateContext, repo: string): Promise<boolean> {
	const tracked = ctx.walkerState?.branch;
	if (
		typeof tracked === "string" &&
		tracked !== "" &&
		tracked !== "unknown" &&
		tracked !== NO_CHECKOUT_IN_CHAIN
	) {
		return tracked === MAIN;
	}
	try {
		const result = await ctx.exec(
			"git",
			["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"],
			{ timeoutMs: 5000 },
		);
		if (result.exitCode !== 0) return false;
		return result.stdout.trim() === MAIN;
	} catch {
		return false;
	}
}

/** The `-c` payload of a shell-wrapper ref, or null when this ref is not one. */
function wrapperScanOf(ctx: PredicateContext): PayloadScan | null {
	const basename = ctx.input.basename;
	if (basename === undefined || !SHELL_WRAPPERS.has(basename)) return null;
	const payload = wrapperPayload((ctx.input.args ?? []).map(wordValue));
	if (payload === null) return null;
	return scanPayload(payload, effectiveCwd(ctx));
}

/** The primary a bash ref targets, for the block message. */
function primaryOfCall(ctx: PredicateContext): string | null {
	const wrapped = wrapperScanOf(ctx);
	if (wrapped !== null) return wrapped.primary;
	const call = gitCallOf(ctx);
	if (call === null || call.repo === null) return null;
	return primaryOfPath(call.repo);
}

/** The primary a file-surface call targets, for the block message. */
function primaryOfWrite(ctx: PredicateContext): string | null {
	const path = typeof ctx.input.path === "string" ? ctx.input.path : "";
	if (path === "") return null;
	const base = typeof ctx.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : "/";
	return primaryOfPath(isAbsolute(path) ? path : resolve(base, path));
}

export const primaryCheckoutGuardPlugin = {
	name: "primary-checkout-guard",
	// No cliDescriptors: `git` is declared by the git plugin (re-declaring
	// it only produces descriptor-collision warnings).
	predicates: {
		mutatesPrimaryCheckout: async (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			const wrapped = wrapperScanOf(ctx);
			if (wrapped !== null) {
				if (wrapped.mutates) return true;
				if (wrapped.ffOnly !== null) {
					return (await isOnMain(ctx, wrapped.ffOnly)) ? false : true;
				}
				return false;
			}
			const call = gitCallOf(ctx);
			if (call === null) return false;
			const kind = mutationKind(call.subcommand, call.rest);
			if (kind === null) return false;
			// Unresolvable repo: fail closed (the walker's onUnknown policy
			// turns this into a block).
			if (call.repo === null) return "unknown";
			const primary = primaryOfPath(call.repo);
			if (primary === null) return false;
			if (kind === "ff-only") return (await isOnMain(ctx, primary)) ? false : true;
			return true;
		},
		writesPrimaryCheckout: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			const path = typeof ctx.input.path === "string" ? ctx.input.path : "";
			if (path === "") return false;
			const base = typeof ctx.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : "/";
			const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
			const primary = primaryOfPath(abs);
			if (primary === null) return false;
			return !isLocalScratch(abs, primary);
		},
	},
};

/**
 * The owner's message, with the concrete primary and a copy-pasteable
 * worktree command substituted in. Falls back to the generic `<primary>`
 * placeholder when the path could not be resolved.
 */
function reason(ctx: PredicateContext): string {
	const primary =
		(ctx.tool === "bash" ? primaryOfCall(ctx) : primaryOfWrite(ctx)) ??
		`${PRIMARY_ROOT}/pc-<name>`;
	const name = primary.startsWith(PRIMARY_ROOT + "/")
		? primary.slice(PRIMARY_ROOT.length + 1)
		: "pc-<name>";
	return `the primary checkout stays on main: edit in a worktree (git -C ${primary} worktree add /data/tmp/wt/${name}-<slug> -b <branch>). ${primary} is the primary checkout of ${name}: it is never edited, only fast-forwarded to origin/main after a merge. Create or reuse a worktree and do the work there.`;
}

export const primaryCheckoutRules = [
	{
		name: "no-primary-checkout-git",
		tool: "bash" as const,
		// bash / sh: the `-c` payload scan (the walker does not thread a
		// `cd` through a subshell, so the wrapper is re-read here).
		command: ["git", "bash", "sh"],
		when: { mutatesPrimaryCheckout: true },
		reason,
	},
	{
		// `pattern` cannot see the session cwd, so it must not pre-filter:
		// the predicate resolves the path and does the exact primary check.
		name: "no-primary-checkout-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: /^/,
		when: { writesPrimaryCheckout: true },
		reason,
	},
	{
		name: "no-primary-checkout-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { writesPrimaryCheckout: true },
		reason,
	},
];
