// SPDX-License-Identifier: MIT
// Global pi-steering config — E1 design-check gate tests.
//
// Owner rule: every brief write in ~/.local/state/h4-orchestration/briefs
// carries a pr/round/kind header, and a lens or fold brief at round >= 3
// is refused until the latest required design-check file exists
// (r3 for rounds 3-4, r5 for 5-6, ...) with the three answers and a
// verdict. A lens or fold brief at round >= 6 is refused outright
// (owner rule: split at round 5; a split piece is a new PR with
// `split-of: <pr>` in its header and starts again at round 1), and a
// check that answers `causing: yes` may not carry `verdict: continue`.
// The gate covers the write / edit tools, `tee`, and a
// `bash -c` payload that redirects into the briefs dir.
//
// PI_H4_STATE_DIR points every case at a fresh temp state root, so the
// suite never reads or writes the real ~/.local/state/h4-orchestration.

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import { parseBriefHeader } from "./brief-gates.ts";
import { SPLIT_TEMPLATE, splitAddendumPath } from "./design-check-gate.ts";
import {
	clearLensStubs,
	failGhComments,
	installLensStubs,
	LENS_HEAD,
	LENS_MAIN,
	visionFor,
	lensHeaderLines,
	OTHER_HEAD,
	passingSummary,
	postLensVerdicts,
	postedHeads,
} from "./lens-test-stubs.ts";

/** The VISION REVIEW section every lens brief carries (pc-host #983). */
const VISION = visionFor("cad0p/pc-host#650", LENS_HEAD);

const harness = loadHarness({ config });

let state: string;
let briefs: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-design-check-"));
	briefs = join(state, "briefs");
	mkdirSync(briefs, { recursive: true });
	mkdirSync(join(state, "design-checks"), { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
	// pc-host #704: a lens brief carries its head and a passing run, so the
	// gate needs the gh/git/helper seams from the first write on.
	installLensStubs(state);
});

afterEach(() => {
	delete process.env.PI_H4_STATE_DIR;
	clearLensStubs();
	rmSync(state, { recursive: true, force: true });
});

function briefPath(name: string): string {
	return join(briefs, name);
}

/** The pre-launch consumers line every brief header now carries. */
const CONSUMERS =
	"consumers: none — pre-launch: no tenant slices run; no compatibility window is owed";

function header(pr: string, round: number, kind = "lens", extra = ""): string {
	return `pr: ${pr}\nround: ${round}\nkind: ${kind}\n${CONSUMERS}\n${lensHeaderLines(state)}${extra}\n${visionFor(pr, LENS_HEAD)}\n`;
}

/**
 * A fold brief's header: pr/round/kind plus `fold-of:`, the head whose lens
 * verdicts it folds (which must be posted on the PR first).
 */
function foldHeader(
	round: number,
	foldOf: string = LENS_HEAD,
	extra = "",
): string {
	return `pr: ${PR}\nround: ${round}\nkind: fold\n${CONSUMERS}\nfold-of: ${foldOf}\n${extra}`;
}

/** The stub helper's rounds for the suite's PR (one head per round). */
function setHelperRounds(count: number): void {
	const path = join(state, "stubs", "helper.json");
	const cfg = JSON.parse(readFileSync(path, "utf8")) as {
		rounds: Record<string, string[]>;
	};
	cfg.rounds["650"] = postedHeads(count);
	writeFileSync(path, JSON.stringify(cfg));
}

/** The stub helper's rounds for any PR (one head per round). */
function setHelperRoundsFor(pr: string, count: number): void {
	const number = pr.split("#")[1] ?? "";
	const path = join(state, "stubs", "helper.json");
	const cfg = JSON.parse(readFileSync(path, "utf8")) as {
		rounds: Record<string, string[]>;
	};
	cfg.rounds[number] = postedHeads(count);
	writeFileSync(path, JSON.stringify(cfg));
}

/** The diff the repo clone reports for `head` against the stub main. */
function setDiffAtHead(
	head: string,
	rows: Array<[additions: number, deletions: number, path: string]>,
): void {
	const path = join(state, "stubs", "git.json");
	const cfg = JSON.parse(readFileSync(path, "utf8")) as {
		diffs?: Record<string, { paths: string[]; numstat: string[] }>;
	};
	cfg.diffs ??= {};
	cfg.diffs[`${LENS_MAIN}..${head}`] = {
		paths: rows.map((row) => row[2]),
		numstat: rows.map((row) => `${row[0]}\t${row[1]}\t${row[2]}`),
	};
	writeFileSync(path, JSON.stringify(cfg));
}

/** The gh stub's changed-line count for a PR (the current diff). */
function setGhLines(pr: string, lines: number): void {
	const number = pr.split("#")[1] ?? "";
	const path = join(state, "stubs", "gh.json");
	const cfg = JSON.parse(readFileSync(path, "utf8")) as {
		prs: Record<string, { lines: number }>;
	};
	cfg.prs[number] = { ...(cfg.prs[number] ?? { lines: 0 }), lines };
	writeFileSync(path, JSON.stringify(cfg));
}

