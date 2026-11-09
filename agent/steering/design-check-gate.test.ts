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
	lensHeaderLines,
	OTHER_HEAD,
	postLensVerdicts,
	postedHeads,
} from "./lens-test-stubs.ts";

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

function header(pr: string, round: number, kind = "lens", extra = ""): string {
	return `pr: ${pr}\nround: ${round}\nkind: ${kind}\n${lensHeaderLines(state)}${extra}`;
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
	return `pr: ${PR}\nround: ${round}\nkind: fold\nfold-of: ${foldOf}\n${extra}`;
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
		assert.deepEqual(keys, ["pr", "round", "kind", "split-of", "Threat model"]);
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
		designCheck(PR, 5);
		postLensVerdicts(state, postedHeads(6));
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r6-absorb-fold.md"),
					content: foldHeader(
						6,
						postedHeads(6)[0] ?? LENS_HEAD,
						`absorb-of: ${"c".repeat(40)}\n`,
					),
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

	it("allows a round-5 lens brief with the r5 check on file", async () => {
		designCheck(PR, 5);
		await expectAllows(harness, {
			write: { path: briefPath("p1-r5-lens.md"), content: header(PR, 5) },
			cwd: "/tmp",
		});
	});

	it("allows a split piece at round 2 whose header carries split-of", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("piece-r2-lens.md"),
				content: header("cad0p/pc-host#700", 2, "lens", `split-of: ${PR}\n`),
			},
			cwd: "/tmp",
		});
	});

	it("still caps the piece PR at round 6 (split-of is lineage, not an exemption)", async () => {
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
		process.env.PI_H4_HELPER_ROUNDS = "1";
		setHelperRounds(2);
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
