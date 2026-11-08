// SPDX-License-Identifier: MIT
/**
 * The base's enforced process rules (pc-host #704): the one round count,
 * the no-round-on-a-red-or-unpushed-head rule, the split-piece shrink rule
 * and the absorb-of binding.
 *
 * The owner, 2026-11-08: "yes it should be enforced, advisories don't
 * work with agents". Each rule below is therefore a refusal, not a
 * warning, and each fails closed: a check that cannot run refuses the
 * brief instead of passing it.
 *
 * R4, one round definition. The count is merge-pr.sh's: a distinct head
 * named by a trusted lens verdict's first line (its design_check_rounds).
 * The helper's read-only subcommand `rounds <owner/repo> <pr>` prints it
 * one `<round> <head>` line per round, and this module counts those lines
 * with grep-shaped code (one regex per line, no parser). The cap and the
 * split-piece inheritance both read it, so the base, the helper and the
 * steering cannot drift. ROUNDS_FROM_HELPER gates that path: it stays
 * false until pc-host #704 (which adds the subcommand) merges, so the
 * live steering keeps its header-only count and never shells out to a
 * helper that does not have the subcommand yet.
 *
 * R1/R3, no round on a red or unpushed head. A `kind: lens` brief carries
 * `head: <40-hex>` and is refused unless that sha is the PR's current head
 * on GitHub and a passing run is bound to it: a gate-record comment for
 * that head, or a `green-run: <path>` header naming a tools/ci.sh
 * summary.txt whose `result:` line is PASS, whose `run on: snapshot
 * commit <sha>` names that head and whose dirty-worktree lines all say no.
 * Those lines are read with greps, never a parser.
 *
 * R2, a re-cut must shrink. A `split-of: <owner/repo>#<n>` piece restarts
 * at round 1 only when its changed paths are a subset of the parent's and
 * its changed lines are strictly fewer; otherwise it inherits the parent's
 * round count. There is no one-split limit and no owner step: a piece that
 * reaches round 5 splits again.
 *
 * Absorb-of binding (#719 trust-model F1). The absorb-lens exemption holds
 * only when the named sha is a merge commit on the PR branch with one
 * parent reachable from origin/main, read from the operator clone after a
 * fetch. Nothing more is checked: the exemption is about which round it is,
 * not about what the absorb contains.
 *
 * Every command runs through a seam (PI_H4_GH / PI_H4_GIT / PI_H4_CLONE /
 * PI_H4_MERGE_HELPER / PI_H4_PCMERGE_STATE) so the suite drives stubs and
 * never touches the network or the operator's real state.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether the round count comes from merge-pr.sh's `rounds` subcommand.
 * False until pc-host #704 merges: the subcommand does not exist in the
 * operator clone's helper yet, and the live steering must keep working.
 * Flip this to true in the same change that absorbs #704 into the clone.
 */
export const ROUNDS_FROM_HELPER = false;

/**
 * Whether the count path is live: the constant above, or the seam
 * PI_H4_ROUNDS_FROM_HELPER=1 (the suite drives it, and the operator can
 * flip it for a dry run before the constant changes).
 */
export function roundsFromHelper(): boolean {
	return ROUNDS_FROM_HELPER || process.env.PI_H4_ROUNDS_FROM_HELPER === "1";
}

/** A command result: the exit status and both streams. */
interface Run {
	ok: boolean;
	/** The exit status (0 on success, the tool's status on failure, -1 unknown). */
	status: number;
	out: string;
	err: string;
}

function env(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}

/** The gh binary (tests point this at a stub). */
export function ghBin(): string {
	return env("PI_H4_GH", "gh");
}

/** The git binary (tests point this at a stub). */
export function gitBin(): string {
	return env("PI_H4_GIT", "git");
}

/** The operator clone of pc-host: where the merge helper and the git reads run. */
export function operatorClone(): string {
	return env(
		"PI_H4_CLONE",
		join(process.env.HOME ?? homedir(), ".local", "share", "pc-merge", "pc-host"),
	);
}

/** The merge helper the operator clone runs (read-only subcommands only). */
export function mergeHelper(): string {
	return env("PI_H4_MERGE_HELPER", join(operatorClone(), "tools", "merge-pr.sh"));
}

/** The helper's state root (gate evidence lives here). */
export function pcMergeState(): string {
	return env(
		"PI_H4_PCMERGE_STATE",
		join(process.env.HOME ?? homedir(), ".local", "state", "pc-merge"),
	);
}