/** Write a design-check file for `pr` at `round`; returns its path. */
function designCheck(pr: string, round: number, body?: string): string {
	const [repoPart, number] = pr.split("#");
	const [owner, repo] = (repoPart ?? "").split("/");
	const path = join(
		state,
		"design-checks",
		`${owner}--${repo}-${number}-r${round}.md`,
	);
	writeFileSync(
		path,
		body ??
			"scope: still what the goal needs\ndesign: not the cause\nclass: none open elsewhere\nverdict: continue\n",
	);
	return path;
}

const PR = "cad0p/pc-host#650";
const MESSAGE = /design check required/;
const HEADER_MESSAGE = /briefs need a header/;

describe("design-check-gate — write tool", () => {
	it("allows a round-2 lens brief (no design check yet)", async () => {
		await expectAllows(harness, {
			write: { path: briefPath("p1-r2-lens.md"), content: header(PR, 2) },
			cwd: "/tmp",
		});
	});

	it("blocks a round-3 lens brief without the r3 design check", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r3-lens.md"), content: header(PR, 3) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: MESSAGE },
		);
	});

	it("allows a round-4 lens brief when the r3 design check exists", async () => {
		designCheck(PR, 3);
		await expectAllows(harness, {
			write: { path: briefPath("p1-r4-lens.md"), content: header(PR, 4) },
			cwd: "/tmp",
		});
	});

	it("blocks a round-4 lens brief whose r3 check has no verdict", async () => {
		designCheck(PR, 3, "scope: ok\ndesign: ok\nclass: none\n");
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r4-lens.md"), content: header(PR, 4) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /is incomplete: add verdict/ },
		);
	});

	it("blocks a round-5 lens brief when only r3 exists (r5 is required)", async () => {
		designCheck(PR, 3);
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r5-lens.md"), content: header(PR, 5) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /r5/ },
		);
	});

	it("allows a round-5 fold brief when the r5 design check exists", async () => {
		designCheck(PR, 5);
		postLensVerdicts(state, postedHeads(4));
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r5-fold.md"),
				content: foldHeader(5, postedHeads(4)[0] ?? LENS_HEAD),
			},
			cwd: "/tmp",
		});
	});

	it("blocks a headerless brief with the header contract", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("no-header.md"),
					content: "# Just a title\n\nbody\n",
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: HEADER_MESSAGE },
		);
	});

	it("blocks a brief whose header lacks the round", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("partial.md"),
					content: `pr: ${PR}\nkind: lens\n`,
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: HEADER_MESSAGE },
		);
	});

	it("allows a kind: impl brief at round 5 (only lens/fold are gated)", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r5-impl.md"),
				content: header(PR, 5, "impl"),
			},
			cwd: "/tmp",
		});
	});

	it("allows a write outside the briefs directory", async () => {
		await expectAllows(harness, {
			write: {
				path: join(state, "notes", "x.md"),
				content: "no header needed here\n",
			},
			cwd: "/tmp",
		});
	});
});

