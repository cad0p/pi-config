// SPDX-License-Identifier: MIT
/**
 * E1 design-check gate - a lens or fold brief at round >= 3 needs the
 * periodic design check on file first, and the round cap ends the
 * chain at round 6.
 *
 * Round cap (owner rule: split at round 5). A lens or fold brief at
 * round >= 6 is refused: five rounds of findings on one PR is the
 * signal to split the PR into independent pieces, not to fold again.
 * The cap is per PR number in the `pr:` line and ignores any design
 * check on file - a check with `verdict: continue` is not a licence to
 * keep folding. A split piece is a NEW PR: its brief names the piece PR
 * in `pr:` and carries `split-of: <owner>/<repo>#<n>` (the original).
 * `kind: impl` / `land` / `build` briefs are never capped, so landing a
 * PR that already has clean verdicts keeps working. The refusal is an
 * instruction (owner 2026-11-09: a capped PR is split, never put to the
 * owner): it names the next action and the canonical split-brief
 * template, templates/split-brief.md next to this file (SPLIT_TEMPLATE).
 * The template is generic (this repo is public); private specifics go in
 * an optional local addendum, <state>/templates/split-addendum.md, which
 * the refusal names only when that file exists.
 *
 * One round definition and the shrink rule (pc-host #704 R4, R2; owner
 * 2026-11-08: "yes it should be enforced, advisories don't work with
 * agents"). The count is merge-pr.sh's (base-rules.ts): the effective
 * round is the higher of the header's `round:` and the helper's count
 * plus one, so a re-cut cannot understate it. A piece's strictly-smaller
 * test runs ONCE, at the split, on its first reviewed head (owner
 * 2026-11-27: "a split pr should restart at round one that's the whole
 * point"). If it passes there the piece restarts at round 1 for its whole
 * life, whatever paths later folds add; otherwise its rounds continue the
 * parent's count: the inherited round is the parent's count plus the
 * piece's own count plus one (docs/verification.md § Split at round 5),
 * still max'd with the header (a header can raise, never lower). There
 * is no one-split limit: a piece that reaches round 5 splits again. The
 * operator clone's helper carries the `rounds` subcommand since pc-host
 * #730 closed #704 (2026-11-08), so ROUNDS_FROM_HELPER is true and every
 * gated brief's count is read from the helper. The design-check
 * requirement below keys on the same effective round the cap computes -
 * one function, so they cannot drift.
 *
 * No round on a red or unpushed head (pc-host #704 R1/R3). A `kind: lens`
 * brief carries `head: <40-hex>`; it is refused unless that sha is the
 * PR's current head on GitHub and a passing run is bound to it (a
 * gate-record comment for that head, or a `green-run: <path>` summary
 * whose result:, run-on and dirty lines grep clean). Every check fails
 * closed.
 *
 * The absorb-head green-run relaxation. A brief that reviews the absorb
 * head H' may cite the CI run produced on the head H the absorb was built
 * from (`absorb-of: <40-hex>`): with `absorb-of: H` present exactly once,
 * H different from `head:`, and EVERY `green-run:` summary naming H, the
 * run-on check accepts H in place of H'. That is sound because
 * `tools/merge-pr.sh absorb` reports `absorb-check: PASS` (the PR delta is
 * byte-identical to the reviewed head) and the pass carries the reviewed
 * verdicts forward in its own `absorb-check: PASS ... reviewed=<H>` line,
 * so the merge bar does not need the ~13-16 min container run on H'. The
 * reviewed head must still be the PR's current head; without `absorb-of:`
 * a summary on another sha refuses with the unchanged message, and a
 * summary that names no sha, a dirty live-worktree run, and a malformed or
 * repeated `absorb-of:` line all still refuse.
 *
 * Absorb exemption (owner ruling 2026-11-08, "ideally this process should
 * not require me"): a capped PR must still take in main before it merges,
 * and when merge-pr.sh's absorb check asks for a trio, that trio reviews
 * the absorb, not new work. A `kind: lens` brief whose header carries
 * `absorb-of: <40-hex merge commit>` is exempt from the cap; it still
 * needs the design check for its odd round, like any lens round. Folds
 * stay capped: code beyond the absorb at round >= 6 is a split piece.
 * The exemption is bound (#719 trust-model F1): the sha must be a merge
 * commit on the PR branch with one parent reachable from origin/main,
 * read from the PR's own repo clone after a fetch (base-rules.ts
 * repoClone: `<clones root>/<owner>--<repo>`, never pc-host's clone for
 * another repo's PR). Nothing more is checked -
 * the exemption is about which round it is, not about the absorb's
 * content - so a bogus or foreign sha is refused rather than exempted.
 *
 * A fold needs its verdicts posted (owner 2026-11-08: "every review
 * round must be posted on the PR before the next fold brief is accepted,
 * so the merge script's count can't fall behind again"). pc-host #622 ran
 * 15 rounds but only 4 rounds of Lens: verdicts were ever posted, so
 * merge-pr.sh's design_check_rounds (4) fell far behind and the E1 and
 * round-5 rules read the wrong number. A `kind: fold` brief therefore
 * carries `fold-of: <40-hex>`: the head whose lens verdicts it folds. It
 * is refused unless that head has a posted comment whose first non-blank
 * line is `Lens: <lens>: CLEAN|FINDINGS(<n>) @ <that sha>` (the shape
 * merge-pr.sh counts), and unless its round is at most one past the number
 * of distinct heads with posted Lens: comments (the helper's `rounds` list
 * when the operator clone has it, pc-host #730; the comments otherwise).
 * A comment read that fails refuses (fail closed). lens / impl / land /
 * design-check briefs are unaffected.
 *
 * A fold may name an absorb-only round (owner decision 2026-11-25 04h3xZ:
 * note-only fixes are never a round; after an absorb review the FIRST code
 * fix is free - it is part of the absorb round, not a review round - and
 * the free fix resets with each new absorb). merge-pr.sh counts a round
 * only when it authored code, so an absorb round that carried note-only
 * findings is dropped from its list (owner ruling 2026-11-11) and the
 * `fold-of:` rule above would refuse that fold forever: the helper's list
 * can never name the head. Such a fold carries `absorb-of: <40-hex>`
 * instead of `fold-of:` (exactly one of the two). It is accepted only
 * when that head has a posted `Lens: ... @ <head>` comment (read from the
 * PR's comments, never the helper's counted list) AND the helper's own
 * `rounds` output names it as an absorb-only round (its `note: ... do not
 * count ...: <n> <sha>` line); a helper read that fails refuses. Its round
 * must EQUAL the PR's counted review rounds - an absorb adds none - so a
 * note-only fold never moves the round and a code fold on an absorb is the
 * one free fix, which merge-pr.sh does not yet model (its counting of that
 * fix commit is a separate escalation design). A brief with both lines, or
 * neither, is refused with a message naming the one to use. Every
 * `fold-of:` behaviour and message is unchanged.
 *
 * Verdict consistency. The design check's `causing:` answer and its
 * verdict must agree: `causing: yes` means the design IS the source of
 * the churn, so `verdict: continue` contradicts the answer (that is how
 * pc-host #697 reached round 17 on `causing: yes` + `continue`). A
 * check whose `causing:` value starts with "yes" must carry
 * `verdict: cut` or `verdict: redesign`.
 *
 * Owner rule (pc-host plan 2026-11-07, E1): every odd round from r3
 * (3, 5, 7, ...) carries a design-check comment bound to that round,
 * written from a fixed template with three answers (scope still what
 * the goal needs; is the design causing the findings; same class open
 * elsewhere) plus a verdict continue / cut / redesign. The steering
 * side refuses a brief write until the latest required check exists:
 *
 *   <state>/design-checks/<owner>--<repo>-<pr>-r<N>.md
 *
 * where N is the latest odd round <= the brief's effective round (r3
 * for rounds 3-4, r5 for 5-6, ...). The file is checked with a simple line-key
 * scan (scope:, design:, class: non-empty; verdict:
 * continue|cut|redesign) - deliberately not a YAML parser.
 *
 * The same rule owns the brief header contract: every write into the
 * briefs directory must carry `pr:`, `round:`, `kind:` in its
 * leading block (see brief-gates.ts). A brief with no readable header
 * is refused with the contract in the message.
 *
 * Surfaces: write / edit tools, `tee`, and a `bash -c` / `sh -c`
 * payload that redirects or tees into the briefs dir. A top-level
 * `cat > brief.md` redirect is invisible to pi-steering bash rules
 * (documented in brief-gates.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PredicateContext } from "@cad0p/pi-steering";
import type { BriefWrite, DesignCheckStatus } from "./brief-gates.ts";
import {
	absorbBindingRefusal,
	commitParents,
	ghBin,
	lensHeadRefusal,
	mergeHelper,
	postedLensRounds,
	prHead,
	repoClone,
	roundsCount,
	splitPr,
} from "./base-rules.ts";
import type { BriefHeader } from "./brief-gates.ts";
import {
	briefContent,
	briefsDir,
	stateDir,
	briefWrites,
	designCheckPath,
	designCheckStatus,
	firstBriefWrite,
	headerBlock,
	headerReason,
	isGatedKind,
	parseBriefHeader,
	requiredDesignCheckRound,
	unverifiableReason,
} from "./brief-gates.ts";
import { splitShrinkVerdict } from "./split-restart.ts";

declare global {
	interface PiSteeringPredicates {
		briefNeedsDesignCheck: import("@cad0p/pi-steering").PredicateShape<boolean>;
	}
}

/** Round 6+ on the same PR: split it (owner rule: split at round 5). */
export const ROUND_CAP = 6;

