// SPDX-License-Identifier: MIT
/**
 * Main-ref write guard - blocks git plumbing that rewrites main/master.
 *
 * Incident 2026-11-05: an auto-distill agent landed its work by pointing a
 * vault's local main at its private landing-branch tip with
 * 'git update-ref refs/heads/main <sha>'. The write had an empty reflog
 * message, ignored fast-forward-ness, left the main worktree's index and
 * files untouched, and orphaned another session's unpushed commit.
 *
 * The shipped git plugin rules cover 'commit', 'push' (every force form,
 * '+' refspecs included) and 'reset --hard', but none of them describes a
 * ref write: update-ref, branch -f, checkout -B, switch -C and a forced
 * fetch refspec all passed steering untouched.
 *
 * Scope split with the shipped git-plugin rails:
 *   - this rule owns the ref-writing verbs no shipped rule describes:
 *     update-ref, branch -f/-M/-m, checkout -B, switch -C, a forced fetch
 *     refspec and symbolic-ref;
 *   - 'reset --hard' (aimed at main/master or anywhere else) is already
 *     refused by the shipped no-hard-reset rule;
 *   - force pushes are already refused by the shipped no-force-push rule
 *     (every force form, '+' refspecs included).
 *
 * Matching is on the parsed argv (ctx.input.args), never on the raw
 * command string, so a commit message or a markdown code sample that
 * merely CONTAINS 'git update-ref refs/heads/main' is not blocked.
 *
 * Known gaps (textual layer, not a substitute for review):
 *   - 'branch -m <new>' while on main renames main away; the source branch
 *     is implicit and not statically known here, so this rule cannot name
 *     it.
 *   - A shell wrapper that rebuilds the command internally
 *     ('bash -c "$CMD"') is not visible.
 */

import type { PredicateShape } from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		writesMainRef: PredicateShape<boolean>;
	}
}

const DEFAULT_BRANCH_NAMES = new Set(["main", "master"]);
const EMPTY_FLAGS: ReadonlySet<string> = new Set();

/** git global options whose following word is a value, not a subcommand. */
const GLOBAL_VALUE_FLAGS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
	"--config-env",
	"--attr-source",
]);

/** git branch options that consume the next word (keeps read queries read-only). */
const BRANCH_VALUE_FLAGS = new Set([
	"-u",
	"--set-upstream-to",
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--sort",
	"--format",
	"--column",
	"--abbrev",
]);

/** git update-ref / symbolic-ref options that consume the next word. */
const MESSAGE_VALUE_FLAGS = new Set(["-m", "--message"]);

/** Read the quote-resolved word text pi-steering exposes for a bash arg. */
function wordValue(word: unknown): string {
	const w = word as { value?: unknown; text?: unknown } | null | undefined;
	if (typeof w?.value === "string") return w.value;
	if (typeof w?.text === "string") return w.text;
	return typeof word === "string" ? word : "";
}

/**
 * True when a ref argument names the shared default branch. HEAD and @ are
 * treated as a match: they resolve to the checked-out branch, so an
 * update-ref on either can rewrite main. Remote-tracking refs
 * (refs/remotes/...) are not the local branch and do not match.
 */
function isDefaultBranchTarget(word: string): boolean {
	if (word === "HEAD" || word === "@") return true;
	if (word.startsWith("refs/remotes/")) return false;
	const short = word.replace(/^refs\//, "").replace(/^heads\//, "");
	return DEFAULT_BRANCH_NAMES.has(short);
}

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

/** Split 'git <global flags> <subcommand> <rest>'; global flags are skipped. */
function splitSubcommand(
	words: readonly string[],
): { name: string; rest: string[] } | null {
	let i = 0;
	while (i < words.length) {
		const word = words[i] ?? "";
		if (word === "--") {
			i += 1;
			break;
		}
		if (!isFlag(word)) break;
		if (word.includes("=")) {
			i += 1; // --git-dir=/x
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.has(word)) {
			i += 2; // -C /x
			continue;
		}
		if (/^-[Cc].+/.test(word)) {
			i += 1; // -C/x, -cuser.name=x
			continue;
		}
		i += 1; // other global flag
	}
	const name = words[i];
	if (name === undefined || name === "") return null;
	return { name, rest: words.slice(i + 1) };
}

/** Non-flag words, skipping the values of the given consuming flags. */
function operands(
	words: readonly string[],
	valueFlags: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] ?? "";
		if (word === "--") {
			out.push(...words.slice(i + 1));
			break;
		}
		if (isFlag(word)) {
			if (!word.includes("=") && valueFlags.has(word)) i += 1;
			continue;
		}
		out.push(word);
	}
	return out;
}

