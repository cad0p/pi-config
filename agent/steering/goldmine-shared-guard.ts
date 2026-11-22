// SPDX-License-Identifier: MIT
/**
 * Goldmine shared-checkout guard — one vault checkout, many concurrent
 * sessions: never sweep another session's worktree with an autostash,
 * and never commit (or stage) paths you do not own.
 *
 * Measured 2026-11-22 in /home/pier/personal/github/Goldmine.
 *   1. 22:51:49Z an agent ran a pull with `--autostash` there. The
 *      autostash swept another session's in-progress edit of
 *      personal/github/pc-control/prs/2026-11-22-pr-alias-refuse-
 *      uppercase.md, reverting it on disk until the pop; the pop
 *      conflicted. The owning session saw its note "silently reverted"
 *      and had to re-apply it. Two autostash entries were left behind.
 *   2. 22:57:10Z another agent ran `git commit` with no pathspec
 *      (908eacf95e, "pc-host #1549 …") and swept that other session's
 *      STAGED edit of the same note into its own commit, under the
 *      wrong message.
 * Nothing was lost that time, by luck. Both commands are refused now.
 *
 * Refused, when the effective repo is the vault (its directory or
 * below):
 *   - R1 `goldmine-no-autostash`: `git pull|rebase --autostash`,
 *     `git -c rebase.autoStash=true pull|rebase`, a bare `git stash`
 *     (no subcommand, flags only), `git stash push` with no pathspec
 *     and `git stash save` (it takes a message, never a pathspec);
 *   - R2 `goldmine-commit-needs-pathspec`: `git commit` without
 *     paths after `--` (and without `--only` plus paths), any
 *     `git commit -a|--all`, and the sweeping stage verbs
 *     `git add -A` / `git add --all` / `git add .`.
 * Everything else is untouched: `git pull --no-rebase origin main`,
 * `git fetch`, `git status`, `git commit -m … -- <paths>`,
 * `git add -- <paths>`, `git stash list|show|drop|pop|apply|branch|create|store`
 * and a pathspec-scoped `git stash push -- <paths>`. The sanctioned
 * vault helpers stay allowed by construction: gm-commit.sh commits
 * through `git commit-tree` (another subcommand) and never pulls,
 * stashes or stages, and napkin-distill shells no git at all.
 *
 * How the target repo is resolved — never by re-parsing the shell for
 * the common case. The walker's per-ref cwd already models a
 * `cd <dir> &&` prefix (so `cd <vault> && git commit -a` resolves),
 * and `git -C <dir>` on top, cumulatively, through the shared
 * `parseGitCall` (same resolution as the primary-checkout and
 * worktree guards). A `bash -c` / `sh -c` payload is re-read here because
 * the walker starts a payload's refs from the OUTER cwd: the inner ref
 * still fires when no `cd` moves it, and this scan catches the
 * `cd <vault> && …` payload the inner ref cannot place.
 *
 * Known gaps (deliberately out of scope, pinned in the test file):
 *   - an unresolvable repo (`cd "$VAR" && git commit -a`, a command
 *     substitution, no `-C`) counts as NOT the vault: this rule is a
 *     shared-checkout guard, not a repo-wide git policy, so it never
 *     blocks a git command it cannot place. Use `-C <vault>` or an
 *     absolute `cd`.
 *   - `git add -u` / `git add -p` and a commit pathspec written
 *     WITHOUT `--` (`git commit -m msg note.md`, the implicit
 *     pathspec form) are refused as unscoped — the fix is the explicit
 *     `--` form, so the refusal is the lesson, not a gap;
 *   - `git stash clear` (it destroys stash entries but sweeps no
 *     file) and a conflicted `git stash pop`;
 *   - `--git-dir` / `--work-tree` pointing at the vault from
 *     elsewhere, a wrapper other than bash / sh (`zsh`, `dash`,
 *     `env bash -c`), and a script that runs git internally —
 *     steering only ever sees the agent's own commands.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateContext,
	PredicateShape,
} from "@cad0p/pi-steering";
import { isAbsolute, resolve } from "node:path";
import { parseGitCall } from "./primary-checkout-guard.ts";
import { VAULT, under, wrapperPayload } from "./worktree-guard.ts";

declare global {
	interface PiSteeringPredicates {
		/**
		 * `when.goldmineAutostashOrBareStash` — R1: this bash ref (or the
		 * git call its `sh -c` payload makes) autostashes or bare-stashes
		 * inside the Goldmine vault. Boolean leaf.
		 */
		goldmineAutostashOrBareStash: PredicateShape<boolean>;
		/**
		 * `when.goldmineCommitWithoutPathspec` — R2: this bash ref (or
		 * the git call its `sh -c` payload makes) commits or stages
		 * without naming its own paths inside the Goldmine vault.
		 * Boolean leaf.
		 */
		goldmineCommitWithoutPathspec: PredicateShape<boolean>;
	}
}