/**
 * The canonical split-brief template, versioned next to this rule (owner
 * 2026-11-09: a capped PR is split, never put to the owner; splitting
 * stalled partly because there was no ready-made brief). Resolved from this
 * module so the refusal names the file that ships with the rule; the test
 * pins that it exists and that its header passes the brief-header gate.
 */
export const SPLIT_TEMPLATE = fileURLToPath(
	new URL("./templates/split-brief.md", import.meta.url),
);

/**
 * The optional local addendum to the public template: private specifics
 * (local paths, never-list, notes steps) kept out of this public repo.
 * Lives in the state dir; the refusal names it only when it exists.
 */
export function splitAddendumPath(): string {
	return join(stateDir(), "templates", "split-addendum.md");
}

/** The round-cap message: an instruction with the next action, not a question. */
function roundCapReason(
	pr: string,
	round: number,
	why: string | null,
): string {
	const number = pr.split("#")[1] ?? "<n>";
	const tail =
		why === null
			? `A split piece is a new PR whose brief header carries split-of: ${pr} and restarts at round 1 only when its one split-time test passes: changed paths a subset of the parent's and changed lines strictly fewer at its first reviewed head. That verdict is frozen for the piece's whole life, whatever later folds add; otherwise it inherits the parent's round count. There is no one-split limit: a piece that reaches round 5 splits again.`
			: why;
	const addendum = splitAddendumPath();
	const local = existsSync(addendum)
		? ` Apply the local addendum ${addendum} too.`
		: "";
	return `round ${round} on ${pr}: split the PR into independent pieces (owner rule: split at round 5). This is an instruction, not a question: do not ask the owner. Next action: launch a split author from the template ${SPLIT_TEMPLATE} (fill every <...> and write it with the write tool to ${join(briefsDir(), `${number}-split.md`)}).${local} ${tail}`;
}