describe("design-check-gate — round cap (owner rule: split at round 5)", () => {
	it("blocks a round-6 lens brief even when the r5 check is clean", async () => {
		designCheck(PR, 5);
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r6-lens.md"), content: header(PR, 6) },
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /round 6 on cad0p\/pc-host#650: split the PR into independent pieces/,
			},
		);
	});

	it("tells the agent to split from a template that exists, not to ask the owner", async () => {
		designCheck(PR, 5);
		const result = await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r6-lens.md"), content: header(PR, 6) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /do not ask the owner/ },
		);
		const reason = String((result as { reason?: unknown }).reason ?? "");
		assert.match(reason, /Next action: launch a split author from the template /);
		assert.ok(
			reason.includes(join(briefs, "650-split.md")),
			`names the brief to write: ${reason}`,
		);
		assert.match(reason, /split-of: cad0p\/pc-host#650 and restarts at round 1/);
		const named = /from the template (\S+\.md) /.exec(reason)?.[1];
		assert.ok(named !== undefined, `names a template path: ${reason}`);
		assert.equal(named, SPLIT_TEMPLATE);
		assert.ok(existsSync(named), `the named template exists: ${named}`);
		assert.doesNotMatch(reason, /addendum/, "no addendum file, no addendum clause");
	});

	it("names the local addendum only when it exists in the state dir", async () => {
		designCheck(PR, 5);
		const addendum = splitAddendumPath();
		assert.equal(addendum, join(state, "templates", "split-addendum.md"));
		mkdirSync(join(state, "templates"), { recursive: true });
		writeFileSync(addendum, "local specifics\n");
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r6-lens.md"), content: header(PR, 6) },
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: new RegExp(`\\)\\. Apply the local addendum ${addendum.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} too\\. A split piece`),
			},
		);
	});

	it("keeps the public template generic (no private paths, projects or ids)", () => {
		const template = readFileSync(SPLIT_TEMPLATE, "utf8");
		for (const needle of ["/home/", "Goldmine", "pc-host", "14107574", "/data/tmp", "pc-merge", "cad0p", "pier"]) {
			assert.ok(
				!template.toLowerCase().includes(needle.toLowerCase()),
				`templates/split-brief.md is public and must not contain '${needle}'`,
			);
		}
	});

	it("ships a template whose filled header passes the brief gates and carries split-of", async () => {
		const template = readFileSync(SPLIT_TEMPLATE, "utf8");
		const lead = template.split(/\r?\n\r?\n/)[0] ?? "";
		const keys = lead.split(/\r?\n/).map((l) => l.split(":")[0]);
		// The fields the round cap and the header contract read.
		assert.deepEqual(keys, [
			"pr",
			"round",
			"kind",
			"split-of",
			"consumers",
			"Threat model",
		]);
		assert.match(template, /do not put the PR to the owner/);
		// Unfilled, it is refused in briefs/ (placeholders fail the header).
		await expectBlocks(
			harness,
			{ write: { path: briefPath("650-split.md"), content: template }, cwd: "/tmp" },
			{ rule: "design-check-gate" },
		);
		const filled = template
			.replaceAll("<owner>", "cad0p")
			.replaceAll("<repo>", "pc-host")
			.replaceAll("<N>", "650")
			.replace(/<the parent PR's threat-model section>/, "verification-base#control-plane");
		const parsed = parseBriefHeader(filled);
		assert.equal(parsed.complete, true);
		assert.equal(parsed.pr, PR);
		assert.equal(parsed.round, 1);
		assert.equal(parsed.kind, "impl");
		assert.equal(parsed.splitOfValid, true);
		assert.equal(parsed.splitOfKey, PR);
		await expectAllows(harness, {
			write: { path: briefPath("650-split.md"), content: filled },
			cwd: "/tmp",
		});
	});

	it("blocks a round-7 fold brief (its verdicts posted, the cap still applies)", async () => {
		designCheck(PR, 7);
		postLensVerdicts(state, postedHeads(7));
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r7-fold.md"),
					content: foldHeader(7, postedHeads(7)[0] ?? LENS_HEAD),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /split the PR into independent pieces/ },
		);
	});

	it("allows a round-6 impl brief (landing is not capped)", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r6-impl.md"),
				content: header(PR, 6, "impl"),
			},
			cwd: "/tmp",
		});
	});

	it("allows a round-6 absorb lens (absorb-of: <sha>) with the r5 check on file", async () => {
		designCheck(PR, 5);
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r6-absorb-lens.md"),
				content: header(PR, 6, "lens", `absorb-of: ${"a".repeat(40)}\n`),
			},
			cwd: "/tmp",
		});
	});

	it("still requires the r7 design check for a round-7 absorb lens", async () => {
		designCheck(PR, 5);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r7-absorb-lens.md"),
					content: header(PR, 7, "lens", `absorb-of: ${"b".repeat(40)}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: MESSAGE },
		);
	});

	it("keeps a round-6 fold capped even with absorb-of (folds are split pieces)", async () => {
		// An absorb-only fold is still a fold: the owner decision (2026-11-25)
		// makes one code fix free inside the absorb round, it does not exempt the
		// PR from the round-5 split. Exactly one of fold-of / absorb-of, so this
		// brief names the absorb round alone.
		designCheck(PR, 5);
		const counted = postedHeads(6);
		const absorbHead = postedHeads(7)[6] ?? LENS_HEAD;
		postLensVerdicts(state, [...counted, absorbHead]);
		const path = join(state, "stubs", "helper.json");
		const cfg = JSON.parse(readFileSync(path, "utf8")) as {
			rounds: Record<string, string[]>;
			absorb_only?: Record<string, string[]>;
		};
		cfg.rounds["650"] = counted;
		cfg.absorb_only = {
			...(cfg.absorb_only ?? {}),
			"650": [`7 ${absorbHead}`],
		};
		writeFileSync(path, JSON.stringify(cfg));
		// The absorb is the PR's head: \`absorb-of:\` is a head binding (pc-host
		// #1626), so a brief naming an absorb the PR has moved past is refused by
		// that rule and never reaches the cap this case measures.
		const ghPath = join(state, "stubs", "gh.json");
		const gh = JSON.parse(readFileSync(ghPath, "utf8")) as {
			default_head: string;
			prs: Record<string, { head: string }>;
		};
		gh.default_head = absorbHead;
		gh.prs["650"] = { ...(gh.prs["650"] ?? {}), head: absorbHead };
		writeFileSync(ghPath, JSON.stringify(gh));
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r6-absorb-fold.md"),
					content: `pr: ${PR}\nround: 6\nkind: fold\n${CONSUMERS}\nabsorb-of: ${absorbHead}\n`,
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /split the PR into independent pieces/ },
		);
	});

	it("blocks a malformed absorb-of value", async () => {
		designCheck(PR, 5);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r6-absorb-bad.md"),
					content: header(PR, 6, "lens", "absorb-of: 1234abc\n"),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /absorb-of must be the absorb merge commit/ },
		);
	});

	// The absorb-head green-run relaxation: the brief reviews the absorb head
	// H' (the PR's current head) and cites the CI run produced on the head H
	// the absorb was built from, declared in 'absorb-of: H'. The PR's delta is
	// byte-identical to the reviewed head, so the fresh container run is not
	// the bar.
	const ABSORB_HEAD = OTHER_HEAD;
	const THIRD_HEAD = "7".repeat(40);

	/** A lens header carrying exactly the runs the case gives it (plus absorb-of). */
	function absorbHeader(round: number, absorbOf: string, runs: string[]): string {
		const lines = runs.map((path) => `green-run: ${path}\n`).join("");
		return `pr: ${PR}\nround: ${round}\nkind: lens\n${CONSUMERS}\nhead: ${LENS_HEAD}\nabsorb-of: ${absorbOf}\n${lines}${VISION}\n`;
	}

	it("allows a green-run on the absorb-of head when the brief reviews the absorb head", async () => {
		designCheck(PR, 3);
		const run = passingSummary(state, ABSORB_HEAD, "ci-absorb.txt");
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r4-absorb-lens.md"),
				content: absorbHeader(4, ABSORB_HEAD, [run]),
			},
			cwd: "/tmp",
		});
	});

	it("blocks an absorb-of brief whose second green-run names a different sha", async () => {
		designCheck(PR, 3);
		const absorbRun = passingSummary(state, ABSORB_HEAD, "ci-absorb.txt");
		const thirdRun = passingSummary(state, THIRD_HEAD, "ci-third.txt");
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r4-absorb-two-runs.md"),
					content: absorbHeader(4, ABSORB_HEAD, [absorbRun, thirdRun]),
				},
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /names neither head .* nor the absorb-of head/,
			},
		);
	});

	it("blocks a mismatched green-run with today's message when there is no absorb-of", async () => {
		designCheck(PR, 3);
		const run = passingSummary(state, ABSORB_HEAD, "ci-absorb.txt");
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r4-no-absorb.md"),
					content: `pr: ${PR}\nround: 4\nkind: lens\n${CONSUMERS}\nhead: ${LENS_HEAD}\ngreen-run: ${run}\n${VISION}\n`,
				},
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: new RegExp(
					`the green-run summary .* did not run on head ${LENS_HEAD}: its 'run on: snapshot commit <sha> tree <tree>' line names another sha \\(a live-worktree run is never evidence\\)`,
				),
			},
		);
	});

	it("blocks a malformed absorb-of sha (short hex)", async () => {
		designCheck(PR, 3);
		const run = passingSummary(state, ABSORB_HEAD, "ci-absorb.txt");
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r4-absorb-short.md"),
					content: absorbHeader(4, "1234abc", [run]),
				},
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /absorb-of must be the absorb merge commit/,
			},
		);
	});

	it("blocks an absorb-of line that appears twice", async () => {
		designCheck(PR, 3);
		const run = passingSummary(state, ABSORB_HEAD, "ci-absorb.txt");
		const content = `pr: ${PR}\nround: 4\nkind: lens\n${CONSUMERS}\nhead: ${LENS_HEAD}\nabsorb-of: ${ABSORB_HEAD}\nabsorb-of: ${ABSORB_HEAD}\ngreen-run: ${run}\n${VISION}\n`;
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r4-absorb-twice.md"), content },
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /absorb-of must appear exactly once/,
			},
		);
	});

	it("keeps the old binding when head equals absorb-of", async () => {
		designCheck(PR, 3);
		const run = passingSummary(state, THIRD_HEAD, "ci-third.txt");
		const content = `pr: ${PR}\nround: 4\nkind: lens\n${CONSUMERS}\nhead: ${LENS_HEAD}\nabsorb-of: ${LENS_HEAD}\ngreen-run: ${run}\n${VISION}\n`;
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r4-absorb-equal.md"), content },
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /did not run on head .*names another sha/,
			},
		);
	});

	it("allows a round-5 lens brief with the r5 check on file", async () => {
		designCheck(PR, 5);
		await expectAllows(harness, {
			write: { path: briefPath("p1-r5-lens.md"), content: header(PR, 5) },
			cwd: "/tmp",
		});
	});

	it("allows a split piece at round 2 whose header carries split-of", async () => {
		// Round 2 means round 1 is already counted; its head was strictly
		// smaller, so the frozen verdict restarts the piece.
		setDiffAtHead(postedHeads(1)[0] ?? LENS_HEAD, [[10, 0, "tools/example.sh"]]);
		setHelperRoundsFor("cad0p/pc-host#700", 1);
		await expectAllows(harness, {
			write: {
				path: briefPath("piece-r2-lens.md"),
				content: header("cad0p/pc-host#700", 2, "lens", `split-of: ${PR}\n`),
			},
			cwd: "/tmp",
		});
	});

	it("still caps the piece PR at round 6 (split-of is lineage, not an exemption)", async () => {
		setDiffAtHead(postedHeads(1)[0] ?? LENS_HEAD, [[10, 0, "tools/example.sh"]]);
		setHelperRoundsFor("cad0p/pc-host#700", 5);
		designCheck("cad0p/pc-host#700", 5);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("piece-r6-lens.md"),
					content: header(
						"cad0p/pc-host#700",
						6,
						"lens",
						`split-of: ${PR}\n`,
					),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /round 6 on cad0p\/pc-host#700/ },
		);
	});

	it("blocks a malformed split-of value", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("piece-bad.md"),
					content: header(PR, 2, "lens", "split-of: #611\n"),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /split-of must be a PR ref/ },
		);
	});

	it("demands the r5 design check when a header of 2 understates an effective round of 5", async () => {
		// The piece was already non-shrinking at its first reviewed head (40
		// lines, the parent's size), so it inherits: parent 3 + own 1 + 1 = 5.
		// The design check requirement keys on that effective round, not the
		// header's 2, so the r5 check is owed even though round 2 would owe
		// nothing. The current diff is deliberately non-shrinking too; the
		// frozen first-head verdict, not a re-test, is what decides.
		setDiffAtHead(postedHeads(1)[0] ?? LENS_HEAD, [[40, 0, "tools/example.sh"]]);
		setGhLines("cad0p/pc-host#700", 40);
		setHelperRoundsFor(PR, 3);
		setHelperRoundsFor("cad0p/pc-host#700", 1);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("piece-r2-understated.md"),
					content: header("cad0p/pc-host#700", 2, "lens", `split-of: ${PR}\n`),
				},
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /design check required for cad0p\/pc-host#700 r5/,
			},
		);
	});
});

describe("design-check-gate — a fold needs its verdicts posted", () => {
	// pc-host #622: 15 rounds, but only 4 rounds of Lens: verdicts were ever
	// posted, so merge-pr.sh's design_check_rounds read 4 and the E1 and
	// round-5 rules read the wrong number. A fold brief now names the head it
	// folds (`fold-of:`) and is refused until that head's verdict is on the
	// PR, and until its round is at most one past the rounds posted there.

	const FOLD_MISSING = /a fold brief needs 'fold-of: <40-hex>'/;
	const NOT_POSTED = /has no 'Lens: <lens>: CLEAN\|FINDINGS\(<n>\) @/;
	const AHEAD = /is more than one past the \d+ round\(s\) posted on the PR/;
	const READ_FAILED = /could not be read .*fail closed/s;

	it("blocks a fold brief with no fold-of line", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-fold.md"),
					content: header(PR, 2, "fold"),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: FOLD_MISSING },
		);
	});

	it("blocks a fold-of that is not a 40-hex sha", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-fold.md"),
					content: foldHeader(2, "1234abc"),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: FOLD_MISSING },
		);
	});

	it("blocks a fold whose head has no posted verdict", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r2-fold.md"), content: foldHeader(2) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: NOT_POSTED },
		);
	});

	it("blocks a fold whose verdicts are posted for another head", async () => {
		postLensVerdicts(state, [OTHER_HEAD]);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-fold.md"),
					content: foldHeader(2, LENS_HEAD),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: NOT_POSTED },
		);
	});

	it("blocks a fold at round 4 when only one round is posted", async () => {
		designCheck(PR, 3);
		postLensVerdicts(state, postedHeads(1));
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r4-fold.md"), content: foldHeader(4) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: AHEAD },
		);
	});

	it("fails closed when the PR's comments cannot be read", async () => {
		failGhComments(state);
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r2-fold.md"), content: foldHeader(2) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: READ_FAILED },
		);
	});

	it("allows a fold whose head's verdict is posted", async () => {
		postLensVerdicts(state, postedHeads(1));
		await expectAllows(harness, {
			write: { path: briefPath("p1-r2-fold.md"), content: foldHeader(2) },
			cwd: "/tmp",
		});
	});

	it("counts a FINDINGS(n) verdict as a posted round", async () => {
		postLensVerdicts(state, postedHeads(1), { findings: 3 });
		await expectAllows(harness, {
			write: { path: briefPath("p1-r2-fold.md"), content: foldHeader(2) },
			cwd: "/tmp",
		});
	});

	it("allows a fold one round past what is posted", async () => {
		designCheck(PR, 3);
		postLensVerdicts(state, postedHeads(3));
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r4-fold.md"),
				content: foldHeader(4, postedHeads(3)[2] ?? LENS_HEAD),
			},
			cwd: "/tmp",
		});
	});

	it("reads the helper's rounds list when it carries the subcommand (#730)", async () => {
		// Nothing is posted on the stub PR: only the helper's list can green it.
		// Two counted rounds make the fold effectively round 3, so the r3
		// design check is owed (the requirement keys on the effective round).
		process.env.PI_H4_HELPER_ROUNDS = "1";
		setHelperRounds(2);
		designCheck(PR, 3);
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r2-fold.md"),
				content: foldHeader(2, postedHeads(2)[1] ?? LENS_HEAD),
			},
			cwd: "/tmp",
		});
	});

	it("fails closed when the helper's rounds list fails", async () => {
		process.env.PI_H4_HELPER_ROUNDS = "1";
		const path = join(state, "stubs", "helper.json");
		const cfg = JSON.parse(readFileSync(path, "utf8")) as {
			fail: Record<string, boolean>;
		};
		cfg.fail["650"] = true;
		writeFileSync(path, JSON.stringify(cfg));
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r2-fold.md"), content: foldHeader(2) },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: READ_FAILED },
		);
	});
});

describe("design-check-gate — a merge-train gate counts for its member heads", () => {
	// pc-tenant #603: a train gates ONE candidate commit, so its manifest sits
	// under the candidate head and never under a member head. The helper posts
	// its binding comment (and so the marker) on every member PR, which is how
	// the rule finds it, and `train-pieces:` is what names the member heads.
	const TRAIN_GATE = "g20261124T073540Z-2326198";
	const TRAIN_CANDIDATE = "7".repeat(40);
	const TRAIN_TREE = "8".repeat(40);
	const OTHER_PIECE = "9".repeat(40);

	/** A lens brief with a head and no green-run: the gate-record path decides. */
	function trainBrief(): string {
		return `pr: ${PR}\nround: 2\nkind: lens\n${CONSUMERS}\nhead: ${LENS_HEAD}\n${VISION}\n`;
	}

	/**
	 * The train gate's manifest, under its candidate head, plus the binding
	 * comment the helper posts on each member PR (its marker is the gate id).
	 */
	function trainGate(
		opts: { result?: string; pieces?: string } = {},
	): void {
		const { result = "PASS", pieces = `650:${LENS_HEAD}` } = opts;
		const dir = join(
			state,
			"pc-merge",
			"evidence",
			"cad0p",
			"pc-host",
			TRAIN_CANDIDATE,
			TRAIN_GATE,
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "manifest"),
			[
				"repo: cad0p/pc-host",
				"pr: 650",
				`head: ${TRAIN_CANDIDATE}`,
				`tree: ${TRAIN_TREE}`,
				`result: ${result}`,
				`gate-run: ${TRAIN_GATE}`,
				"train-gate-kind: candidate",
				`train-pieces: ${pieces}`,
				"",
			].join("\n"),
		);
		const cfgPath = join(state, "stubs", "gh.json");
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
			comments?: Array<{ body: string }>;
		};
		cfg.comments = [
			...(cfg.comments ?? []),
			{
				body: `<!-- local-ci-gate:${TRAIN_GATE} -->\nlocal-ci a,b tree ${TRAIN_TREE} gate ${TRAIN_GATE}\ntrain-gate-kind: candidate\ntrain-pieces: ${pieces}`,
			},
		];
		writeFileSync(cfgPath, JSON.stringify(cfg));
	}

	it("accepts the train's PASS gate that lists this PR's head", async () => {
		trainGate({
			pieces: `598:${OTHER_PIECE} 650:${LENS_HEAD}`,
		});
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r2-lens-train.md"),
				content: trainBrief(),
			},
			cwd: "/tmp",
		});
	});

	it("still refuses a train gate whose result is FAIL", async () => {
		trainGate({ result: "FAIL", pieces: `650:${LENS_HEAD}` });
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-lens-train-fail.md"),
					content: trainBrief(),
				},
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /is not PASS and lists 650:/,
			},
		);
	});

	it("still refuses a train gate that lists this head for another PR", async () => {
		trainGate({ pieces: `598:${LENS_HEAD}` });
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-lens-train-other.md"),
					content: trainBrief(),
				},
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason:
					/no merge-train gate manifest lists '650:1111[\s\S]*is PASS and lists 598:/,
			},
		);
	});

	it("still refuses when no train gate lists this head at all", async () => {
		trainGate({ pieces: `598:${OTHER_PIECE} 595:${"6".repeat(40)}` });
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-lens-train-absent.md"),
					content: trainBrief(),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /no merge-train gate manifest lists '650:1111/ },
		);
	});
});

describe("design-check-gate — verdict consistency (causing vs verdict)", () => {
	it("blocks causing: yes with verdict: continue", async () => {
		designCheck(
			PR,
			5,
			"scope: ok\ndesign: causing the churn\ncausing: yes (probe environment != login environment)\nclass: probe-environment\nverdict: continue\n",
		);
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r5-lens.md"), content: header(PR, 5) },
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason:
					/design check r5 says the design is causing the churn \(causing: yes\) but verdict: continue; the verdict must be cut or redesign/,
			},
		);
	});

	it("allows causing: partly with verdict: continue", async () => {
		designCheck(
			PR,
			5,
			"scope: ok\ndesign: partly causing\ncausing: partly (absorb churn, not the design)\nclass: absorb-only\nverdict: continue\n",
		);
		await expectAllows(harness, {
			write: { path: briefPath("p1-r5-lens.md"), content: header(PR, 5) },
			cwd: "/tmp",
		});
	});

	it("allows causing: yes with verdict: cut", async () => {
		designCheck(
			PR,
			5,
			"scope: ok\ndesign: causing the churn\ncausing: yes\nclass: static-precedence-mirror\nverdict: cut\n",
		);
		postLensVerdicts(state, postedHeads(4));
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r5-fold.md"),
				content: foldHeader(5, postedHeads(4)[0] ?? LENS_HEAD),
			},
			cwd: "/tmp",
		});
	});
});

describe("design-check-gate — edit tool", () => {
	it("blocks an edit that moves a brief to round 3 without the r3 check", async () => {
		const path = briefPath("p1-edit.md");
		writeFileSync(path, header(PR, 2));
		await expectBlocks(
			harness,
			{
				edit: {
					path,
					edits: [{ oldText: "round: 2", newText: "round: 3" }],
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate-edit", reason: MESSAGE },
		);
	});

	it("allows an edit on a round-3 brief once r3 exists", async () => {
		const path = briefPath("p1-edit-ok.md");
		writeFileSync(path, header(PR, 3));
		designCheck(PR, 3);
		await expectAllows(harness, {
			edit: {
				path,
				edits: [{ oldText: "kind: lens", newText: "kind: lens\nnote: x" }],
			},
			cwd: "/tmp",
		});
	});

	it("blocks an edit that strips the header", async () => {
		const path = briefPath("p1-strip.md");
		writeFileSync(path, header(PR, 2));
		await expectBlocks(
			harness,
			{
				edit: {
					path,
					edits: [
						{
							oldText: `pr: ${PR}\nround: 2\nkind: lens\n`,
							newText: "# no header\n",
						},
					],
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate-edit", reason: HEADER_MESSAGE },
		);
	});
});

describe("design-check-gate — bash surface", () => {
	it("blocks tee into a new brief (content is not verifiable)", async () => {
		await expectBlocks(
			harness,
			{ command: `tee ${briefPath("tee-new.md")}`, cwd: "/tmp" },
			{ rule: "design-check-gate-bash", reason: /cannot verify the brief header/ },
		);
	});

	it("allows tee -a on an existing round-2 brief with a valid header", async () => {
		const path = briefPath("tee-append.md");
		writeFileSync(path, header(PR, 2));
		await expectAllows(harness, {
			command: `tee -a ${path}`,
			cwd: "/tmp",
		});
	});

	it("blocks tee -a on an existing headerless brief", async () => {
		const path = briefPath("tee-headerless.md");
		writeFileSync(path, "# no header\n");
		await expectBlocks(
			harness,
			{ command: `tee -a ${path}`, cwd: "/tmp" },
			{ rule: "design-check-gate-bash", reason: HEADER_MESSAGE },
		);
	});

	it("blocks a bash -c heredoc redirect at round 3 without the design check", async () => {
		const path = briefPath("wrapper-r3.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${header(PR, 3)}EOF"`;
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "design-check-gate-bash", reason: MESSAGE },
		);
	});

	it("allows a bash -c heredoc redirect at round 2", async () => {
		const path = briefPath("wrapper-r2.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${header(PR, 2)}EOF"`;
		await expectAllows(harness, { command, cwd: "/tmp" });
	});

	it("blocks a bash -c heredoc redirect with no header", async () => {
		const path = briefPath("wrapper-no-header.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n# no header\nEOF"`;
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "design-check-gate-bash", reason: HEADER_MESSAGE },
		);
	});

	it("known gap: a top-level redirect target is invisible to bash rules", async () => {
		// pi-steering evaluates one extracted ref at a time: `cat` carries
		// no redirect target. The wrapper form above IS gated; a bare
		// redirect is not (documented in brief-gates.ts).
		const path = briefPath("top-level-gap.md");
		const command = `cat > ${path} <<'EOF'\n${header(PR, 3)}EOF`;
		await expectAllows(harness, { command, cwd: "/tmp" });
	});
});