/** Which rail a Goldmine command violates. */
export type GoldmineBreach = "autostash" | "commit";

/** Shell wrappers whose `-c` payload is re-read (the same pair the other guards use). */
const SHELL_WRAPPERS = new Set(["bash", "sh"]);

/**
 * `rebase.autoStash=true` — the config form of `--autostash`. Only
 * truthy spellings count; `=false` is the fix, not the breach.
 */
const AUTO_STASH_CONFIG = /^rebase\.autostash=(?:true|yes|on|1)$/i;

/** git global options whose following word is a value (mirrors the shared parser). */
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

/** Flags whose next word is a value, per verb — never a path, never a breach. */
const COMMIT_VALUE_FLAGS = new Set([
	"-m",
	"--message",
	"-F",
	"--file",
	"-C",
	"--reuse-message",
	"-c",
	"--reedit-message",
	"-t",
	"--template",
	"--author",
	"--date",
	"--cleanup",
	"--fixup",
	"--squash",
	"-S",
	"--gpg-sign",
]);

/** `git stash push`'s one value flag: the message, never a pathspec. */
const STASH_VALUE_FLAGS = new Set(["-m", "--message"]);

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

/** One verb's argv split: flags, positional paths, and the post-`--` paths. */
export interface ArgScan {
	/** Flag tokens seen before `--` (values already skipped). */
	flags: string[];
	/** Non-flag words before `--`, values already skipped. */
	paths: string[];
	/** `--` was present. */
	dashDash: boolean;
	/** Words after `--` — an explicit pathspec, verbatim. */
	afterDashDash: string[];
}

/**
 * Split one verb's argv without re-parsing the shell: `valueFlags` are
 * the verb's declared consuming flags, so a `-m "all files"` message is
 * never mistaken for a path or for a flag.
 */
export function scanArgs(
	rest: readonly string[],
	valueFlags: ReadonlySet<string> = new Set(),
): ArgScan {
	const scan: ArgScan = {
		flags: [],
		paths: [],
		dashDash: false,
		afterDashDash: [],
	};
	for (let i = 0; i < rest.length; i += 1) {
		const word = rest[i] ?? "";
		if (word === "--") {
			scan.dashDash = true;
			scan.afterDashDash = rest.slice(i + 1).filter((w) => w !== "");
			return scan;
		}
		if (isFlag(word)) {
			scan.flags.push(word);
			if (valueFlags.has(word)) i += 1; // skip the value
			continue;
		}
		scan.paths.push(word);
	}
	return scan;
}

/** A short bundle carrying `a` (`-a`, `-am`, `-av`) — git commit's `--all`. */
function bundlesAll(word: string): boolean {
	return /^-[A-Za-z]+$/.test(word) && word.includes("a");
}

/** A short bundle carrying `A` (`-A`, `-Av`) — git add's `--all`. */
function bundlesAddAll(word: string): boolean {
	return /^-[A-Za-z]+$/.test(word) && word.includes("A");
}

/** Pathspecs that name the whole checkout rather than one session's files. */
const TOP_LEVEL_PATHSPECS = new Set([".", "./", ":/", ":(top)"]);

/**
 * R1 — does this `git pull` / `rebase` / `stash` call autostash or
 * bare-stash? `globals` is the argv prefix before the subcommand, where
 * `git -c <key>=<value>` lives.
 */