/**
 * The round this brief effectively is (pc-host #704 R2/R4): the helper's
 * count of the PR's own rounds plus one, max'd with the header's round (a
 * header can raise, never lower) - and, for a split piece that is not
 * strictly smaller, the parent's count plus the piece's own count plus
 * one, again max'd with the header (docs/verification.md § Split at round
 * 5: the piece's rounds continue the parent's count, so parent 3 + own 1
 * is round 5, not the 4 a max-of-two computes). A piece restarts at round
 * 1 only when its one frozen split-time verdict says it was strictly
 * smaller than its parent on its first reviewed head. The cap and the
 * design-check requirement both read this one function, so they cannot
 * drift. Every count is merge-pr.sh's own `rounds` list, and a check
 * that cannot run is an error: the caller refuses (fail closed).
 */
function effectiveRound(
	header: BriefHeader,
):
	| { ok: true; round: number; inherited: boolean }
	| { ok: false; err: string } {
	const pr = header.pr ?? "";
	const headerRound = header.round ?? 0;
	let inherited = false;
	let parentCount = 0;
	if (header.splitOfKey !== null) {
		const parent = header.splitOfKey;
		const shrink = splitShrinkVerdict(header);
		if (!shrink.ok) {
			return {
				ok: false,
				err: `${shrink.err}; a piece restarts at round 1 only when its frozen split-time verdict is strictly smaller, so the cap cannot be evaluated (fail closed)`,
			};
		}
		if (!shrink.comparison.smaller) {
			const outside = shrink.comparison.outside;
			const why =
				outside.length > 0
					? `it changed ${outside.length} path(s) its parent did not at the split (${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ", ..." : ""})`
					: "its changed lines were not strictly fewer than its parent's at the split";
			const parentRounds = roundsCount(parent);
			if (!parentRounds.ok) {
				return {
					ok: false,
					err: `the round count of the split parent ${parent} could not be read (${parentRounds.err}); a piece that was not strictly smaller at the split (${why}) inherits it, so the cap cannot be evaluated (fail closed)`,
				};
			}
			parentCount = parentRounds.count;
			inherited = true;
		}
	}
	const own = roundsCount(pr);
	if (!own.ok) {
		return {
			ok: false,
			err: `the round count of ${pr} could not be read (${own.err}); the cap reads merge-pr.sh rounds and refuses when it cannot (fail closed)`,
		};
	}
	const round = inherited
		? Math.max(headerRound, parentCount + own.count + 1)
		: Math.max(headerRound, own.count + 1);
	return { ok: true, round, inherited };
}