/** Run a command, never throwing: a failure is data, not an exception. */
function run(bin: string, args: string[], input?: string): Run {
	try {
		const out = execFileSync(bin, args, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 60_000,
			input: input ?? "",
		});
		return { ok: true, status: 0, out, err: "" };
	} catch (error) {
		const err = error as {
			stdout?: string;
			stderr?: string;
			message?: string;
			status?: number;
		};
		return {
			ok: false,
			status: typeof err.status === "number" ? err.status : -1,
			out: typeof err.stdout === "string" ? err.stdout : "",
			err:
				typeof err.stderr === "string" && err.stderr !== ""
					? err.stderr.trim()
					: (err.message ?? "command failed").trim(),
		};
	}
}

/** One line of output, trimmed; "" when the command printed nothing. */
function oneLine(result: Run): string {
	return (result.out.split("\n")[0] ?? "").trim();
}

/** `owner/repo#n` split into its parts, or null. */
function splitPr(ref: string): { repo: string; number: string } | null {
	const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]+)$/.exec(ref.trim());
	return match === null
		? null
		: { repo: match[1] ?? "", number: match[2] ?? "" };
}

/** The PR's current head on GitHub: the sha, or the reason it cannot be read. */
export function prHead(
	ref: string,
): { ok: true; sha: string } | { ok: false; err: string } {
	const parts = splitPr(ref);
	if (parts === null) return { ok: false, err: `not a PR ref: ${ref}` };
	const result = run(ghBin(), [
		"pr",
		"view",
		parts.number,
		"--repo",
		parts.repo,
		"--json",
		"headRefOid",
		"--jq",
		".headRefOid",
	]);
	if (!result.ok) return { ok: false, err: oneLine(result) || "gh pr view failed" };
	const sha = oneLine(result);
	return /^[0-9a-f]{40}$/.test(sha)
		? { ok: true, sha }
		: { ok: false, err: `gh pr view printed no head sha: ${sha || "<empty>"}` };
}

/**
 * The round count of a PR, from the helper's read-only `rounds`
 * subcommand: its `<round> <head>` lines, counted. A failed run, or a
 * line that is not that shape, is an error and never zero rounds.
 */
export function roundsCount(
	ref: string,
): { ok: true; count: number } | { ok: false; err: string } {
	const parts = splitPr(ref);
	if (parts === null) return { ok: false, err: `not a PR ref: ${ref}` };
	const result = run(mergeHelper(), ["rounds", parts.repo, parts.number]);
	if (!result.ok) {
		return {
			ok: false,
			err: oneLine(result) || `${mergeHelper()} rounds failed`,
		};
	}
	const lines = result.out.split("\n").filter((line) => line.trim() !== "");
	for (const line of lines) {
		if (!/^[1-9][0-9]* [0-9a-f]{40}$/.test(line.trim())) {
			return {
				ok: false,
				err: `the round count is not a '<round> <40-hex>' list: ${line.trim()}`,
			};
		}
	}
	return { ok: true, count: lines.length };
}

/** A diff's changed paths and its changed lines (additions + deletions). */
function changedDiff(
	ref: string,
): { ok: true; paths: string[]; lines: number } | { ok: false; err: string } {
	const parts = splitPr(ref);
	if (parts === null) return { ok: false, err: `not a PR ref: ${ref}` };
	const paths = run(ghBin(), [
		"pr",
		"diff",
		parts.number,
		"--repo",
		parts.repo,
		"--name-only",
	]);
	if (!paths.ok) {
		return { ok: false, err: oneLine(paths) || "gh pr diff --name-only failed" };
	}
	const counts = run(ghBin(), [
		"api",
		"--paginate",
		`repos/${parts.repo}/pulls/${parts.number}/files`,
		"--jq",
		"[.[] | .additions + .deletions] | add // 0",
	]);
	if (!counts.ok) {
		return { ok: false, err: oneLine(counts) || "gh api pulls/<n>/files failed" };
	}
	const lines = Number.parseInt(oneLine(counts), 10);
	if (!Number.isInteger(lines) || lines < 0) {
		return { ok: false, err: `the changed-line count is not a number: ${oneLine(counts)}` };
	}
	return {
		ok: true,
		paths: paths.out
			.split("\n")
			.map((path) => path.trim())
			.filter((path) => path !== ""),
		lines,
	};
}

/**
 * Is this piece strictly smaller than its split parent: changed paths a
 * subset, changed lines strictly fewer? A check that cannot run is an
 * error (the caller refuses), never a pass.
 */
