// SPDX-License-Identifier: MIT
/**
 * queue-land-nudge — a --mode local merge of the repo's merge queue entry
 * is refused; the queue's own turn lands it instead.
 *
 * Why this exists. Sessions land a PR as a pair:
 *   tools/merge-pr.sh gate <owner/repo> <pr> <head>
 *   tools/merge-pr.sh --mode local <owner/repo> <pr> <head>
 * The gate binds to the pushed head, and --mode local refuses a head that
 * does not contain current origin/main ("stale main"), so every move of
 * main costs a re-absorb, a re-gate, and often a trio. The merge queue's
 * turn — tools/merge-pr.sh queue land <owner/repo> — gates the REBUILT
 * main+PR candidate instead and lands THAT, so a main move costs nothing.
 * It has been live since pc-host#836 (2026-11-10) and nobody uses it,
 * largely because a stale refusal message told sessions it did not exist.
 * This rail makes the pair's cost visible at the moment the pair is typed.
 *
 * Refused, exactly when BOTH hold:
 *   1. the ref is a local-path merge: --mode local (or --mode=local) on
 *      merge-pr.sh, for a shape that LANDS — the implicit merge
 *      (merge-pr.sh <repo> <pr> <head>), an explicit "merge" subcommand,
 *      or "train" (every <pr>:<head> piece is checked; one queued entry
 *      refuses the batch, because the batch has one gate and the turn is
 *      where it belongs). The shell-wrapper spelling the merge guides use
 *      — `bash tools/merge-pr.sh --mode local …`, options such as
 *      `bash -euo pipefail` included — is read THROUGH the wrapper: the
 *      engine hands this ref only `bash` and its argv, so the predicate
 *      finds the helper's path as the wrapper's script operand and reads
 *      the rest as the helper's own. The wrapper's env prefix is the
 *      helper's (bash passes it to the script), so the escape and the
 *      state root resolve there too;
 *   2. a PR the ref names is this repo's queue entry: the file
 *      <state root>/queue/<owner>--<repo>/entries/<pr>.json exists and its
 *      .pr equals the argument. The PR is the entry whether or not it is
 *      the lease holder: an entry is the PR's place in the queue, and
 *      --mode local refuses any queued PR that is not the head anyway.
 *
 * State root (mirrors tools/merge-pr.sh): $PC_MERGE_STATE_ROOT if set,
 * else ~/.local/state/pc-merge. The repo key mirrors pcm_repo_key:
 * owner/repo with "/" -> "--" and "." -> "_". The variable is read from
 * the ref's env prefix first (bash applies a prefix to the direct child,
 * so it wins), then the chain's exported value, then the session env.
 *
 * Allowed without a message:
 *   - --mode local for a PR that is not a queue entry (there is no turn to
 *     prefer: an unqueued PR, one already queue left/parked, another repo);
 *   - every other shape of merge-pr.sh: gate, train-gate, absorb,
 *     absorb-check, queue add|status|wait|renew|preview|leave|land,
 *     dispatch, rounds, live-proof, live-surface, bypass, --help/-h,
 *     --mode bootstrap, and train without --mode local;
 *   - any ref carrying PC_MERGE_LOCAL_OK=1 as an env prefix (or an
 *     exported chain variable): the VISIBLE escape. It is for a
 *     live-surface PR whose live proof the turn cannot perform, a wedged
 *     queue, or an owner instruction. It must appear in the command so it
 *     lands in the transcript, and the merge note says why.
 *
 * FAIL OPEN, by design: a missing state root, a missing entries directory,
 * an unreadable entry file or unparsable JSON all ALLOW the command. The
 * rail is a nudge on state a helper owns; a wrong block here would wedge
 * every merge on the machine. That is the OPPOSITE policy from
 * merge-guard.ts, which fails closed (an unresolvable repo visibility is
 * treated as private): merge-guard refuses a merge that must not happen,
 * while a missed nudge costs one stale re-gate, not a merge.
 *
 * Known gaps (pinned in the test file):
 *   - the helper defaults --mode to "local", so a bare
 *     merge-pr.sh <repo> <pr> <head> IS a local merge and is NOT refused
 *     here: this rail keys on the explicit --mode local the brief names
 *     (the visible flag is what the session typed and what the transcript
 *     shows). Flip the pin to block it if the default should count.
 *   - the documented REPO/PR/HEAD environment form names its PR in an env
 *     assignment, not in the ref's operands, so the rail reads no PR and
 *     allows the command.
 *   - a dynamic operand (--mode "$M", "$PR", a $(...) substitution) does
 *     not resolve to "local" / digits / owner-repo shape; allowed.
 *   - the message names queue land's one-operand shape (merge-pr.sh's
 *     run_queue_land takes exactly <repo> and lands its queue head, plus
 *     every follower once pc-host#898 lands), not a <repo> <pr> form the
 *     helper does not accept: a refusal that hands over a usage error
 *     would repeat the stale-message bug this rail exists to fix.
 *   - the escape is read from the helper ref's own prefix (or a chain
 *     export), or the shell wrapper's when the helper is its script. An
 *     `env`/`sudo` wrapper is a separate ref whose assignments the engine
 *     does not model onto the inner merge-pr.sh ref: its PC_MERGE_LOCAL_OK
 *     and even its PC_MERGE_STATE_ROOT are invisible there, so the rail
 *     reads the session env instead (pinned in the tests). Use the plain
 *     prefix or an export. A script that calls merge-pr.sh internally is
 *     not read at all.
 *   - the entry check is a snapshot: an entry added between the verdict
 *     and the helper's own run is the helper's stale/head refusal to make.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename as pathBasename, join } from "node:path";
import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateContext,
	PredicateShape,
} from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		/** `when.localMergeOfQueueEntry` — a --mode local land of a queued PR. */
		localMergeOfQueueEntry: PredicateShape<boolean>;
	}
}