/** Every `absorb-of:` value in the brief's header block, in order. */
function absorbOfValues(content: string): string[] {
	const values: string[] = [];
	for (const line of headerBlock(content)) {
		const m = /^absorb-of:\s*(.*?)\s*$/i.exec(line);
		if (m) values.push(m[1] ?? "");
	}
	return values;
}

/** Every `green-run:` path in the brief's header block, in order. */
function greenRunValues(content: string): string[] {
	const values: string[] = [];
	for (const line of headerBlock(content)) {
		const m = /^green-run:\s*(.*?)\s*$/i.exec(line);
		if (m !== null && (m[1] ?? "") !== "") values.push(m[1] ?? "");
	}
	return values;
}

/**
 * The first non-blank line of every PR comment, extracted by jq exactly as
 * base-rules.ts does it for its comment fallback (lens_bucket_json's own
 * split, drop CR, skip blank, trim). Kept here because an `absorb-of:` fold
 * reads the PR's comments even when the helper carries the `rounds`
 * subcommand: the helper's counted list drops the absorb-only round this
 * fold must see, so its list is the wrong answer for that check.
 */
const FIRST_LINE_JQ =
	'.[] | [.body // "" | split("\\n")[] | gsub("\\r"; "") | select(test("\\\\S")) | gsub("^\\\\s+|\\\\s+$"; "")][0] // ""';

/**
 * A posted lens verdict's first line: merge-pr.sh's lens_bucket_json shape
 * (`(CLEAN|FINDINGS(n)) @ <40-hex>`, case-insensitive, whitespace around
 * the @), anchored on the line - the same shape base-rules.ts counts.
 */
const LENS_VERDICT_LINE =
	/^Lens:.*?(?:CLEAN|FINDINGS\([0-9]+\))\s*@\s*([0-9a-f]{40})$/i;

/** The first line of a command's output, trimmed; "" when it printed none. */
function firstOutputLine(stdout: string | null, stderr: string | null): string {
	const err = (stderr ?? "").trim();
	const out = (stdout ?? "").trim();
	return ((err !== "" ? err : out).split("\n")[0] ?? "").trim();
}

/**
 * The heads carrying a posted `Lens: ... @ <head>` comment on the PR: the
 * comment count postedLensRounds falls back to, read here directly (a
 * `Maintainer:` first line is skipped, as the helper's bucket skips the
 * maintainer's own passes). A read that fails is an error (fail closed).
 */