export function pieceIsSmaller(
	piece: string,
	parent: string,
): { ok: true; smaller: boolean } | { ok: false; err: string } {
	const mine = changedDiff(piece);
	if (!mine.ok) return { ok: false, err: `${piece}: ${mine.err}` };
	const theirs = changedDiff(parent);
	if (!theirs.ok) return { ok: false, err: `${parent}: ${theirs.err}` };
	const parentPaths = new Set(theirs.paths);
	const outside = mine.paths.filter((path) => !parentPaths.has(path));
	if (outside.length > 0) {
		return {
			ok: true,
			smaller: false,
		};
	}
	return { ok: true, smaller: mine.lines < theirs.lines };
}

/** The changed paths of a piece that its parent does not carry (for the message). */
export function pathsOutsideParent(piece: string, parent: string): string[] {
	const mine = changedDiff(piece);
	const theirs = changedDiff(parent);
	if (!mine.ok || !theirs.ok) return [];
	const parentPaths = new Set(theirs.paths);
	return mine.paths.filter((path) => !parentPaths.has(path));
}

/** `git -C <clone> ...` in the operator clone. */
function cloneGit(args: string[]): Run {
	return run(gitBin(), ["-C", operatorClone(), ...args]);
}

/** A commit's parents, from `git cat-file -p`. */
export function commitParents(
	sha: string,
): { ok: true; parents: string[] } | { ok: false; err: string } {
	const result = cloneGit(["cat-file", "-p", sha]);
	if (!result.ok) {
		return { ok: false, err: oneLine(result) || `cannot read commit ${sha}` };
	}
	const parents: string[] = [];
	for (const line of result.out.split("\n")) {
		if (line.trim() === "") break;
		const match = /^parent ([0-9a-f]{40})$/.exec(line);
		if (match !== null) parents.push(match[1] ?? "");
	}
	return { ok: true, parents };
}

/** `git merge-base --is-ancestor <ancestor> <descendant>` (after a fetch). */
export function isAncestor(
	ancestor: string,
	descendant: string,
): { ok: true; yes: boolean } | { ok: false; err: string } {
	const result = cloneGit(["merge-base", "--is-ancestor", ancestor, descendant]);
	if (result.ok) return { ok: true, yes: true };
	// git exits 1 for the negative answer and 128 (or anything else) for an
	// error: the status is the answer, never a guess from the empty output.
	if (result.status === 1) return { ok: true, yes: false };
	return {
		ok: false,
		err: `git merge-base --is-ancestor ${ancestor} ${descendant}: ${result.err || "exit " + result.status}`,
	};
}

/** Fetch the operator clone, then read a ref's sha. */
export function fetchedRef(
	ref: string,
): { ok: true; sha: string } | { ok: false; err: string } {
	const fetch = cloneGit(["fetch", "--quiet", "origin"]);
	if (!fetch.ok) {
		return { ok: false, err: oneLine(fetch) || "git fetch origin failed" };
	}
	const result = cloneGit(["rev-parse", ref]);
	const sha = oneLine(result);
	if (!result.ok || !/^[0-9a-f]{40}$/.test(sha)) {
		return { ok: false, err: oneLine(result) || `cannot read ${ref}` };
	}
	return { ok: true, sha };
}

/**
 * The absorb-of binding: the sha is a merge commit on the PR branch with
 * one parent reachable from origin/main. Returns the refusal, or null.
 */
export function absorbBindingRefusal(
	sha: string,
	ref: string,
): string | null {
	const parents = commitParents(sha);
	if (!parents.ok) {
		return `absorb-of ${sha}: ${parents.err}; the exemption needs the absorb merge commit in the operator clone (fail closed)`;
	}
	if (parents.parents.length !== 2) {
		return `absorb-of ${sha} is not a merge commit (${parents.parents.length} parents); the exemption covers the absorb merge of main into the reviewed head, nothing else`;
	}
	const main = fetchedRef("refs/remotes/origin/main");
	if (!main.ok) {
		return `absorb-of ${sha}: ${main.err}; the exemption needs origin/main in the operator clone (fail closed)`;
	}
	const head = prHead(ref);
	if (!head.ok) {
		return `absorb-of ${sha}: the head of ${ref} could not be read (${head.err}); the exemption needs the absorb on the PR branch (fail closed)`;
	}
	const onBranch = isAncestor(sha, head.sha);
	if (!onBranch.ok) return `absorb-of ${sha}: ${onBranch.err} (fail closed)`;
	if (!onBranch.yes) {
		return `absorb-of ${sha} is not on the ${ref} branch (its head is ${head.sha}); the exemption covers a commit pushed to this PR`;
	}
	let reachable = 0;
	for (const parent of parents.parents) {
		const ancestor = isAncestor(parent, main.sha);
		if (!ancestor.ok) return `absorb-of ${sha}: ${ancestor.err} (fail closed)`;
		if (ancestor.yes) reachable += 1;
	}
	if (reachable !== 1) {
		return `absorb-of ${sha} has ${reachable} parents reachable from origin/main (${main.sha}); an absorb merge has exactly one (the main side)`;
	}
	return null;
}