/** The one basename this rail routes (pc-host's helper). */
const MERGE_PR = "merge-pr.sh";

/** The visible escape: a prefix assignment or an exported chain variable. */
export const LOCAL_OK_ENV = "PC_MERGE_LOCAL_OK";

/** merge-pr.sh's state-root override, read at the ref (see the header). */
export const STATE_ROOT_ENV = "PC_MERGE_STATE_ROOT";

/** Shell wrappers whose script operand is read as merge-pr.sh's argv. */
const SHELLS = new Set(["bash", "sh"]);

/** Short shell options that consume the next word (bundles included). */
const SHELL_VALUE_LETTERS = new Set(["c", "o", "O"]);

/** Shapes that do NOT land: the rail stays out of them entirely. */
const NON_LAND_SUBCOMMANDS = new Set([
	"gate",
	"train-gate",
	"bypass",
	"live-proof",
	"live-surface",
	"dispatch",
	"absorb-check",
	"absorb",
	"rounds",
	"queue",
]);

/** merge-pr.sh's value-taking flags (mirrors the descriptor below). */
const VALUE_FLAGS = new Set([
	"--mode",
	"--repo",
	"--main",
	"--live",
	"--reason",
	"--brief",
	"--estimate",
	"--timeout",
	"--unit",
	"--pid",
]);

/** A well-formed owner/repo argument. */
const REPO_ARG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A well-formed PR number argument. */
const PR_ARG = /^[1-9][0-9]*$/;

interface WordLike {
	value?: string;
	text?: string;
}

/** What this rail reads off a predicate context (bash refs only). */
interface EnvCtx {
	input?: { envAssignments?: ReadonlyArray<WordLike> };
	walkerState?: { env?: ReadonlyMap<string, string> };
}

/** A repo + PR pair a landing shape names. */
export interface LandTarget {
	repo: string;
	pr: string;
}

/** A word's resolved text, or "" (the walker's `value` is preferred). */
function wordText(word: WordLike | undefined): string {
	return word?.value ?? word?.text ?? "";
}