function postedLensCommentHeads(
	header: BriefHeader,
): { ok: true; heads: string[] } | { ok: false; err: string } {
	if (header.owner === null || header.repo === null || header.number === null) {
		return { ok: false, err: `not a PR ref: ${header.pr ?? "<none>"}` };
	}
	const result = spawnSync(
		ghBin(),
		[
			"api",
			"--paginate",
			`repos/${header.owner}/${header.repo}/issues/${header.number}/comments`,
			"--jq",
			FIRST_LINE_JQ,
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	if (result.error !== undefined) {
		return { ok: false, err: result.error.message || "gh api could not run" };
	}
	if (result.status !== 0) {
		return {
			ok: false,
			err:
				firstOutputLine(result.stdout, result.stderr) ||
				`gh api returned ${result.status ?? -1}`,
		};
	}
	const heads: string[] = [];
	for (const line of (result.stdout ?? "").split("\n")) {
		const first = line.trim();
		if (first === "" || /^Maintainer:/i.test(first)) continue;
		const match = LENS_VERDICT_LINE.exec(first);
		const head = match?.[1]?.toLowerCase() ?? "";
		if (head !== "" && !heads.includes(head)) heads.push(head);
	}
	return { ok: true, heads };
}

/**
 * The helper's `rounds` output, both halves: the counted rounds on stdout,
 * and on stderr nothing that is parsed. The dropped heads are read from
 * `rounds --absorb-only` instead and classified by GIT, never by the note's
 * prose (pc-host #1626): the list is the complement of the counted rounds -
 * every dropped head, bare, both kinds - and the parent count says which one
 * a head is, two parents for an absorb merge and one for the free code fix on
 * it. Prose is exactly what a second reader drifts on: the free-fix note line
 * is deliberately worded without "do not count", so a parser keyed on that
 * phrase cannot silently read a fix as an absorb. A run that fails, a stdout
 * line that is not `<round> <40-hex>`, a `--absorb-only` line that is not a
 * bare head, or a head that cannot be read in the repo's clone is an error:
 * `absorb-of:` narrows the round rule, so a read it cannot make leaves the
 * fold refused (fail closed).
 */
function helperRoundsAndAbsorbOnly(header: BriefHeader):
	| { ok: true; heads: string[]; absorbOnly: string[]; freeFixes: string[] }
	| { ok: false; err: string } {
	if (header.owner === null || header.repo === null || header.number === null) {
		return { ok: false, err: `not a PR ref: ${header.pr ?? "<none>"}` };
	}
	const result = spawnSync(
		mergeHelper(),
		["rounds", `${header.owner}/${header.repo}`, String(header.number)],
		{ encoding: "utf8", timeout: 60_000 },
	);
	if (result.error !== undefined) {
		return {
			ok: false,
			err: result.error.message || `${mergeHelper()} rounds could not run`,
		};
	}
	if (result.status !== 0) {
		return {
			ok: false,
			err:
				firstOutputLine(result.stdout, result.stderr) ||
				`${mergeHelper()} rounds failed`,
		};
	}
	const heads: string[] = [];
	for (const line of (result.stdout ?? "").split("\n")) {
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
	const parts = splitPr(header.pr ?? "");
	if (parts === null) {
		return { ok: false, err: "not a PR ref: " + (header.pr ?? "<none>") };
	}
	const clone = repoClone(parts.repo);
	if (!clone.ok) return { ok: false, err: clone.err };
	const drops = spawnSync(
		mergeHelper(),
		[
			"rounds",
			"--absorb-only",
			header.owner + "/" + header.repo,
			String(header.number),
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	if (drops.error !== undefined) {
		return {
			ok: false,
			err:
				drops.error.message ||
				mergeHelper() + " rounds --absorb-only could not run",
		};
	}
	if (drops.status !== 0) {
		return {
			ok: false,
			err:
				firstOutputLine(drops.stdout, drops.stderr) ||
				mergeHelper() + " rounds --absorb-only failed",
		};
	}
	const absorbOnly: string[] = [];
	const freeFixes: string[] = [];
	for (const line of (drops.stdout ?? "").split("\n")) {
		const head = line.trim();
		if (head === "") continue;
		if (!/^[0-9a-f]{40}$/.test(head)) {
			return {
				ok: false,
				err:
					"the helper's --absorb-only list is not a bare head per line: " +
					head,
			};
		}
		if (absorbOnly.includes(head) || freeFixes.includes(head)) continue;
		const parents = commitParents(head, clone.path);
		if (!parents.ok) {
			return {
				ok: false,
				err:
					"the dropped head " +
					head +
					" could not be read in the " +
					parts.repo +
					" clone (" +
					parents.err +
					"): the parent count is the only thing that tells an absorb round from the free fix on it (fail closed)",
			};
		}
		if (parents.parents.length === 2) absorbOnly.push(head);
		else if (parents.parents.length === 1) freeFixes.push(head);
		else {
			return {
				ok: false,
				err:
					"the dropped head " +
					head +
					" has " +
					String(parents.parents.length) +
					" parents; a dropped head is the two-parent absorb merge or the one-parent free fix on it",
			};
		}
	}
	return { ok: true, heads, absorbOnly, freeFixes };
}

/**
 * A fold of an absorb-only round (owner decision 2026-11-25): the head must
 * carry a posted Lens: verdict AND the helper's own output must name it as
 * an absorb-only round, and the round must be the PR's counted review
 * rounds - an absorb adds none, so the free code fix stays in that round.
 */
function absorbFoldRefusal(
	header: BriefHeader,
	absorbOf: string,
): string | null {
	const pr = header.pr ?? "";
	const posted = postedLensCommentHeads(header);
	if (!posted.ok) {
		return `the lens verdicts posted on ${pr} could not be read (${posted.err}); a fold may not fold rounds that cannot be shown posted (fail closed)`;
	}
	if (!posted.heads.includes(absorbOf)) {
		return `the absorb-of head ${absorbOf} has no 'Lens: <lens>: CLEAN|FINDINGS(<n>) @ ${absorbOf}' comment on ${pr}: post that round's verdicts on the PR first, then write the fold brief`;
	}
	const helper = helperRoundsAndAbsorbOnly(header);
	if (!helper.ok) {
		return `the absorb-only rounds of ${pr} could not be read from ${mergeHelper()} (${helper.err}); 'absorb-of: ${absorbOf}' is accepted only when the helper names that head as an absorb-only round (fail closed)`;
	}
	if (!helper.absorbOnly.includes(absorbOf)) {
		return helper.heads.includes(absorbOf)
			? `the absorb-of head ${absorbOf} is one of the ${helper.heads.length} counted review round(s) on ${pr}: a fold of a counted round names it with 'fold-of: ${absorbOf}', not 'absorb-of:'`
			: `the helper's rounds for ${pr} name ${absorbOf} neither as a counted round nor as an absorb-only one (its note line names ${helper.absorbOnly.length === 0 ? "none" : helper.absorbOnly.join(", ")}): post the absorb round's Lens verdicts on the PR, or name a counted round with 'fold-of:'`;
	}
	// The absorb is a standing anchor only while it IS the head (pc-host #1626):
	// once the free code fix is pushed, a second 'absorb-of: <absorb>' fold would
	// fold a head that is no longer the PR's, and the fix rides in the absorb
	// round, so the fold of the fix's own findings names the fix with 'fold-of:'.
	const current = prHead(pr);
	if (!current.ok) {
		return "the head of " + pr + " could not be read (" + current.err + "); 'absorb-of: " + absorbOf + "' is accepted only while the PR head is still that absorb (fail closed)";
	}
	if (current.sha !== absorbOf) {
		return "the absorb-of head " + absorbOf + " is not the head of " + pr + " (it is at " + current.sha + "): the one free code fix rides in the absorb round, so a fold of its findings names the fix with 'fold-of: " + current.sha + "' at round " + String(helper.heads.length + 1);
	}
	const round = header.round;
	if (round !== null && round !== helper.heads.length) {
		return `round ${round} on ${pr} is not the PR's counted review round: the absorb round adds none, so ${pr} is at round ${helper.heads.length}; write 'round: ${helper.heads.length}' in the fold brief (owner decision 2026-11-25: a note-only fix is never a round)`;
	}
	return null;
}

/**
 * A fold folds verdicts that are already posted (owner 2026-11-08): the
 * header's `fold-of:` head must carry a posted Lens: verdict on the PR, and
 * the round may not run more than one past the rounds posted there, so
 * merge-pr.sh's design_check_rounds cannot fall behind the review chain
 * (pc-host #622: 15 rounds, 4 posted). A comment read that fails refuses.
 * An absorb-only round is folded with `absorb-of:` instead (owner decision
 * 2026-11-25): exactly one of the two lines, never both.
 */
function foldVerdictRefusal(
	header: BriefHeader,
	absorbOf: string | null,
): string | null {
	if (header.kind !== "fold" || header.pr === null) return null;
	const foldOf = header.foldOf;
	if (foldOf !== null && absorbOf !== null) {
		return `a fold brief carries both 'fold-of: ${foldOf}' and 'absorb-of: ${absorbOf}': write exactly one - 'fold-of: <40-hex>' for a counted review round, or 'absorb-of: <40-hex>' for the absorb of main whose round the helper does not count (owner decision 2026-11-25: a note-only fix is never a round)`;
	}
	if (foldOf === null && absorbOf === null) {
		return `a fold brief needs 'fold-of: <40-hex>' in its header, naming the head whose lens verdicts it folds (every review round must be posted on the PR before the next fold brief): write 'fold-of: <sha>' for a counted review round, or 'absorb-of: <sha>' when the folded round is the absorb of main (owner decision 2026-11-25: a note-only fix is never a round)`;
	}
	if (absorbOf !== null) return absorbFoldRefusal(header, absorbOf);
	if (foldOf === null || !/^[0-9a-f]{40}$/.test(foldOf)) {
		return `a fold brief needs 'fold-of: <40-hex>' in its header, naming the head whose lens verdicts it folds (every review round must be posted on the PR before the next fold brief): write 'fold-of: ${foldOf ?? "<sha>"}'`;
	}
	const posted = postedLensRounds(header.pr);
	if (!posted.ok) {
		return `the lens verdicts posted on ${header.pr} could not be read (${posted.err}); a fold may not fold rounds that cannot be shown posted (fail closed)`;
	}
	// The accepted heads are the counted rounds AND the one free code fix a
	// passed absorb round carries (pc-host #1626): the helper drops the fix from
	// its counted list by design, so a fold of the fix's re-check findings would
	// otherwise be refused forever with "has no Lens comment" - the comment is
	// there, the helper just no longer lists the head as a round.
	const helper = helperRoundsAndAbsorbOnly(header);
	if (!helper.ok) {
		return "the dropped heads of " + String(header.pr) + " could not be read from " + mergeHelper() + " (" + helper.err + "); 'fold-of: " + foldOf + "' is accepted for a counted round or for the free code fix of an absorb round (fail closed)";
	}
	if (!posted.heads.includes(foldOf) && !helper.freeFixes.includes(foldOf)) {
		return `the fold-of head ${foldOf} has no 'Lens: <lens>: CLEAN|FINDINGS(<n>) @ ${foldOf}' comment on ${header.pr}: post that round's verdicts on the PR first, then write the fold brief`;
	}
	const round = header.round;
	if (round !== null && round > posted.heads.length + 1) {
		return `round ${round} on ${header.pr} is more than one past the ${posted.heads.length} round(s) posted on the PR (${posted.heads.join(", ")}): post the earlier rounds' verdicts first, or write the fold brief at round ${posted.heads.length + 1}`;
	}
	return null;
}

/** `causing: yes` + `verdict: continue` is a contradiction. */
function verdictConflictReason(
	need: number,
	status: DesignCheckStatus,
): string | null {
	if (status.verdict !== "continue") return null;
	if (status.causing === null || !/^yes/i.test(status.causing)) return null;
	return `design check r${need} says the design is causing the churn (causing: yes) but verdict: continue; the verdict must be cut or redesign`;
}

/** Why this brief write is refused, or null when it passes. */
function writeBlockReason(write: BriefWrite): string | null {
	const content = briefContent(write);
	if (content === null) return unverifiableReason(write);
	const header = parseBriefHeader(content);
	if (!header.complete || header.pr === null) return headerReason(write);
	if (!header.splitOfValid) {
		return `split-of must be a PR ref ('split-of: <owner>/<repo>#<n>'), not '${header.splitOf ?? ""}'.`;
	}
	const absorbOfs = absorbOfValues(content);
	if (absorbOfs.length > 1) {
		return `absorb-of must appear exactly once: this brief carries ${absorbOfs.length} 'absorb-of:' lines (${absorbOfs.join(", ")}); keep the one absorb merge commit.`;
	}
	const absorbOf = absorbOfs[0] ?? null;
	if (absorbOf !== null && !/^[0-9a-f]{40}$/.test(absorbOf)) {
		return `absorb-of must be the absorb merge commit as 40 lowercase hex ('absorb-of: <sha>'), not '${absorbOf}'.`;
	}
	const absorbLens = absorbOf !== null && header.kind === "lens";
	if (absorbLens && absorbOf !== null) {
		const binding = absorbBindingRefusal(absorbOf, header.pr);
		if (binding !== null) return binding;
	}
	if (header.kind === "lens") {
		const lens = lensHeadRefusal(header.head, header.greenRun, header.pr, {
			absorbOf,
			greenRuns: greenRunValues(content),
		});
		if (lens !== null) return lens;
	}
	// The fold's verdicts are checked before the cap: a round that is ahead
	// of what is posted is the diagnosis the author can act on.
	const fold = foldVerdictRefusal(header, absorbOf);
	if (fold !== null) return fold;
	// The effective round is computed once for the cap and the design
	// check (one function, so they cannot drift): a count that cannot be
	// read refuses the brief before either use (fail closed). An absorb
	// lens is exempt from the cap but still owes the design check its
	// effective round computes.
	let effective: { round: number; inherited: boolean } | null = null;
	if (isGatedKind(header.kind) && header.round !== null) {
		const eff = effectiveRound(header);
		if (!eff.ok) return eff.err;
		effective = eff;
	}
	if (!absorbLens && effective !== null && effective.round >= ROUND_CAP) {
		return roundCapReason(
			header.pr ?? "",
			effective.round,
			effective.inherited
				? `It inherits its split parent ${header.splitOfKey} round count.`
				: null,
		);
	}
	if (effective === null || effective.round < 3) {
		return null;
	}
	const need = requiredDesignCheckRound(effective.round);
	const path = designCheckPath(header, need);
	const status = designCheckStatus(path);
	if (!status.exists) {
		return `design check required for ${header.pr} r${need}: create ${path} with 'scope:', 'design:', 'class:' answers and 'verdict: continue|cut|redesign' (every odd round from r3).`;
	}
	if (status.missing.length > 0) {
		return `design check ${path} is incomplete: add ${status.missing.join(", ")} (scope:, design:, class:, verdict: continue|cut|redesign).`;
	}
	return verdictConflictReason(need, status);
}

export const designCheckGatePlugin = {
	name: "brief-design-check",
	predicates: {
		briefNeedsDesignCheck: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			return briefWrites(ctx).some(
				(write) => writeBlockReason(write) !== null,
			);
		},
	},
};

function reason(ctx: PredicateContext): string {
	const write = firstBriefWrite(ctx);
	if (write === null) return headerReason(null);
	return writeBlockReason(write) ?? headerReason(write);
}

export const designCheckRules = [
	{
		name: "design-check-gate",
		tool: "write" as const,
		field: "path" as const,
		// `pattern` cannot see the briefs dir, so it must not pre-filter:
		// the predicate resolves the path and does the exact check.
		pattern: /^/,
		when: { briefNeedsDesignCheck: true },
		reason,
	},
	{
		name: "design-check-gate-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: /^/,
		when: { briefNeedsDesignCheck: true },
		reason,
	},
	{
		name: "design-check-gate-bash",
		tool: "bash" as const,
		command: ["tee", "bash", "sh"] as const,
		when: { briefNeedsDesignCheck: true },
		reason,
	},
];