/** True when one word carries the short flag, including bundles like -vf. */
function hasShortFlag(words: readonly string[], letter: string): boolean {
	return words.some(
		(word) => /^-[A-Za-z]+$/.test(word) && word.slice(1).includes(letter),
	);
}

/**
 * Value of the first occurrence of any named flag ('-B main', '-Bmain',
 * '--force-create=main'), or null when absent.
 */
function flagTarget(
	words: readonly string[],
	names: readonly string[],
): string | null {
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] ?? "";
		for (const name of names) {
			if (word === name) return words[i + 1] ?? null;
			if (word.startsWith(name + "=")) return word.slice(name.length + 1);
			if (word.startsWith(name) && word.length > name.length) {
				return word.slice(name.length);
			}
		}
	}
	return null;
}

/** Pure matcher: does this git argv write the default branch ref? */
export function writesMainRef(words: readonly string[]): boolean {
	const parsed = splitSubcommand(words);
	if (parsed === null) return false;
	const { name, rest } = parsed;

	switch (name) {
		case "update-ref": {
			// Bulk --stdin updates carry their refs on stdin: unverifiable here.
			if (rest.includes("--stdin")) return true;
			const refs = operands(rest, MESSAGE_VALUE_FLAGS);
			return refs.length > 0 && isDefaultBranchTarget(refs[0] ?? "");
		}
		case "branch": {
			// -f/--force re-points an existing branch; -m/-M/--move renames it,
			// which deletes the old ref.
			const rewrites =
				rest.includes("--force") ||
				rest.includes("--move") ||
				hasShortFlag(rest, "f") ||
				hasShortFlag(rest, "M") ||
				hasShortFlag(rest, "m");
			if (!rewrites) return false;
			return operands(rest, BRANCH_VALUE_FLAGS).some(isDefaultBranchTarget);
		}
		case "checkout": {
			// -B force-creates/resets the named branch.
			const target = flagTarget(rest, ["-B"]);
			return target !== null && isDefaultBranchTarget(target);
		}
		case "switch": {
			// -C / --force-create: same force semantics as checkout -B.
			const target = flagTarget(rest, ["-C", "--force-create"]);
			return target !== null && isDefaultBranchTarget(target);
		}
		case "fetch": {
			// A forced refspec ('+src:dst') writes dst without the
			// fast-forward check. Plain refspecs are allowed: the vault hook
			// still refuses a non-fast-forward result.
			return operands(rest, EMPTY_FLAGS).some((word) => {
				const match = /^\+[^:]*:(.+)$/.exec(word);
				return match !== null && isDefaultBranchTarget(match[1] ?? "");
			});
		}
		case "symbolic-ref": {
			// Turning a default-branch ref into a symbolic ref (or moving it)
			// rewrites what main resolves to.
			const refs = operands(rest, MESSAGE_VALUE_FLAGS);
			return refs.length > 0 && isDefaultBranchTarget(refs[0] ?? "");
		}
		default:
			return false;
	}
}

export const refWriteGuardPlugin = {
	name: "ref-write-guard",
	predicates: {
		writesMainRef: (
			args: unknown,
			ctx: {
				input?: { args?: ReadonlyArray<{ value?: unknown; text?: unknown }> };
			},
		) => {
			if (args !== true) return false;
			const words = (ctx?.input?.args ?? []).map(wordValue);
			return writesMainRef(words);
		},
	},
};

const REASON =
	"Do not rewrite main/master with git plumbing (update-ref, branch -f, checkout -B, switch -C, a forced fetch refspec, symbolic-ref). Plumbing writes bypass the fast-forward check and can orphan another session's unpushed commits. Land the change with 'git merge <source>' (or 'git pull --no-rebase'), or do the work on a feature branch and merge it. 'reset --hard' and 'push --force' are already refused by their own rules.";

export const refWriteGuardRules = [
	{
		name: "no-main-ref-write",
		tool: "bash" as const,
		command: "git",
		when: { writesMainRef: true },
		reason: REASON,
	},
];