/** A word's basename, unquoted (the helper is invoked by a repo-relative path). */
function wordBasename(word: string): string {
	return pathBasename(word.trim().replace(/^["']|["']$/g, ""));
}

/**
 * Words a shell option consumes: `-c`/`-o`/`-O` take the next word, a
 * bundle that contains one of them (`-euo pipefail`, `-ec 'cmd'`) does too,
 * and every other long/short option is self-contained.
 */
function shellOptionSkip(word: string): number {
	if (!word.startsWith("-") || word === "-") return 0;
	if (word.startsWith("--")) return 0;
	if (word.length <= 2) return 0;
	for (const letter of word.slice(1)) {
		if (SHELL_VALUE_LETTERS.has(letter)) return 1;
	}
	return 0;
}

/**
 * The argv this ref hands merge-pr.sh: its own, or — for a shell wrapper —
 * the words after the script operand. Null when this ref invokes nothing
 * that looks like the helper (every other shape, and the unreadable ones).
 */
function helperArgs(ctx: {
	input?: {
		basename?: string;
		args?: ReadonlyArray<WordLike>;
	};
}): ReadonlyArray<WordLike> | null {
	const words = ctx.input?.args ?? [];
	const basename = ctx.input?.basename;
	if (basename === MERGE_PR) return words;
	if (basename === undefined || !SHELLS.has(basename)) return null;
	for (let i = 0; i < words.length; i++) {
		const word = wordText(words[i]).trim();
		if (word === "") continue;
		if (word.startsWith("-")) {
			i += shellOptionSkip(word);
			continue;
		}
		return wordBasename(word) === MERGE_PR ? words.slice(i + 1) : null;
	}
	return null;
}

/**
 * Subcommand + operands of the ref. Flags are skipped (a glued
 * --flag=value is one word), and the value of a known value-taking flag is
 * skipped too, so `--mode local cad0p/pc-host 12 abcd` reads as
 * [cad0p/pc-host, 12, abcd].
 */
function positionals(ctx: {
	input?: { args?: ReadonlyArray<WordLike> };
}): string[] {
	const out: string[] = [];
	const words = ctx.input?.args ?? [];
	for (let i = 0; i < words.length; i++) {
		const value = wordText(words[i]).trim();
		if (value === "") continue;
		if (value.startsWith("-")) {
			if (VALUE_FLAGS.has(value)) i++;
			continue;
		}
		out.push(value);
	}
	return out;
}

/** Does the ref carry any of these flag words? */
function hasFlag(
	ctx: { input?: { args?: ReadonlyArray<WordLike> } },
	flags: ReadonlySet<string>,
): boolean {
	for (const word of ctx.input?.args ?? []) {
		const value = wordText(word).trim().replace(/^["']|["']$/g, "");
		if (flags.has(value)) return true;
	}
	return false;
}

/** Help flags: the helper prints usage and lands nothing. */
const HELP_FLAGS = new Set(["-h", "--help"]);

/** -h / --help anywhere: the helper prints usage and lands nothing. */
function informational(ctx: { input?: { args?: ReadonlyArray<WordLike> } }): boolean {
	return hasFlag(ctx, HELP_FLAGS);
}

/** The last --mode value (--mode local, --mode=local), or undefined. */
export function modeValue(ctx: {
	input?: { args?: ReadonlyArray<WordLike> };
}): string | undefined {
	let mode: string | undefined;
	const words = ctx.input?.args ?? [];
	for (let i = 0; i < words.length; i++) {
		const value = wordText(words[i]).trim().replace(/^["']|["']$/g, "");
		if (value === "--mode") {
			const next = wordText(words[i + 1]).trim().replace(/^["']|["']$/g, "");
			if (next !== "") mode = next;
			i++;
		} else if (value.startsWith("--mode=")) {
			mode = value.slice("--mode=".length).replace(/^["']|["']$/g, "");
		}
	}
	return mode;
}

/**
 * An env value as this ref would see it: the ref's own prefix wins (bash
 * applies a prefix to the direct child), then the chain's export, then the
 * session env the helper would inherit. Undefined when unset or empty.
 */
function envValue(ctx: EnvCtx, name: string): string | undefined {
	const prefix = new RegExp("^" + name + "=(.*)$");
	for (const word of ctx.input?.envAssignments ?? []) {
		const token = (word?.text ?? word?.value ?? "").trim();
		const m = prefix.exec(token);
		if (m === null) continue;
		const value = (m[1] ?? "").replace(/^["']|["']$/g, "").trim();
		if (value !== "") return value;
	}
	const fromChain = ctx.walkerState?.env?.get?.(name);
	if (typeof fromChain === "string" && fromChain.trim() !== "") {
		return fromChain.trim();
	}
	const fromSession = process.env[name];
	if (typeof fromSession === "string" && fromSession.trim() !== "") {
		return fromSession.trim();
	}
	return undefined;
}

/** The visible escape: PC_MERGE_LOCAL_OK=1 (the header says what for). */
export function localOkEscaped(ctx: EnvCtx): boolean {
	return envValue(ctx, LOCAL_OK_ENV) === "1";
}

/** The state root merge-pr.sh would use for this ref. */
export function stateRoot(ctx: EnvCtx): string {
	return (
		envValue(ctx, STATE_ROOT_ENV) ??
		join(process.env.HOME ?? homedir(), ".local", "state", "pc-merge")
	);
}

/** pcm_repo_key: owner/repo -> owner--repo, "." -> "_" (merge-pr.sh). */
export function repoKey(repo: string): string {
	return repo.split("/").join("--").split(".").join("_");
}

/** <state root>/queue/<repo key>/entries/<pr>.json. */
export function queueEntryPath(repo: string, pr: string, ctx: EnvCtx): string {
	return join(stateRoot(ctx), "queue", repoKey(repo), "entries", `${pr}.json`);
}

/**
 * The entry path when this PR is this repo's queue entry, else null.
 * Null (ALLOW) covers every unreadable state: no root, no entries dir, no
 * file, an unreadable file, unparsable JSON, or a .pr that is not this PR.
 * Fail-open is the header's explicit policy (a nudge, not a boundary).
 */
export function queueEntryFile(
	repo: string,
	pr: string,
	ctx: EnvCtx,
): string | null {
	const path = queueEntryPath(repo, pr, ctx);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let entry: unknown;
	try {
		entry = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof entry !== "object" || entry === null) return null;
	const filed = (entry as { pr?: unknown }).pr;
	if (typeof filed !== "string" && typeof filed !== "number") return null;
	return String(filed) === pr ? path : null;
}

/** A named pair that is well-formed enough to look up. */
function isLandTarget(target: LandTarget): boolean {
	return REPO_ARG.test(target.repo) && PR_ARG.test(target.pr);
}

/**
 * The repo + PR pairs a landing shape names, or [] for every shape that is
 * not a local-path land (and for operands this rail cannot read: fail open).
 */
export function landTargets(ops: readonly string[]): LandTarget[] {
	const first = ops[0];
	if (first === undefined) return []; // the REPO/PR/HEAD env form
	if (NON_LAND_SUBCOMMANDS.has(first)) return [];
	if (first === "train") {
		const repo = ops[1];
		if (repo === undefined) return [];
		return ops
			.slice(2)
			.map((piece) => ({ repo, pr: piece.split(":")[0] ?? "" }))
			.filter(isLandTarget);
	}
	const repo = first === "merge" ? ops[1] : ops[0];
	const pr = first === "merge" ? ops[2] : ops[1];
	if (repo === undefined || pr === undefined) return [];
	const target = { repo, pr };
	return isLandTarget(target) ? [target] : [];
}

/** The first named PR that is this repo's queue entry, or null. */
function queuedTarget(
	ops: { input?: { args?: ReadonlyArray<WordLike> } },
	env: EnvCtx,
): LandTarget | null {
	for (const target of landTargets(positionals(ops))) {
		if (queueEntryFile(target.repo, target.pr, env) !== null) return target;
	}
	return null;
}

/**
 * `when.localMergeOfQueueEntry` — a --mode local land of a PR that is this
 * repo's merge queue entry. Help and the PC_MERGE_LOCAL_OK=1 escape never
 * fire; every unreadable state allows (fail-open).
 */
export const localMergeOfQueueEntry = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		const helper = helperArgs(ctx);
		if (helper === null) return false === expected;
		const own = { input: { args: helper } };
		if (informational(own)) return false === expected;
		if (localOkEscaped(ctx)) return false === expected;
		if (modeValue(own) !== "local") return false === expected;
		const hit = queuedTarget(own, ctx) !== null;
		return hit === expected;
	},
);

/** The block message, naming the PR and the turn that should carry it. */
export function queueLandNudgeReason(ctx: PredicateContext): string {
	const args = helperArgs(ctx) ?? [];
	const hit = queuedTarget({ input: { args } }, ctx);
	const what = hit === null ? "this PR" : `${hit.repo}#${hit.pr}`;
	const land =
		hit === null
			? "tools/merge-pr.sh queue land <owner/repo>"
			: `tools/merge-pr.sh queue land ${hit.repo}`;
	return `${what} is this repo's merge queue entry. Land it with \`${land}\` instead (same PR_NOTE and DECISION_NOTE): the turn gates the rebuilt main+PR candidate and lands it, so a main move no longer costs an absorb and a re-gate, while a --mode local gate binds to the pushed head and refuses a head that does not contain current origin/main. If this PR is live-surface (a live proof the turn cannot perform), or the queue is wedged, prefix PC_MERGE_LOCAL_OK=1 and say why in the merge note.`;
}

export const queueLandNudgeRules = [
	{
		name: "queue-land-nudge",
		tool: "bash" as const,
		command: [MERGE_PR, "bash", "sh"] as const,
		when: { localMergeOfQueueEntry: true },
		reason: queueLandNudgeReason,
	},
];

export const queueLandNudgePlugin = {
	name: "queue-land-nudge",
	// The value-taking flags are declared so the engine's own positionals()
	// reads the operands, not a flag value ('--mode local <repo> <pr>' still
	// reads the repo first); the local positionals() above uses the same set.
	cliDescriptors: {
		"merge-pr.sh": {
			flags: {
				mode: { aliases: ["--mode"], takesValue: true },
				repo: { aliases: ["--repo"], takesValue: true },
				main: { aliases: ["--main"], takesValue: true },
				live: { aliases: ["--live"], takesValue: true },
				reason: { aliases: ["--reason"], takesValue: true },
				brief: { aliases: ["--brief"], takesValue: true },
				estimate: { aliases: ["--estimate"], takesValue: true },
				timeout: { aliases: ["--timeout"], takesValue: true },
				unit: { aliases: ["--unit"], takesValue: true },
				pid: { aliases: ["--pid"], takesValue: true },
				"absorb-only": { aliases: ["--absorb-only"], takesValue: false },
				"no-gate": { aliases: ["--no-gate"], takesValue: false },
				gate: { aliases: ["--gate"], takesValue: false },
				json: { aliases: ["--json"], takesValue: false },
			},
		},
	},
	predicates: { localMergeOfQueueEntry },
} as const satisfies Plugin;