describe("design-check-gate — a fold may name an absorb-only round (owner decision 2026-11-25)", () => {
	// pc-tenant #616: review round 1 at ac306734..., then an absorb of main at
	// e2f362b5... whose Lens verdicts are posted and whose findings are
	// note-only. merge-pr.sh counts ONE round and names the absorb round in its
	// note line, so a fold of those findings has no `fold-of:` head to name:
	// the owner decision (2026-11-25 04h3xZ) makes it the absorb round, not a
	// new one. The round must equal the counted rounds, so a note-only fold
	// never moves it, and a code fold on an absorb is the one free fix.

	const REVIEW_HEAD = postedHeads(2)[0] ?? LENS_HEAD;
	const ABSORB_HEAD = postedHeads(2)[1] ?? OTHER_HEAD;
	const BOTH = /carries both 'fold-of: .* and 'absorb-of:/;
	const USE_ABSORB = /or 'absorb-of: <sha>' when the folded round is the absorb of main/;
	const ABSORB_NOT_POSTED =
		/the absorb-of head [0-9a-f]{40} has no 'Lens: <lens>: CLEAN\|FINDINGS\(<n>\) @/;
	const COUNTED_ROUND = /is one of the \d+ counted review round\(s\) on .*: a fold of a counted round names it with 'fold-of:/;
	const ROUND_WRONG = /is not the PR's counted review round: the absorb round adds none, so .* is at round 1/;
	const HELPER_FAILED = /absorb-only rounds of .* could not be read from .*absorb-only round \(fail closed\)/;

	/** The stub PR's head, moved: the absorb-of binding is a head binding (pc-host #1626). */
	function setPrHead(sha: string): void {
		const path = join(state, "stubs", "gh.json");
		const cfg = JSON.parse(readFileSync(path, "utf8")) as {
			default_head: string;
			prs: Record<string, { head: string }>;
		};
		cfg.default_head = sha;
		cfg.prs["650"] = { ...(cfg.prs["650"] ?? {}), head: sha };
		writeFileSync(path, JSON.stringify(cfg));
	}

	/** A commit the git stub reads with the parents the case gives it. */
	function setCommitParents(sha: string, parents: string[]): void {
		const path = join(state, "stubs", "git.json");
		const cfg = JSON.parse(readFileSync(path, "utf8")) as {
			commits: Record<string, { parents: string[] }>;
		};
		cfg.commits[sha] = { parents };
		writeFileSync(path, JSON.stringify(cfg));
	}

	/** A fold brief naming the absorb round in `absorb-of:` (nothing else). */
	function absorbFoldHeader(round: number, absorbOf: string = ABSORB_HEAD): string {
		return `pr: ${PR}\nround: ${round}\nkind: fold\n${CONSUMERS}\nabsorb-of: ${absorbOf}\n`;
	}

	/** The stub helper's absorb-only rounds for the suite's PR: a note on stderr. */
	function setAbsorbOnly(pairs: Array<[number, string]>): void {
		const path = join(state, "stubs", "helper.json");
		const cfg = JSON.parse(readFileSync(path, "utf8")) as {
			absorb_only?: Record<string, string[]>;
		};
		cfg.absorb_only = {
			...(cfg.absorb_only ?? {}),
			"650": pairs.map(([round, head]) => `${round} ${head}`),
		};
		writeFileSync(path, JSON.stringify(cfg));
	}

	/** #616's shape on the stub PR: one counted round, one absorb-only round. */
	function pcTenant616Shape(): void {
		postLensVerdicts(state, [REVIEW_HEAD, ABSORB_HEAD]);
		setHelperRounds(1); // the helper's counted list: REVIEW_HEAD only
		setAbsorbOnly([[2, ABSORB_HEAD]]);
		// The absorb is the PR's head, which is what `absorb-of:` is bound to
		// (pc-host #1626): an absorb the PR has moved past is no longer an anchor.
		setPrHead(ABSORB_HEAD);
	}

	it("allows a fold of an absorb-only round (pc-tenant #616's shape)", async () => {
		pcTenant616Shape();
		await expectAllows(harness, {
			write: {
				path: briefPath("p616-r1-absorb-fold.md"),
				content: absorbFoldHeader(1),
			},
			cwd: "/tmp",
		});
	});

	it("blocks an absorb-of head with no posted Lens comment", async () => {
		setHelperRounds(1);
		setAbsorbOnly([[2, ABSORB_HEAD]]);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p616-r1-absorb-fold.md"),
					content: absorbFoldHeader(1),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: ABSORB_NOT_POSTED },
		);
	});

	it("blocks an absorb-of head that is a counted review round", async () => {
		postLensVerdicts(state, [REVIEW_HEAD]);
		setHelperRounds(1); // REVIEW_HEAD is the helper's counted round
		setAbsorbOnly([[2, ABSORB_HEAD]]);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p616-r1-absorb-fold.md"),
					content: absorbFoldHeader(1, REVIEW_HEAD),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: COUNTED_ROUND },
		);
	});

	it("blocks a fold brief carrying both fold-of and absorb-of", async () => {
		pcTenant616Shape();
		const content = `pr: ${PR}\nround: 1\nkind: fold\n${CONSUMERS}\nfold-of: ${REVIEW_HEAD}\nabsorb-of: ${ABSORB_HEAD}\n`;
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p616-r1-absorb-fold.md"), content },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: BOTH },
		);
	});

	it("blocks a fold brief carrying neither fold-of nor absorb-of", async () => {
		pcTenant616Shape();
		const content = `pr: ${PR}\nround: 2\nkind: fold\n${CONSUMERS}\n`;
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p616-r2-fold.md"), content },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: USE_ABSORB },
		);
	});

	it("blocks an absorb-of fold whose round is not the counted round", async () => {
		pcTenant616Shape();
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p616-r2-absorb-fold.md"),
					content: absorbFoldHeader(2),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: ROUND_WRONG },
		);
	});

	it("blocks an absorb-of head the PR has moved past", async () => {
		// The free code fix is pushed on top of the absorb: the absorb is no
		// longer the head, so it is no longer an anchor - the fold of the fix's
		// findings names the fix itself.
		const FIX_HEAD = postedHeads(4)[3] ?? OTHER_HEAD;
		postLensVerdicts(state, [REVIEW_HEAD, ABSORB_HEAD, FIX_HEAD]);
		setHelperRounds(1);
		setAbsorbOnly([[2, ABSORB_HEAD]]);
		setCommitParents(FIX_HEAD, [ABSORB_HEAD]);
		setPrHead(FIX_HEAD);
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1626-r1-absorb-fold.md"),
					content: absorbFoldHeader(1),
				},
				cwd: "/tmp",
			},
			{
				rule: "design-check-gate",
				reason: /is not the head of .*the one free code fix rides in the absorb round/,
			},
		);
	});

	it("allows a fold of the free fix's own findings (pc-host #1626's shape)", async () => {
		// The helper no longer lists the fix as a round, but it is a dropped head
		// with ONE parent: the free code fix on the absorb, whose re-check fold is
		// the next review round.
		const FIX_HEAD = postedHeads(4)[3] ?? OTHER_HEAD;
		postLensVerdicts(state, [REVIEW_HEAD, ABSORB_HEAD, FIX_HEAD]);
		setHelperRounds(1);
		setAbsorbOnly([
			[2, ABSORB_HEAD],
			[3, FIX_HEAD],
		]);
		setCommitParents(FIX_HEAD, [ABSORB_HEAD]);
		setPrHead(FIX_HEAD);
		await expectAllows(harness, {
			write: {
				path: briefPath("p1626-r2-fold.md"),
				content: `pr: ${PR}\nround: 2\nkind: fold\n${CONSUMERS}\nfold-of: ${FIX_HEAD}\n`,
			},
			cwd: "/tmp",
		});
	});

	it("fails closed when the helper's rounds cannot be read", async () => {
		postLensVerdicts(state, [REVIEW_HEAD, ABSORB_HEAD]);
		setHelperRounds(1);
		setAbsorbOnly([[2, ABSORB_HEAD]]);
		const path = join(state, "stubs", "helper.json");
		const cfg = JSON.parse(readFileSync(path, "utf8")) as {
			fail: Record<string, boolean>;
		};
		cfg.fail["650"] = true;
		writeFileSync(path, JSON.stringify(cfg));
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p616-r1-absorb-fold.md"),
					content: absorbFoldHeader(1),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: HELPER_FAILED },
		);
	});
});
