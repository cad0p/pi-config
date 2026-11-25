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
 * Those lines are read with greps, never a parser. The optional
 * `@ <40-hex>` trailer on the value is a consistency check, not decoration:
 * it must equal the sha the summary's own `run on:` line names AND the head
 * this round may cite (`head:`, or `absorb-of:` when the header declares
 * one), and a trailer that is not exactly 40 lowercase hex is refused as
 * malformed.
 *
 * The absorb-head green-run relaxation. A brief that reviews the absorb
 * head H' may cite CI produced on the head H the absorb was built from:
 * when the header carries `absorb-of: H` (exactly once, 40 hex, H the
 * absorb merge the binding above checks) and H differs from `head:`, a
 * green-run summary whose `run on:` names H is accepted in place of H'.
 * Every green-run summary in the brief must then name H - one summary on
 * head and another on H is refused, not merely checked on the first. The
 * absorb pass reports `absorb-check: PASS`, so the PR delta is
 * byte-identical to the reviewed head and merge-pr.sh carries the reviewed
 * verdicts forward; the bar does not need the fresh ~13-16 min container
 * run on H'. The reviewed head must still be the PR's current head, and
 * without `absorb-of:` the binding is unchanged (a summary on another sha
 * refuses with the same message).
 *
 * A merge-train gate counts for its member heads (pc-tenant #603). A train
 * gates ONE candidate commit - main plus every piece, bottom first - so its
 * manifest sits under the candidate head and never under a member head, and
 * the head-keyed read below could not see it: every member PR's lens brief
 * was refused with "no gate-record comment bound to head <H>" while the
 * train's PASS gate, whose binding comment the helper posts on every member
 * PR, was the green run for exactly that head. The train manifests are read
 * for the same gate ids, under any head directory of the PR's repo, and one
 * of them accepts the brief when it is a PASS gate (`result: PASS` exactly
 * once), its `repo:` line is this PR's repo, it is a train gate (one
 * `train-gate-kind:` line) and its `train-pieces: <pr>:<head> ...` line
 * lists this brief's PR number with this brief's head. Nothing else
 * widens: a FAIL train manifest, a manifest that lists the head for another
 * PR, and a head absent from every train piece line all still refuse, and
 * the refusal names the head and the pieces it looked for and found.
 *
 * The gate record is read where the helper writes it:
 * `<evidence root>/<owner>/<repo>/<head>/<gate id>/manifest`, the RAW
 * owner/repo, one directory each (merge-pr.sh :10 evidence_root, :2656
 * run_dir="$evidence_root/$repo/$head/$run_id"). Not the repo key
 * (`owner--repo`, '.' -> '_'): that names the helper's stages, records,
 * owed, locks, dispatches and per-repo clones, and the evidence tree has
 * no keyed directory at all, so reading it here refused every gate record
 * (pc-host and pc-control were masked by the green-run route; pc-tenant's
 * ci.sh prints no 'run on: snapshot commit' line to use instead).
 *
 * R2, a re-cut must shrink. A `split-of: <owner/repo>#<n>` piece restarts
 * at round 1 only when its changed paths are a subset of the parent's and
 * its changed lines are strictly fewer; otherwise it inherits the parent's
 * round count. There is no one-split limit and no owner step: a piece that
 * reaches round 5 splits again.
 *
 * Absorb-of binding (#719 trust-model F1). The absorb-lens exemption holds
 * only when the named sha is a merge commit on the PR branch with one
 * parent reachable from origin/main, read from the PR's OWN repo clone
 * (repoClone) after a fetch. Nothing more is checked: the exemption is
 * about which round it is, not about what the absorb contains.
 *
 * One clone per repo. Every git read of a PR's commits runs in that repo's
 * clone, `<clones root>/<owner>--<repo>` (the merge helper keeps one
 * checkout per repo there): the operator clone of pc-host holds pc-host's
 * history and nothing else, so reading a pc-tenant sha there refuses a
 * sound absorb. operatorClone() stays the merge HELPER's checkout (merge-pr.sh
 * lives only in pc-host) and is the fallback clone for cad0p/pc-host when
 * no cad0p--pc-host clone exists. A missing clone is a named refusal.
 *
 * Every command runs through a seam (PI_H4_GH / PI_H4_GIT / PI_H4_CLONE /
 * PI_H4_CLONES_ROOT / PI_H4_MERGE_HELPER / PI_H4_PCMERGE_STATE, plus the
 * helper's own PC_MERGE_EVIDENCE_ROOT) so the suite drives stubs and never
 * touches the network or the operator's real state.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type GreenRunValue, greenRunPath } from "./brief-gates.ts";

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

/** The operator clone of pc-host: where the merge helper runs. */
export function operatorClone(): string {
	return env(
		"PI_H4_CLONE",
		join(process.env.HOME ?? homedir(), ".local", "share", "pc-merge", "pc-host"),
	);
}

/** The root of the per-repo clones: one `<owner>--<repo>` checkout per repo. */
export function clonesRoot(): string {
	return env(
		"PI_H4_CLONES_ROOT",
		join(process.env.HOME ?? homedir(), ".local", "share", "pc-merge"),
	);
}

/**
 * The clone a PR's git reads run in: `<clones root>/<repo key>`. A
 * PR's commits exist in its own repo's clone and nowhere else, so reading
 * them in the pc-host clone is a wrong answer, not a stale one. The merge
 * helper's checkout (operatorClone) is pc-host's fallback when no
 * `cad0p--pc-host` clone exists. A missing clone is a named error: the
 * caller refuses (fail closed).
 */
export function repoClone(
	ownerRepo: string,
): { ok: true; path: string } | { ok: false; err: string } {
	const key = ownerRepo.trim().toLowerCase();
	const path = join(clonesRoot(), repoKey(key));
	if (existsSync(path)) return { ok: true, path };
	if (key === "cad0p/pc-host") return { ok: true, path: operatorClone() };
	return { ok: false, err: `no clone of ${ownerRepo} at ${path}` };
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

/**
 * The helper's repo key: `owner/repo` with '/' -> '--' and '.' -> '_'
 * (merge-pr.sh :290 repo_key, tools/lib/pc-merge.sh pcm_repo_key :20). It
 * names the helper's per-repo state — stages, records, owed, locks,
 * dispatches — and its per-repo clones (:136). It never names the evidence
 * tree, which keeps the raw owner/repo (gateEvidenceManifest).
 */
export function repoKey(ownerRepo: string): string {
	return ownerRepo.replace(/\//g, "--").replace(/\./g, "_");
}

/**
 * The helper's evidence root: `<state>/evidence`, or the helper's own
 * PC_MERGE_EVIDENCE_ROOT override (merge-pr.sh :10
 * `evidence_root="${PC_MERGE_EVIDENCE_ROOT:-$state_root/evidence}"`).
 */
export function evidenceRoot(): string {
	const override = process.env.PC_MERGE_EVIDENCE_ROOT;
	return override === undefined || override === ""
		? join(pcMergeState(), "evidence")
		: override;
}

/** A value that is one path segment: not '.', '..', a separator or a NUL. */
function safeSegment(value: string): boolean {
	return (
		value !== "" &&
		value !== "." &&
		value !== ".." &&
		!/[/\\\u0000]/.test(value)
	);
}

/** `owner/repo` as two safe segments, so the join cannot leave the root. */
function repoParts(
	ownerRepo: string,
): { ok: true; owner: string; repo: string } | { ok: false; err: string } {
	const pieces = ownerRepo.split("/");
	const owner = pieces[0] ?? "";
	const repo = pieces[1] ?? "";
	if (pieces.length !== 2 || !safeSegment(owner) || !safeSegment(repo)) {
		return {
			ok: false,
			err: `'${ownerRepo}' is not an owner/repo pair of path segments, so its evidence path cannot be built (fail closed)`,
		};
	}
	return { ok: true, owner, repo };
}

/**
 * A gate run's manifest, at the path the helper writes it:
 * `<evidence root>/<owner>/<repo>/<head>/<gate id>/manifest`, the raw
 * owner/repo as two directories (merge-pr.sh :10 evidence_root, :2656
 * run_dir="$evidence_root/$repo/$head/$run_id"; the live tree is
 * ~/.local/state/pc-merge/evidence/cad0p/{pc-host,pc-tenant,...}). The
 * helper's repo key is deliberately NOT used here: it names stages,
 * records, owed, locks, dispatches and the clones, and using it refused
 * every gate record outside pc-host.
 */
export function gateEvidenceManifest(
	ownerRepo: string,
	head: string,
	gateId: string,
): { ok: true; path: string } | { ok: false; err: string } {
	const parts = repoParts(ownerRepo);
	if (!parts.ok) return parts;
	if (!safeSegment(head) || !safeSegment(gateId)) {
		return {
			ok: false,
			err: `'${head}' and '${gateId}' are not a head / gate id of path segments, so their evidence path cannot be built (fail closed)`,
		};
	}
	return {
		ok: true,
		path: join(
			evidenceRoot(),
			parts.owner,
			parts.repo,
			head,
			gateId,
			"manifest",
		),
	};
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
export function splitPr(ref: string): { repo: string; number: string } | null {
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
 * The rounds of a PR, oldest first, from the helper's read-only `rounds`
 * subcommand: its `<round> <head>` lines, one head each. A failed run, or
 * a line that is not that shape, is an error and never zero rounds.
 */
export function roundsList(
	ref: string,
): { ok: true; heads: string[] } | { ok: false; err: string } {
	const parts = splitPr(ref);
	if (parts === null) return { ok: false, err: `not a PR ref: ${ref}` };
	const result = run(mergeHelper(), ["rounds", parts.repo, parts.number]);
	if (!result.ok) {
		return {
			ok: false,
			err: oneLine(result) || `${mergeHelper()} rounds failed`,
		};
	}
	const heads: string[] = [];
	for (const line of result.out.split("\n")) {
		if (line.trim() === "") continue;
		const match = /^[1-9][0-9]* ([0-9a-f]{40})$/.exec(line.trim());
		if (match === null) {
			return {
				ok: false,
				err: `the round count is not a '<round> <40-hex>' list: ${line.trim()}`,
			};
		}
		heads.push(match[1] ?? "");
	}
	return { ok: true, heads };
}

/** The round count of a PR: the helper's `rounds` list, counted. */
export function roundsCount(
	ref: string,
): { ok: true; count: number } | { ok: false; err: string } {
	const list = roundsList(ref);
	if (!list.ok) return list;
	return { ok: true, count: list.heads.length };
}

/**
 * Whether the operator clone's merge helper carries the read-only `rounds`
 * subcommand (pc-host #730): its dispatch case at the bottom of
 * tools/merge-pr.sh. The file is read, never executed, so a helper without
 * the subcommand is an answer ("count the comments instead"), not an error.
 * PI_H4_HELPER_ROUNDS=1|0 forces the answer for the suite and a dry run.
 */
export function helperHasRounds(): boolean {
	const forced = process.env.PI_H4_HELPER_ROUNDS;
	if (forced === "1") return true;
	if (forced === "0") return false;
	let text: string;
	try {
		text = readFileSync(mergeHelper(), "utf8");
	} catch {
		return false;
	}
	return /^[ \t]*rounds\)/m.test(text);
}

/**
 * A posted lens verdict's first line: merge-pr.sh's lens_bucket_json shape
 * (`(CLEAN|FINDINGS(n)) @ <40-hex>`, case-insensitive, whitespace around
 * the @), anchored on the line and naming the lens it came from.
 */
const LENS_VERDICT_LINE = /^Lens:.*?(?:CLEAN|FINDINGS\([0-9]+\))\s*@\s*([0-9a-f]{40})$/i;

/**
 * The first non-blank line of every comment, extracted by jq exactly as
 * lens_bucket_json does it (split, drop CR, skip blank, trim). One line per
 * comment, so the caller greps lines and nothing here parses JSON.
 */
const FIRST_LINE_JQ =
	'.[] | [.body // "" | split("\\n")[] | gsub("\\r"; "") | select(test("\\\\S")) | gsub("^\\\\s+|\\\\s+$"; "")][0] // ""';

/**
 * The rounds posted on a PR, oldest first: the distinct heads a posted lens
 * verdict names, which is what merge-pr.sh counts as design_check_rounds.
 * When the operator clone's helper carries the `rounds` subcommand (#730)
 * its list is the answer - the helper and the merge script share one
 * definition - otherwise the PR's own comments are counted here with that
 * same first-line shape. A read that fails is an error (fail closed).
 */
export function postedLensRounds(
	ref: string,
): { ok: true; heads: string[] } | { ok: false; err: string } {
	if (helperHasRounds()) return roundsList(ref);
	const comments = prComments(ref, FIRST_LINE_JQ);
	if (!comments.ok) return comments;
	const heads: string[] = [];
	for (const line of comments.out.split("\n")) {
		const first = line.trim();
		// The helper's bucket skips the maintainer's own passes.
		if (first === "" || /^Maintainer:/i.test(first)) continue;
		const match = LENS_VERDICT_LINE.exec(first);
		const head = match?.[1]?.toLowerCase() ?? "";
		if (head !== "" && !heads.includes(head)) heads.push(head);
	}
	return { ok: true, heads };
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

/** `git -C <clone> ...` in one repo's clone. */
function cloneGit(clone: string, args: string[]): Run {
	return run(gitBin(), ["-C", clone, ...args]);
}

/** A commit's parents, from `git cat-file -p` in that repo's clone. */
export function commitParents(
	sha: string,
	clone: string,
): { ok: true; parents: string[] } | { ok: false; err: string } {
	const result = cloneGit(clone, ["cat-file", "-p", sha]);
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

/** `git merge-base --is-ancestor <ancestor> <descendant>` in that clone. */
export function isAncestor(
	ancestor: string,
	descendant: string,
	clone: string,
): { ok: true; yes: boolean } | { ok: false; err: string } {
	const result = cloneGit(clone, [
		"merge-base",
		"--is-ancestor",
		ancestor,
		descendant,
	]);
	if (result.ok) return { ok: true, yes: true };
	// git exits 1 for the negative answer and 128 (or anything else) for an
	// error: the status is the answer, never a guess from the empty output.
	if (result.status === 1) return { ok: true, yes: false };
	return {
		ok: false,
		err: `git merge-base --is-ancestor ${ancestor} ${descendant}: ${result.err || "exit " + result.status}`,
	};
}

/** Fetch that repo's clone, then read a ref's sha. */
export function fetchedRef(
	ref: string,
	clone: string,
): { ok: true; sha: string } | { ok: false; err: string } {
	const fetch = cloneGit(clone, ["fetch", "--quiet", "origin"]);
	if (!fetch.ok) {
		return { ok: false, err: oneLine(fetch) || "git fetch origin failed" };
	}
	const result = cloneGit(clone, ["rev-parse", ref]);
	const sha = oneLine(result);
	if (!result.ok || !/^[0-9a-f]{40}$/.test(sha)) {
		return { ok: false, err: oneLine(result) || `cannot read ${ref}` };
	}
	return { ok: true, sha };
}

/**
 * The absorb-of binding: the sha is a merge commit on the PR branch with
 * one parent reachable from origin/main, all read in the PR's own repo
 * clone (the pc-host clone holds no other repo's history). Returns the
 * refusal, or null.
 */
export function absorbBindingRefusal(
	sha: string,
	ref: string,
): string | null {
	const pr = splitPr(ref);
	if (pr === null) {
		return `absorb-of ${sha}: not a PR ref: ${ref}; the exemption needs the PR it exempts (fail closed)`;
	}
	const clone = repoClone(pr.repo);
	if (!clone.ok) {
		return `absorb-of ${sha}: ${clone.err}; the exemption reads the absorb in that repo's clone (fail closed)`;
	}
	const inClone = `the ${pr.repo} clone`;
	const parents = commitParents(sha, clone.path);
	if (!parents.ok) {
		return `absorb-of ${sha}: ${parents.err}; the exemption needs the absorb merge commit in ${inClone} (fail closed)`;
	}
	if (parents.parents.length !== 2) {
		return `absorb-of ${sha} is not a merge commit (${parents.parents.length} parents); the exemption covers the absorb merge of main into the reviewed head, nothing else`;
	}
	const main = fetchedRef("refs/remotes/origin/main", clone.path);
	if (!main.ok) {
		return `absorb-of ${sha}: ${main.err}; the exemption needs origin/main in ${inClone} (fail closed)`;
	}
	const head = prHead(ref);
	if (!head.ok) {
		return `absorb-of ${sha}: the head of ${ref} could not be read (${head.err}); the exemption needs the absorb on the PR branch (fail closed)`;
	}
	const onBranch = isAncestor(sha, head.sha, clone.path);
	if (!onBranch.ok) return `absorb-of ${sha}: ${onBranch.err} (fail closed)`;
	if (!onBranch.yes) {
		return `absorb-of ${sha} is not on the ${ref} branch (its head is ${head.sha}); the exemption covers a commit pushed to this PR`;
	}
	let reachable = 0;
	for (const parent of parents.parents) {
		const ancestor = isAncestor(parent, main.sha, clone.path);
		if (!ancestor.ok) return `absorb-of ${sha}: ${ancestor.err} (fail closed)`;
		if (ancestor.yes) reachable += 1;
	}
	if (reachable !== 1) {
		return `absorb-of ${sha} has ${reachable} parents reachable from origin/main (${main.sha}); an absorb merge has exactly one (the main side)`;
	}
	return null;
}

/**
 * The PR's issue comments, read where the helper reads them
 * (`gh api --paginate`), optionally reduced by a `--jq` filter so the
 * caller greps lines and never parses JSON. A failed read is data.
 */
function prComments(
	ref: string,
	jq: string | null = null,
): { ok: true; out: string } | { ok: false; err: string } {
	const parts = splitPr(ref);
	if (parts === null) return { ok: false, err: `not a PR ref: ${ref}` };
	const args = [
		"api",
		"--paginate",
		`repos/${parts.repo}/issues/${parts.number}/comments`,
	];
	if (jq !== null) args.push("--jq", jq);
	const result = run(ghBin(), args);
	if (!result.ok) {
		return { ok: false, err: oneLine(result) || "gh api failed" };
	}
	return { ok: true, out: result.out };
}

/** Every head directory of this repo in the evidence tree (a train gate sits
 * under its candidate head, so the heads are enumerated, not derived). */
function evidenceHeads(ownerRepo: string): string[] {
	const parts = repoParts(ownerRepo);
	if (!parts.ok) return [];
	let names: string[];
	try {
		names = readdirSync(join(evidenceRoot(), parts.owner, parts.repo));
	} catch {
		return [];
	}
	return names.filter((name) => /^[0-9a-f]{40}$/.test(name));
}

/** The `<pr>:<head>` pieces a manifest's `train-pieces:` line lists. */
function trainPiecesOf(lines: string[]): Array<{ pr: string; head: string }> {
	const pieces: Array<{ pr: string; head: string }> = [];
	for (const line of lines) {
		const match = /^train-pieces:\s*(.*?)\s*$/.exec(line);
		if (match === null) continue;
		for (const token of (match[1] ?? "").split(/\s+/)) {
			const piece = /^([0-9]+):([0-9a-f]{40})$/.exec(token);
			if (piece !== null) {
				pieces.push({ pr: piece[1] ?? "", head: piece[2] ?? "" });
			}
		}
	}
	return pieces;
}

/**
 * The merge-train half of R3 (pc-tenant #603): a train gates one candidate
 * commit, so its PASS manifest is written under the candidate head and never
 * under a member head. It accepts this brief when it is the PR's repo, it is
 * a train gate, it is a PASS gate, and its `train-pieces:` line lists this
 * brief's PR number with this brief's head. Everything else refuses, and the
 * refusal names the head and the train pieces that were found.
 */
function trainGateForHead(
	ref: string,
	head: string,
	ids: string[],
): { ok: true } | { ok: false; looked: string } {
	const parts = splitPr(ref);
	if (parts === null) return { ok: false, looked: `not a PR ref: ${ref}` };
	const heads = evidenceHeads(parts.repo);
	const seen: string[] = [];
	for (const id of ids) {
		if (!safeSegment(id)) continue;
		for (const candidate of heads) {
			const manifest = gateEvidenceManifest(parts.repo, candidate, id);
			if (!manifest.ok) continue;
			let text: string;
			try {
				text = readFileSync(manifest.path, "utf8");
			} catch {
				continue;
			}
			const lines = text.split("\n").map((line) => line.trim());
			// A plain gate of another head is not evidence for this one, and a
			// manifest that does not name this repo is another repo's run with
			// the same PR number.
			if (!lines.includes(`repo: ${parts.repo}`)) continue;
			if (lines.filter((line) => /^train-gate-kind: /.test(line)).length !== 1) {
				continue;
			}
			const pieces = trainPiecesOf(lines);
			if (pieces.length === 0) continue;
			const listed = pieces.map((piece) => `${piece.pr}:${piece.head}`).join(" ");
			// Exactly one PASS: a FAIL manifest, and one whose result cannot be
			// read, are not a green run for anybody.
			const green = lines.filter((line) => line === "result: PASS").length === 1;
			seen.push(
				`${id} under ${candidate} is ${green ? "PASS" : "not PASS"} and lists ${listed}`,
			);
			if (!green) continue;
			if (
				pieces.some(
					(piece) => piece.pr === parts.number && piece.head === head,
				)
			) {
				return { ok: true };
			}
		}
	}
	const looked =
		seen.length === 0
			? `no merge-train gate manifest of the PR's gate record(s) (${ids.join(", ")}) lists any piece in ${join(evidenceRoot(), ...parts.repo.split("/"))}`
			: `no merge-train gate manifest lists '${parts.number}:${head}' as a PASS gate (${seen.join("; ")})`;
	return { ok: false, looked };
}

/**
 * The gate-record half of R3: a gate-record comment on the PR whose gate
 * manifest names this head. The gate posts `<!-- local-ci-gate:<id> -->`
 * only on a pass, and the manifest it keeps is what names the head, or - for
 * a merge train - a manifest under the candidate head that lists this PR and
 * head as one of its pieces.
 */
function gateRecordForHead(ref: string, head: string): string | null {
	const parts = splitPr(ref);
	if (parts === null) return `not a PR ref: ${ref}`;
	const repo = repoParts(parts.repo);
	if (!repo.ok) return `${ref}: ${repo.err}`;
	const comments = prComments(ref);
	if (!comments.ok) {
		return `the PR's comments could not be read (${comments.err}); a lens round may not start on a head that cannot be shown green (fail closed)`;
	}
	const ids: string[] = [];
	for (const match of comments.out.matchAll(
		/<!-- local-ci-gate:([^\s>]+) -->/g,
	)) {
		const id = match[1] ?? "";
		if (id !== "" && !ids.includes(id)) ids.push(id);
	}
	for (const id of ids) {
		const manifest = gateEvidenceManifest(parts.repo, head, id);
		// A marker that is not a path segment names no run the helper could
		// have written: it is not evidence, and it is not a reason to refuse
		// (any comment on the PR could carry one).
		if (!manifest.ok) continue;
		let text: string;
		try {
			text = readFileSync(manifest.path, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n").map((line) => line.trim());
		if (lines.includes(`head: ${head}`)) return null;
	}
	// No manifest under this head. A merge train's gate is written under its
	// candidate head and names each member PR and head it carried, so it is
	// read from there before the head is called red (pc-tenant #603).
	if (ids.length > 0) {
		const train = trainGateForHead(ref, head, ids);
		if (train.ok) return null;
		return `${ref} has no gate-record comment bound to head ${head}, and ${train.looked}, and the brief carries no 'green-run: <path>' (no round on a red or unpushed head)`;
	}
	return `${ref} has no gate-record comment bound to head ${head}, and the brief carries no 'green-run: <path>' (no round on a red or unpushed head)`;
}

/**
 * The green-run half of R3: a tools/ci.sh summary whose result is PASS,
 * whose run sha is `runOn` and whose dirty-worktree lines all say no.
 * `runOn` is the reviewed head, or the `absorb-of:` head when the brief
 * declares the absorb relaxation (lensHeadRefusal decides which). The three
 * reads are greps; nothing here parses the summary.
 */
function greenRunRefusal(
	path: string,
	head: string,
	runOn: string = head,
): string | null {
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
	const bound = new RegExp(
		`^run on:\\s+snapshot commit ${runOn} tree [0-9a-f]{40}\\s*$`,
	);
	if (!lines.some((line) => bound.test(line.trim()))) {
		if (runOn !== head) {
			return `the green-run summary ${path} did not run on head ${head}: its 'run on: snapshot commit <sha> tree <tree>' line names neither head ${head} nor the absorb-of head ${runOn} (a live-worktree run is never evidence)`;
		}
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

/** Does a summary's `run on:` line name this snapshot sha? */
function summaryNamesSha(path: string, sha: string): boolean {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return false;
	}
	const bound = new RegExp(
		`^run on:\\s+snapshot commit ${sha} tree [0-9a-f]{40}\\s*$`,
	);
	return text
		.split("\n")
		.some((line) => bound.test(line.trim()));
}

/**
 * Every green-run value to check: the header's list, else the parsed value.
 * Both carry what the header wrote, so both are read with greenRunPath: the
 * `@ <head>` trailer an annotated value carries is not part of the path
 * (reading it whole refused a readable summary as "cannot be read") and is
 * held to the summary and the round by greenRunTrailerRefusal.
 */
function greenRunValues(
	greenRun: string | null,
	all?: string[],
): GreenRunValue[] {
	const values = (all ?? [])
		.map(greenRunPath)
		.filter((value) => value.path !== "" || value.malformed !== null);
	if (values.length > 0) return values;
	return greenRun === null || greenRun === ""
		? []
		: [greenRunPath(greenRun)];
}

/** The shas a summary's `run on: snapshot commit <sha> tree <tree>` lines name. */
function summaryRunOnShas(text: string): string[] {
	const shas: string[] = [];
	for (const line of text.split("\n")) {
		const match =
			/^run on:\s+snapshot commit ([0-9a-f]{40}) tree [0-9a-f]{40}\s*$/.exec(
				line.trim(),
			);
		const sha = match?.[1] ?? "";
		if (sha !== "" && !shas.includes(sha)) shas.push(sha);
	}
	return shas;
}

/**
 * A `green-run:` value's `@ <head>` trailer is held to the run it names:
 * it must equal the sha in the summary's own `run on:` line and the head
 * this round may cite - the reviewed `head:`, or the `absorb-of:` sha when
 * the header declares one. A trailer that is not 40 lowercase hex is
 * malformed, and a summary with no `run on:` line cannot hold one. A value
 * with no trailer is today's behaviour (this returns null). Returns the
 * refusal, or null.
 */
function greenRunTrailerRefusal(
	value: GreenRunValue,
	head: string,
	absorbOf: string | null,
): string | null {
	if (value.malformed !== null) {
		return `the green-run summary ${value.path} carries a malformed head trailer '@ ${value.malformed}': a trailer must be exactly the 40 lowercase hex head the run was made on, not '${value.malformed}' (fail closed)`;
	}
	const claimed = value.head;
	if (claimed === null) return null;
	const absorbHead =
		absorbOf !== null && /^[0-9a-f]{40}$/.test(absorbOf) ? absorbOf : null;
	const allowed = absorbHead ?? head;
	const cited =
		absorbHead === null
			? `head ${head}`
			: `the absorb-of head ${absorbHead}`;
	let text: string;
	try {
		text = readFileSync(value.path, "utf8");
	} catch {
		// greenRunRefusal names the summary that does not read; a trailer
		// cannot be held to a file that cannot be read.
		return null;
	}
	const ranOn = summaryRunOnShas(text);
	if (ranOn.length === 0) {
		return `the green-run summary ${value.path} is annotated '@ ${claimed}' but carries no 'run on: snapshot commit <sha> tree <tree>' line: the trailer must equal the sha the summary ran on, and this summary names none (the brief claims ${claimed}, this round may cite ${allowed} only, as ${cited})`;
	}
	const names = ranOn.join(", ");
	if (!ranOn.includes(claimed)) {
		return `the green-run summary ${value.path} is annotated '@ ${claimed}' but its own 'run on: snapshot commit' line names ${names}: the trailer must equal the sha the summary ran on (the brief claims ${claimed}, the summary ran on ${names}, and this round may cite ${allowed} only, as ${cited})`;
	}
	if (claimed !== allowed) {
		return `the green-run trailer '@ ${claimed}' on ${value.path} is not the head this round may cite: the brief claims ${claimed}, the summary ran on ${names}, and this round may cite ${allowed} only, as ${cited}`;
	}
	return null;
}

/**
 * R1/R3: the lens brief's head must be the PR's current head and must have
 * a passing run bound to it. An `absorb-of:` head H may stand in for the
 * run's sha when the brief reviews the absorb head H' (H !== H'), the
 * brief declares `absorb-of: H`, and every green-run summary it carries
 * names H. A `green-run:` value's `@ <head>` trailer must equal both the
 * sha its summary ran on and the head this round may cite ('head:', or H).
 * Returns the refusal, or null.
 */
export function lensHeadRefusal(
	head: string | null,
	greenRun: string | null,
	ref: string,
	opts: {
		/** The brief's `absorb-of:` sha, when the header carries one. */
		absorbOf?: string | null;
		/** Every `green-run:` path in the brief's header. */
		greenRuns?: string[];
	} = {},
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
	const values = greenRunValues(greenRun, opts.greenRuns);
	const absorbOf = opts.absorbOf ?? null;
	// The relaxation only applies to an absorb brief whose reviewed head is
	// not the absorb head: when they are equal the old binding applies. It is
	// further narrowed to a MERGE head (pc-host #1626): the relaxation exists
	// because an absorb carries no code of its own, while the one free code fix
	// on an absorb is a single-parent commit and does carry code - so a brief
	// whose head is that fix must carry its own green run on the fix itself, and
	// a read this cannot make leaves the brief refused (fail closed).
	let relaxed =
		absorbOf !== null &&
		absorbOf !== head &&
		/^[0-9a-f]{40}$/.test(absorbOf);
	if (relaxed) {
		// The narrowing is DECIDABLE only one way, so it is drawn that way: the
		// free code fix after an absorb is the head whose ONE parent is the
		// `absorb-of:` head (pc-host #1626). Such a head carries code, so its own
		// green run on itself is owed and the absorb head's run cannot stand in.
		// A head that is not that child - a reviewed head, an absorb merge - keeps
		// today's rule untouched, and a read this cannot make leaves the rule as it
		// was: the restriction rests on a fact about the head's parent, not on the
		// absence of a read.
		const parts = splitPr(ref);
		const clone =
			parts === null
				? { ok: false as const, err: "not a PR ref: " + ref }
				: repoClone(parts.repo);
		if (clone.ok) {
			const headParents = commitParents(head, clone.path);
			if (
				headParents.ok &&
				headParents.parents.length === 1 &&
				headParents.parents[0] === absorbOf
			) {
				return "head " + head + " is the one commit on the absorb-of head " + absorbOf + ": that is the one free code fix, which carries code, so its 'green-run:' must name " + head + " itself and not the absorb head";
			}
		}
	}
	let usesAbsorb = false;
	for (const value of values) {
		const trailer = greenRunTrailerRefusal(value, head, absorbOf);
		if (trailer !== null) return trailer;
		const onHead = greenRunRefusal(value.path, head);
		if (onHead === null) continue;
		if (!relaxed) return onHead;
		const onAbsorb = greenRunRefusal(value.path, head, absorbOf ?? "");
		if (onAbsorb === null) {
			usesAbsorb = true;
			continue;
		}
		return onAbsorb;
	}
	// Once one summary relies on the absorb head, every summary must name it:
	// a second run on another sha is not evidence for this brief.
	if (usesAbsorb) {
		const odd = values.find(
			(value) => !summaryNamesSha(value.path, absorbOf ?? ""),
		);
		if (odd !== undefined) {
			return `every green-run summary in an absorb-of brief must name the absorb-of head ${absorbOf}, not merely one of them: ${odd.path} names another sha (a live-worktree run is never evidence)`;
		}
	}
	if (values.length > 0) return null;
	return gateRecordForHead(ref, head);
}
