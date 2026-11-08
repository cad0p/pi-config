// SPDX-License-Identifier: MIT
// pc-host #704 — the base's enforced process rules (base-rules.ts).
//
// Four rules, each red then green:
//
//   R4  one round definition: the cap reads merge-pr.sh's count (the
//       helper's read-only `rounds`), so the header's round can never
//       understate it. Dormant behind ROUNDS_FROM_HELPER until #704
//       merges; PI_H4_ROUNDS_FROM_HELPER=1 drives the live path here.
//   R2  a split piece restarts at round 1 only when it is strictly
//       smaller than its parent; otherwise it inherits the parent's count.
//   R1/R3 a `kind: lens` brief carries `head: <40-hex>`, that sha must be
//       the PR's current head, and a passing run must be bound to it (a
//       gate record for that head, or a green-run summary that is green,
//       clean and run on that head).
//   #719 F1 the absorb-of exemption holds only for a merge commit on the
//       PR branch with one parent reachable from origin/main.
//
// Every check fails closed, so each error path below is a refusal too.
// The stubs (lens-test-stubs.ts) answer gh/git/the helper from a JSON
// file; no case touches the network, a real clone or the operator state.

import assert from "node:assert/strict";
import {
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
import {
	clearLensStubs,
	installLensStubs,
	LENS_HEAD,
	LENS_MAIN,
	OTHER_HEAD,
	passingSummary,
} from "./lens-test-stubs.ts";

const harness = loadHarness({ config });
const PR = "cad0p/pc-host#650";
const PIECE = "cad0p/pc-host#700";
const ABSORB = "a".repeat(40);

let state: string;
let briefs: string;
let stubs: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-base-rules-"));
	briefs = join(state, "briefs");
	mkdirSync(briefs, { recursive: true });
	mkdirSync(join(state, "design-checks"), { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
	installLensStubs(state);
	stubs = join(state, "stubs");
});

afterEach(() => {
	clearLensStubs();
	delete process.env.PI_H4_STATE_DIR;
	rmSync(state, { recursive: true, force: true });
});

/** Edit one of the stub configs in place. */
function editStub(name: "gh" | "git" | "helper", mutate: (value: any) => void): void {
	const path = join(stubs, `${name}.json`);
	const value = JSON.parse(readFileSync(path, "utf8")) as any;
	mutate(value);
	writeFileSync(path, JSON.stringify(value));
}

/** The rounds the helper reports for a PR (a list of heads, oldest first). */
function setRounds(pr: string, count: number): void {
	const number = pr.split("#")[1] ?? "";
	editStub("helper", (cfg) => {
		cfg.rounds[number] = Array.from({ length: count }, (_, i) =>
			(i + 5).toString(16).repeat(40).slice(0, 40),
		);
	});
}

/** A lens brief's header; `extra` adds head:, green-run:, split-of:, absorb-of:. */
function lensHeader(round: number, extra = ""): string {
	return `pr: ${PR}\nround: ${round}\nkind: lens\n${extra}`;
}

/** A lens brief header with the head and its passing run: the R1/R3 shape. */
function greenLens(round: number, extra = ""): string {
	return lensHeader(
		round,
		`head: ${LENS_HEAD}\ngreen-run: ${passingSummary(state)}\n${extra}`,
	);
}

function brief(name: string): string {
	return join(briefs, name);
}

function designCheck(pr: string, round: number): void {
	const [repoPart, number] = pr.split("#");
	const [owner, repo] = (repoPart ?? "").split("/");
	writeFileSync(
		join(state, "design-checks", `${owner}--${repo}-${number}-r${round}.md`),
		"scope: still what the goal needs\ndesign: not the cause\nclass: none open elsewhere\nverdict: continue\n",
	);
}

/** A gate-record comment plus the manifest that names the head it bound. */
function gateRecord(head: string): void {
	editStub("gh", (cfg) => {
		cfg.comments = [{ body: "<!-- local-ci-gate:g20261108T000000Z-1 -->\nlocal-ci a,b tree t gate g20261108T000000Z-1" }];
	});
	const dir = join(
		state,
		"pc-merge",
		"evidence",
		"cad0p--pc-host",
		head,
		"g20261108T000000Z-1",
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest"), `head: ${head}\ntree: t\n`);
}

const HEAD_MISSING = /needs 'head: <40-hex>'/;
const HEAD_MISMATCH = /is at [0-9a-f]{40}: push the head/;
const NO_RUN = /no gate-record comment bound to head/;
const COUNT_FAILED = /could not be read .*fail closed/s;
const PIECE_REFUSED = /does not restart .* at round 1/;
const INHERITED =
	/round 6 on cad0p\/pc-host#700: split the PR[\s\S]*inherits its split parent cad0p\/pc-host#650/;
const ABSORB_PARENTS = /is not a merge commit/;
const ABSORB_MAIN = /parents reachable from origin\/main/;
const ABSORB_BRANCH = /is not on the cad0p\/pc-host#650 branch/;

describe("base-rules — R4, one round definition (the helper's count)", () => {
	it("keeps the count path dormant by default (the live steering is untouched)", async () => {
		setRounds(PR, 5);
		await expectAllows(harness, {
			write: { path: brief("p1-r1-lens.md"), content: greenLens(1) },
			cwd: "/tmp",
		});
	});

	it("blocks a round-1 lens brief when the helper already counts 5 rounds", async () => {
		process.env.PI_H4_ROUNDS_FROM_HELPER = "1";
		setRounds(PR, 5);
		await expectBlocks(
			harness,
			{ write: { path: brief("p1-r1-lens.md"), content: greenLens(1) }, cwd: "/tmp" },
			{ rule: "design-check-gate", reason: /round 6 on cad0p\/pc-host#650: split the PR/ },
		);
	});

	it("allows a round-1 lens brief when the helper counts 2 rounds", async () => {
		process.env.PI_H4_ROUNDS_FROM_HELPER = "1";
		setRounds(PR, 2);
		await expectAllows(harness, {
			write: { path: brief("p1-r1-lens.md"), content: greenLens(1) },
			cwd: "/tmp",
		});
	});

	it("fails closed when the helper's count fails", async () => {
		process.env.PI_H4_ROUNDS_FROM_HELPER = "1";
		editStub("helper", (cfg) => {
			cfg.fail[PR.split("#")[1] ?? ""] = true;
		});
		await expectBlocks(
			harness,
			{ write: { path: brief("p1-r1-lens.md"), content: greenLens(1) }, cwd: "/tmp" },
			{ rule: "design-check-gate", reason: /the round count of cad0p\/pc-host#650 could not be read/ },
		);
	});
});

describe("base-rules — R2, a re-cut must shrink", () => {
	it("allows a strictly smaller piece at round 1", async () => {
		await expectAllows(harness, {
			write: {
				path: brief("piece-r1-lens.md"),
				content: greenLens(1, `split-of: ${PR}\n`).replace(PR, PIECE),
			},
			cwd: "/tmp",
		});
	});

	it("blocks a piece that changes a path its parent does not", async () => {
		editStub("gh", (cfg) => {
			cfg.prs["700"].paths = ["tools/other.sh"];
		});
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("piece-r1-lens.md"),
					content: greenLens(1, `split-of: ${PR}\n`).replace(PR, PIECE),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: PIECE_REFUSED },
		);
	});

	it("blocks a piece whose changed lines are not strictly fewer", async () => {
		editStub("gh", (cfg) => {
			cfg.prs["700"].lines = 40;
		});
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("piece-r1-lens.md"),
					content: greenLens(1, `split-of: ${PR}\n`).replace(PR, PIECE),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /changed lines are not strictly fewer/ },
		);
	});

	it("makes a non-shrinking piece inherit its parent's count", async () => {
		process.env.PI_H4_ROUNDS_FROM_HELPER = "1";
		editStub("gh", (cfg) => {
			cfg.prs["700"].lines = 40;
		});
		setRounds(PR, 5);
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("piece-r1-lens.md"),
					content: greenLens(1, `split-of: ${PR}\n`).replace(PR, PIECE),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: INHERITED },
		);
	});

	it("still lets a strictly smaller piece restart at round 1 under a capped parent", async () => {
		process.env.PI_H4_ROUNDS_FROM_HELPER = "1";
		setRounds(PR, 5);
		await expectAllows(harness, {
			write: {
				path: brief("piece-r1-lens.md"),
				content: greenLens(1, `split-of: ${PR}\n`).replace(PR, PIECE),
			},
			cwd: "/tmp",
		});
	});
});

