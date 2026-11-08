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
import { existsSync, readFileSync } from "node:fs";
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

/**
 * The gate-record half of R3: a gate-record comment on the PR whose gate
 * manifest names this head. The gate posts `<!-- local-ci-gate:<id> -->`
 * only on a pass, and the manifest it keeps is what names the head.
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