export function autostashBreach(
	subcommand: string,
	rest: readonly string[],
	globals: readonly string[],
): GoldmineBreach | null {
	if (subcommand === "pull" || subcommand === "rebase") {
		if (rest.includes("--autostash")) return "autostash";
		if (namesAutoStashConfig(globals)) return "autostash";
		return null;
	}
	if (subcommand !== "stash") return null;
	const scan = scanArgs(rest, STASH_VALUE_FLAGS);
	const verb = scan.paths[0];
	// `git stash` with no subcommand word (`git stash`, `git stash -u`).
	if (verb === undefined) return "autostash";
	// `git stash save <msg>` takes a message, never a pathspec.
	if (verb === "save") return "autostash";
	if (verb !== "push") return null;
	// A pathspec — after `--`, or as a positional word after `push`.
	if (scan.afterDashDash.length > 0) return null;
	if (scan.paths.length > 1) return null;
	return "autostash";
}

/** Does a global-flag prefix set `rebase.autoStash=true`? */
export function namesAutoStashConfig(globals: readonly string[]): boolean {
	for (let i = 0; i < globals.length; i += 1) {
		const word = globals[i] ?? "";
		if (word === "-c" || word === "--config-env") {
			if (AUTO_STASH_CONFIG.test(globals[i + 1] ?? "")) return true;
			i += 1;
			continue;
		}
		if (word.startsWith("-c") && word.length > 2) {
			if (AUTO_STASH_CONFIG.test(word.slice(2))) return true;
			continue;
		}
		if (/^--config-env=rebase\.autostash=/i.test(word)) return true;
		if (GIT_GLOBAL_VALUE_FLAGS.has(word)) i += 1;
	}
	return false;
}

/**
 * R2 — does this `git commit` / `git add` call name no paths of its
 * own? `--` + paths and `--only` + paths are the two sanctioned forms.
 */
export function unscopedCommitBreach(
	subcommand: string,
	rest: readonly string[],
): GoldmineBreach | null {
	if (subcommand === "commit") {
		const scan = scanArgs(rest, COMMIT_VALUE_FLAGS);
		// `-a` / `--all` stages every tracked file in the checkout.
		if (scan.flags.some((f) => f === "--all" || bundlesAll(f))) return "commit";
		if (scan.afterDashDash.length > 0) return null;
		const only = scan.flags.some((f) => f === "--only" || f === "-o");
		if (only && scan.paths.length > 0) return null;
		return "commit";
	}
	if (subcommand === "add") {
		const scan = scanArgs(rest);
		if (scan.flags.some((f) => f === "--all" || bundlesAddAll(f))) return "commit";
		if (scan.paths.some((p) => TOP_LEVEL_PATHSPECS.has(p))) return "commit";
		return null;
	}
	return null;
}

/** Which rail, if any, this one git invocation breaks inside the vault. */
export function goldmineBreach(
	subcommand: string,
	rest: readonly string[],
	globals: readonly string[],
): GoldmineBreach | null {
	return (
		autostashBreach(subcommand, rest, globals) ??
		unscopedCommitBreach(subcommand, rest)
	);
}

/** Is this resolved repo path the vault (or below it)? */
export function isVaultPath(path: string | null): boolean {
	if (path === null) return false;
	return under(resolve(path), VAULT);
}

/**
 * The breach one `git <args>` suffix makes in the vault, or null.
 * `baseCwd` is the walker's effective cwd for this ref; `null` (an
 * unresolvable `cd`) means the call cannot be placed and is left alone.
 */
export function goldmineGitBreach(
	words: readonly string[],
	baseCwd: string | null,
): GoldmineBreach | null {
	const call = parseGitCall(words, baseCwd);
	if (call === null || !isVaultPath(call.repo)) return null;
	// The subcommand sits right before `rest`; everything left of it is
	// the global-flag prefix (`git -c … <verb>`).
	const subcommandAt = words.length - call.rest.length - 1;
	const globals = words.slice(0, Math.max(subcommandAt, 0));
	return goldmineBreach(call.subcommand, call.rest, globals);
}