describe("base-rules — R1/R3, no round on a red or unpushed head", () => {
	it("blocks a lens brief with no head line", async () => {
		await expectBlocks(
			harness,
			{ write: { path: brief("p1-r1-lens.md"), content: lensHeader(1) }, cwd: "/tmp" },
			{ rule: "design-check-gate", reason: HEAD_MISSING },
		);
	});

	it("blocks a lens brief whose head is not the PR's head", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r1-lens.md"),
					content: lensHeader(1, `head: ${OTHER_HEAD}\n${"green-run: " + passingSummary(state)}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: HEAD_MISMATCH },
		);
	});

	it("fails closed when the PR's head cannot be read", async () => {
		editStub("gh", (cfg) => {
			cfg.prs["650"].head_fail = true;
		});
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r1-lens.md"),
					content: lensHeader(1, `head: ${LENS_HEAD}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /could not be read .*fail closed/s },
		);
	});

	it("blocks a lens brief with no passing run bound to the head", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r1-lens.md"),
					content: lensHeader(1, `head: ${LENS_HEAD}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: NO_RUN },
		);
	});

	it("allows a lens brief whose green-run summary is green, clean and on that head", async () => {
		await expectAllows(harness, {
			write: {
				path: brief("p1-r1-lens.md"),
				content: lensHeader(
					1,
					`head: ${LENS_HEAD}\ngreen-run: ${passingSummary(state)}\n`,
				),
			},
			cwd: "/tmp",
		});
	});

	it("blocks a green-run summary whose result is not PASS", async () => {
		const path = passingSummary(state);
		writeFileSync(
			path,
			`run on:    snapshot commit ${LENS_HEAD} tree ${"3".repeat(40)}\nworktree dirty after run: no\nresult: FAIL\n`,
		);
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r1-lens.md"),
					content: lensHeader(1, `head: ${LENS_HEAD}\ngreen-run: ${path}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /does not hold exactly one 'result: PASS'/ },
		);
	});

	it("blocks a green-run summary that ran on another head", async () => {
		const path = passingSummary(state, OTHER_HEAD);
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r1-lens.md"),
					content: lensHeader(1, `head: ${LENS_HEAD}\ngreen-run: ${path}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /did not run on head/ },
		);
	});

	it("blocks a green-run summary from a dirty worktree", async () => {
		const path = passingSummary(state);
		writeFileSync(
			path,
			`run on:    snapshot commit ${LENS_HEAD} tree ${"3".repeat(40)}\nworktree dirty after run: yes\nresult: PASS\n`,
		);
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r1-lens.md"),
					content: lensHeader(1, `head: ${LENS_HEAD}\ngreen-run: ${path}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /ran on a dirty worktree/ },
		);
	});

	it("allows a lens brief whose head carries a gate record", async () => {
		gateRecord(LENS_HEAD);
		await expectAllows(harness, {
			write: {
				path: brief("p1-r1-lens.md"),
				content: lensHeader(1, `head: ${LENS_HEAD}\n`),
			},
			cwd: "/tmp",
		});
	});

	it("blocks a gate record bound to another head", async () => {
		gateRecord(OTHER_HEAD);
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r1-lens.md"),
					content: lensHeader(1, `head: ${LENS_HEAD}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: NO_RUN },
		);
	});
});

describe("base-rules — absorb-of binding (#719 trust-model F1)", () => {
	it("allows a round-6 absorb lens whose sha is an absorb merge", async () => {
		designCheck(PR, 5);
		await expectAllows(harness, {
			write: {
				path: brief("p1-r6-absorb.md"),
				content: greenLens(6, `absorb-of: ${ABSORB}\n`),
			},
			cwd: "/tmp",
		});
	});

	it("blocks an absorb-of that is not a merge commit", async () => {
		editStub("git", (cfg) => {
			cfg.commits[ABSORB] = { parents: [LENS_HEAD] };
		});
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r6-absorb.md"),
					content: lensHeader(6, `absorb-of: ${ABSORB}\nhead: ${LENS_HEAD}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: ABSORB_PARENTS },
		);
	});

	it("blocks an absorb-of with no parent reachable from origin/main", async () => {
		editStub("git", (cfg) => {
			cfg.commits[ABSORB] = { parents: [LENS_HEAD, OTHER_HEAD] };
			cfg.ancestors[`${OTHER_HEAD} ${LENS_MAIN}`] = false;
		});
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r6-absorb.md"),
					content: lensHeader(6, `absorb-of: ${ABSORB}\nhead: ${LENS_HEAD}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: ABSORB_MAIN },
		);
	});

	it("blocks an absorb-of that is not on the PR branch", async () => {
		editStub("git", (cfg) => {
			cfg.ancestors[`${ABSORB} ${LENS_HEAD}`] = false;
		});
		await expectBlocks(
			harness,
			{
				write: {
					path: brief("p1-r6-absorb.md"),
					content: lensHeader(6, `absorb-of: ${ABSORB}\nhead: ${LENS_HEAD}\n`),
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: ABSORB_BRANCH },
		);
	});
});
