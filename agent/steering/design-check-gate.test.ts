// SPDX-License-Identifier: MIT
// Global pi-steering config — E1 design-check gate tests.
//
// Owner rule: every brief write in ~/.local/state/h4-orchestration/briefs
// carries a pr/round/kind header, and a lens or fold brief at round >= 3
// is refused until the latest required design-check file exists
// (r3 for rounds 3-4, r5 for 5-6, ...) with the three answers and a
// verdict. The gate covers the write / edit tools, `tee`, and a
// `bash -c` payload that redirects into the briefs dir.
//
// PI_H4_STATE_DIR points every case at a fresh temp state root, so the
// suite never reads or writes the real ~/.local/state/h4-orchestration.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const harness = loadHarness({ config });

let state: string;
let briefs: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-design-check-"));
	briefs = join(state, "briefs");
	mkdirSync(briefs, { recursive: true });
	mkdirSync(join(state, "design-checks"), { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
});

afterEach(() => {
	delete process.env.PI_H4_STATE_DIR;
	rmSync(state, { recursive: true, force: true });
});

function briefPath(name: string): string {
	return join(briefs, name);
}

function header(pr: string, round: number, kind = "lens", extra = ""): string {
	return `pr: ${pr}\nround: ${round}\nkind: ${kind}\n${extra}`;
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
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r5-fold.md"),
				content: header(PR, 5, "fold"),
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