/** Naive shell tokenizer for a wrapper payload: whitespace split, quotes stripped. */
function payloadWords(segment: string): string[] {
	const out: string[] = [];
	for (const token of segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
		out.push(token.replace(/^["']|["']$/g, ""));
	}
	return out;
}

/**
 * The breach a `bash -c` / `sh -c` payload makes in the vault, with
 * its own `cd` threaded (the walker starts payload refs from the outer
 * cwd, so a payload `cd <vault> && git …` is invisible to it).
 */
export function payloadBreach(
	payload: string,
	baseCwd: string | null,
): GoldmineBreach | null {
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
		const breach = goldmineGitBreach(words.slice(1), base);
		if (breach !== null) return breach;
	}
	return null;
}

/** The effective cwd of a bash ref ("unknown" when the walker bailed). */
function effectiveCwd(ctx: PredicateContext): string | null {
	const fromWalker = ctx.walkerState?.cwd;
	if (
		typeof fromWalker === "string" &&
		fromWalker !== "" &&
		fromWalker !== "unknown"
	) {
		return fromWalker;
	}
	return typeof ctx.cwd === "string" && ctx.cwd !== "" && ctx.cwd !== "unknown"
		? ctx.cwd
		: null;
}

/** The breach this bash ref makes in the vault, or null. */
function breachOf(ctx: PredicateContext): GoldmineBreach | null {
	if (ctx.input?.tool !== "bash") return null;
	const words = (ctx.input.args ?? []).map(wordValue);
	const base = effectiveCwd(ctx);
	const basename = ctx.input.basename;
	if (basename !== undefined && SHELL_WRAPPERS.has(basename)) {
		const payload = wrapperPayload(words);
		if (payload !== null) return payloadBreach(payload, base);
	}
	if (basename !== "git") return null;
	return goldmineGitBreach(words, base);
}

/** R1's predicate — the ref (or its payload) autostashes or bare-stashes the vault. */
export const goldmineAutostashOrBareStash = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		return (breachOf(ctx) === "autostash") === expected;
	},
);

/** R2's predicate — the ref (or its payload) commits or stages without its own paths. */
export const goldmineCommitWithoutPathspec = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		return (breachOf(ctx) === "commit") === expected;
	},
);

/** The owner's R1 message, verbatim (brief goldmine-shared-guard, 2026-11-22). */
const AUTOSTASH_REASON =
	"Goldmine is shared by concurrent sessions: never stash or autostash others' work. To sync: commit ONLY your own paths (git commit -- <your files>), then git pull --no-rebase origin main (a merge leaves others' dirty files untouched; if git refuses because one of YOUR files conflicts, commit it first); if another session's dirty file blocks the merge, leave the push for later and say so.";

/** The owner's R2 message, verbatim (brief goldmine-shared-guard, 2026-11-22). */
const COMMIT_REASON =
	"commit only your own files: git commit -m '<msg>' -- <path> [...]; other sessions have staged work in this checkout.";

export const goldmineSharedGuardRules = [
	{
		name: "goldmine-no-autostash",
		tool: "bash" as const,
		// bash / sh: the `-c` payload scan (a payload `cd` is not threaded
		// by the walker, so the wrapper is re-read here).
		command: ["git", "bash", "sh"],
		when: { goldmineAutostashOrBareStash: true },
		reason: AUTOSTASH_REASON,
	},
	{
		name: "goldmine-commit-needs-pathspec",
		tool: "bash" as const,
		command: ["git", "bash", "sh"],
		when: { goldmineCommitWithoutPathspec: true },
		reason: COMMIT_REASON,
	},
];

export const goldmineSharedGuardPlugin = {
	name: "goldmine-shared-guard",
	// No cliDescriptors: `git` (git plugin) and `bash` / `sh`
	// (agent-config-guard) are declared elsewhere; re-declaring only
	// produces descriptor-collision warnings.
	predicates: { goldmineAutostashOrBareStash, goldmineCommitWithoutPathspec },
} as const satisfies Plugin;