/**
 * The gate-record half of R3: a gate-record comment on the PR whose gate
 * manifest names this head. The gate posts `<!-- local-ci-gate:<id> -->`
 * only on a pass, and the manifest it keeps is what names the head.
 */
function gateRecordForHead(ref: string, head: string): string | null {
	const parts = splitPr(ref);
	if (parts === null) return `not a PR ref: ${ref}`;
	const comments = run(ghBin(), [
		"api",
		"--paginate",
		`repos/${parts.repo}/issues/${parts.number}/comments`,
	]);
	if (!comments.ok) {
		return `the PR's comments could not be read (${oneLine(comments) || "gh api failed"}); a lens round may not start on a head that cannot be shown green (fail closed)`;
	}
	const ids: string[] = [];
	for (const match of comments.out.matchAll(
		/<!-- local-ci-gate:([^\s>]+) -->/g,
	)) {
		const id = match[1] ?? "";
		if (id !== "" && !ids.includes(id)) ids.push(id);
	}
	const repoKey = parts.repo.replace(/\//g, "--").replace(/\./g, "_");
	for (const id of ids) {
		const manifest = join(
			pcMergeState(),
			"evidence",
			repoKey,
			head,
			id,
			"manifest",
		);
		let text: string;
		try {
			text = readFileSync(manifest, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n").map((line) => line.trim());
		if (lines.includes(`head: ${head}`)) return null;
	}
	return `${ref} has no gate-record comment bound to head ${head}, and the brief carries no 'green-run: <path>' (no round on a red or unpushed head)`;
}

/**
 * The green-run half of R3: a tools/ci.sh summary whose result is PASS,
 * whose run sha is this head and whose dirty-worktree lines all say no.
 * The three reads are greps; nothing here parses the summary.
 */
function greenRunRefusal(path: string, head: string): string | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return `the green-run summary ${path} cannot be read; a lens round needs a run bound to head ${head}`;
	}
	const lines = text.split("\n");
	const pass = lines.filter((line) => line.trim() === "result: PASS").length;
	const fail = lines.filter((line) => /^result: /.test(line.trim())).length;
	if (pass !== 1 || fail !== 1) {
		return `the green-run summary ${path} does not hold exactly one 'result: PASS' (found ${pass} PASS of ${fail} result lines)`;
	}
	const runOn = new RegExp(
		`^run on:\\s+snapshot commit ${head} tree [0-9a-f]{40}\\s*$`,
	);
	if (!lines.some((line) => runOn.test(line.trim()))) {
		return `the green-run summary ${path} did not run on head ${head}: its 'run on: snapshot commit <sha> tree <tree>' line names another sha (a live-worktree run is never evidence)`;
	}
	const dirty = lines.filter((line) => /^worktree dirty /.test(line.trim()));
	if (dirty.length === 0) {
		return `the green-run summary ${path} has no 'worktree dirty' line, so the run cannot be shown clean`;
	}
	const dirtyBad = dirty.filter((line) => !/: no$/.test(line.trim()));
	if (dirtyBad.length > 0) {
		return `the green-run summary ${path} ran on a dirty worktree (${dirtyBad[0]?.trim() ?? ""}); a lens round needs a clean run`;
	}
	return null;
}

/**
 * R1/R3: the lens brief's head must be the PR's current head and must have
 * a passing run bound to it. Returns the refusal, or null.
 */
export function lensHeadRefusal(
	head: string | null,
	greenRun: string | null,
	ref: string,
): string | null {
	if (head === null || !/^[0-9a-f]{40}$/.test(head)) {
		return `a lens brief needs 'head: <40-hex>' in its header, naming the head it reviews (no round on a red or unpushed head): write 'head: ${head ?? "<sha>"}'`;
	}
	const current = prHead(ref);
	if (!current.ok) {
		return `the head of ${ref} could not be read (${current.err}); a lens round may not start on a head that cannot be shown green (fail closed)`;
	}
	if (current.sha !== head) {
		return `the brief reviews head ${head} but ${ref} is at ${current.sha}: push the head, then write the brief (no round on an unpushed head)`;
	}
	if (greenRun !== null && greenRun !== "") {
		return greenRunRefusal(greenRun, head);
	}
	return gateRecordForHead(ref, head);
}
