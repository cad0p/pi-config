// SPDX-License-Identifier: MIT
// Global pi-steering config — the pc-host #1099 hunk-approval gates.
//
// Owner 2026-11-28: "this also needs the steering half as well no?" and
// "the split must be a constant reminder" — "at round 3 and 5 the design
// checks are going to say it". Two gates, red-before/green-after:
//
//   1. lens-brief-blocking-hunks — a `kind: lens` brief whose body never
//      asks for the `Blocking-hunks:` verdict line is refused: every hunk
//      a lens does not list is approved by that lens, so the ask may not
//      be forgotten (a hunk that only works with a blocked one is blocking
//      too). The token is read from the body, not the header.
//   2. design-check-partial-merge — a design check at round 3 or 5 (the
//      `-r3` / `-r5` filename the gate reads, rebound spellings included)
//      is refused unless it rules `Partial-merge: yes | no — <reason>`:
//      which approved part lands now, which part goes on as a round-1 split.
//
// PI_H4_STATE_DIR points every case at a fresh temp state root, so the
// suite never reads or writes the real ~/.local/state/h4-orchestration.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import {
	clearLensStubs,
	installLensStubs,
	LENS_HEAD,
	lensHeaderLines,
	visionFor,
} from "./lens-test-stubs.ts";

const harness = loadHarness({ config });

const PR = "cad0p/pc-host#650";
const CONSUMERS =
	"consumers: none — pre-launch: no tenant slices run; no compatibility window is owed";

/** The ask a compliant lens brief carries in its body (pc-host #1099). */
const ASK =
	"Write one line `Blocking-hunks: <hunk ids> | none` (cad0p/pc-host#1099): every hunk you do not list is approved by you; list a hunk that only works with a blocked one too.";

/** The ruling a compliant round-3/5 design check carries. */
const RULING = "Partial-merge: no — both halves still need review; nothing waits on the approved part";

let state: string;
let briefs: string;
let checks: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-hunk-approval-"));
	briefs = join(state, "briefs");
	checks = join(state, "design-checks");
	mkdirSync(briefs, { recursive: true });
	mkdirSync(checks, { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
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

function checkPath(name: string): string {
	return join(checks, name);
}

/**
 * A round-2 lens brief that passes every earlier gate (head + passing run,
 * vision section); `body` is the instructing prose under test.
 */
function lensBrief(body: string): string {
	return `pr: ${PR}\nround: 2\nkind: lens\n${CONSUMERS}\n${lensHeaderLines(state)}\n${visionFor(PR, LENS_HEAD)}\n\n# Review\n\n${body}\n`;
}

/** The standard blocking-hunks ask, as the briefs write it. */
function withAsk(): string {
	return `Review the diff hunk by hunk. ${ASK}`;
}

describe("lens-brief-blocking-hunks — write tool", () => {
	it("blocks a lens brief whose body never asks for Blocking-hunks", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-lens.md"),
					content: lensBrief("Review the diff for findings."),
				},
				cwd: "/tmp",
			},
			{ rule: "lens-brief-blocking-hunks", reason: /Blocking-hunks/ },
		);
	});

	it("the refusal names the ask, the #1551 manifest and the interim shape", async () => {
		const result = await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("p1-r2-lens2.md"),
					content: lensBrief("Review the diff for findings."),
				},
				cwd: "/tmp",
			},
			{ rule: "lens-brief-blocking-hunks" },
		);
		const text = JSON.stringify(result);
		for (const part of [
			"every hunk you do not list is approved by you",
			"only works with a blocked one",
			"merge-pr.sh hunks",
			"#1551",
			"<path>:<start>-<end>",
		]) {
			if (!text.includes(part)) {
				throw new Error(`refusal is missing '${part}': ${text}`);
			}
		}
	});

	it("allows a lens brief whose body asks for the line", async () => {
		await expectAllows(harness, {
			write: { path: briefPath("p1-r2-lens-ok.md"), content: lensBrief(withAsk()) },
			cwd: "/tmp",
		});
	});

	it("blocks a brief that carries the token in the header but never asks in the body", async () => {
		const content = `pr: ${PR}\nround: 2\nkind: lens\n${CONSUMERS}\nBlocking-hunks: none\n${lensHeaderLines(state)}${visionFor(PR, LENS_HEAD)}\n\n# Review\n\nReview the diff for findings.\n`;
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1-r2-header-only.md"), content },
				cwd: "/tmp",
			},
			{ rule: "lens-brief-blocking-hunks", reason: /Blocking-hunks/ },
		);
	});

	it("leaves a non-lens brief (kind: impl) without the token alone", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("p1-r2-impl.md"),
				content: `pr: ${PR}\nround: 2\nkind: impl\n${CONSUMERS}\n\nImplement the fold's fixes.\n`,
			},
			cwd: "/tmp",
		});
	});
});

describe("lens-brief-blocking-hunks — edit tool", () => {
	it("blocks an edit that strips the ask from a compliant brief", async () => {
		const path = briefPath("p1-edit-strip.md");
		writeFileSync(path, lensBrief(withAsk()));
		await expectBlocks(
			harness,
			{
				edit: {
					path,
					edits: [{ oldText: ` ${ASK}`, newText: "" }],
				},
				cwd: "/tmp",
			},
			{ rule: "lens-brief-blocking-hunks-edit", reason: /Blocking-hunks/ },
		);
	});

	it("allows an edit that keeps the ask", async () => {
		const path = briefPath("p1-edit-ok.md");
		writeFileSync(path, lensBrief(withAsk()));
		await expectAllows(harness, {
			edit: {
				path,
				edits: [{ oldText: "Review the diff hunk by hunk.", newText: "Review the whole diff hunk by hunk." }],
			},
			cwd: "/tmp",
		});
	});

	it("allows an edit that adds the ask to a brief that lacked it", async () => {
		const path = briefPath("p1-edit-add.md");
		writeFileSync(path, lensBrief("Review the diff for findings."));
		await expectAllows(harness, {
			edit: {
				path,
				edits: [{ oldText: "Review the diff for findings.", newText: withAsk() }],
			},
			cwd: "/tmp",
		});
	});
});

describe("lens-brief-blocking-hunks — bash surface", () => {
	it("blocks a bash -c heredoc brief without the ask", async () => {
		const path = briefPath("wrapper-no-ask.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${lensBrief("Review the diff for findings.")}EOF"`;
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "lens-brief-blocking-hunks-bash", reason: /Blocking-hunks/ },
		);
	});

	it("allows a bash -c heredoc brief carrying the ask", async () => {
		const path = briefPath("wrapper-ask.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${lensBrief(withAsk())}EOF"`;
		await expectAllows(harness, { command, cwd: "/tmp" });
	});
});

describe("design-check-partial-merge — write tool", () => {
	const BODY =
		"scope: still what the goal needs\ndesign: not the cause\nclass: none open elsewhere\nverdict: continue\n";

	it("blocks a round-3 design check with no Partial-merge ruling", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: checkPath("cad0p--pc-host-650-r3.md"), content: BODY },
				cwd: "/tmp",
			},
			{ rule: "design-check-partial-merge", reason: /Partial-merge/ },
		);
	});

	it("blocks a round-5 design check with no Partial-merge ruling", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: checkPath("cad0p--pc-host-650-r5.md"), content: BODY },
				cwd: "/tmp",
			},
			{ rule: "design-check-partial-merge", reason: /Partial-merge/ },
		);
	});

	it("the refusal says what the ruling decides and whose rule it is", async () => {
		const result = await expectBlocks(
			harness,
			{
				write: { path: checkPath("cad0p--pc-host-650-r3.md"), content: BODY },
				cwd: "/tmp",
			},
			{ rule: "design-check-partial-merge" },
		);
		const text = JSON.stringify(result);
		for (const part of [
			"Partial-merge: yes | no",
			"round-1 split",
			"#1099",
		]) {
			if (!text.includes(part)) {
				throw new Error(`refusal is missing '${part}': ${text}`);
			}
		}
	});

	it("allows a round-3 design check that rules Partial-merge", async () => {
		await expectAllows(harness, {
			write: {
				path: checkPath("cad0p--pc-host-650-r3.md"),
				content: `${BODY}${RULING}\n`,
			},
			cwd: "/tmp",
		});
	});

	it("allows a round-5 rebound design check that rules Partial-merge", async () => {
		await expectAllows(harness, {
			write: {
				path: checkPath("cad0p--pc-host-650-r5-rebound.md"),
				content: `${BODY}${RULING}\n`,
			},
			cwd: "/tmp",
		});
	});

	it("blocks a round-3 rebound design check with no ruling", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: checkPath("cad0p--pc-host-650-r3-rebound.md"), content: BODY },
				cwd: "/tmp",
			},
			{ rule: "design-check-partial-merge", reason: /Partial-merge/ },
		);
	});

	it("leaves a round-1 design check without the token alone", async () => {
		await expectAllows(harness, {
			write: { path: checkPath("cad0p--pc-host-650-r1.md"), content: BODY },
			cwd: "/tmp",
		});
	});

	it("leaves a round-7 design check without the token alone", async () => {
		await expectAllows(harness, {
			write: { path: checkPath("cad0p--pc-host-650-r7.md"), content: BODY },
			cwd: "/tmp",
		});
	});

	it("leaves a design-checks file with no round token alone", async () => {
		await expectAllows(harness, {
			write: { path: checkPath("b5-placement-ruling.md"), content: BODY },
			cwd: "/tmp",
		});
	});
});

describe("design-check-partial-merge — edit tool", () => {
	const BODY =
		"scope: still what the goal needs\ndesign: not the cause\nclass: none open elsewhere\nverdict: continue\n";

	it("blocks an edit that strips the ruling from a compliant round-5 check", async () => {
		const path = checkPath("cad0p--pc-host-650-r5.md");
		writeFileSync(path, `${BODY}${RULING}\n`);
		await expectBlocks(
			harness,
			{
				edit: {
					path,
					edits: [{ oldText: `\n${RULING}`, newText: "" }],
				},
				cwd: "/tmp",
			},
			{ rule: "design-check-partial-merge-edit", reason: /Partial-merge/ },
		);
	});

	it("allows an edit that keeps the ruling", async () => {
		const path = checkPath("cad0p--pc-host-650-r5.md");
		writeFileSync(path, `${BODY}${RULING}\n`);
		await expectAllows(harness, {
			edit: {
				path,
				edits: [{ oldText: "verdict: continue", newText: "verdict: continue\nnext: fold the nits" }],
			},
			cwd: "/tmp",
		});
	});
});

describe("design-check-partial-merge — bash surface", () => {
	const BODY =
		"scope: still what the goal needs\ndesign: not the cause\nclass: none open elsewhere\nverdict: continue\n";

	it("blocks a bash -c heredoc round-3 check without the ruling", async () => {
		const path = checkPath("cad0p--pc-host-650-r3.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${BODY}EOF"`;
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "design-check-partial-merge-bash", reason: /Partial-merge/ },
		);
	});

	it("allows a bash -c heredoc round-3 check carrying the ruling", async () => {
		const path = checkPath("cad0p--pc-host-650-r3.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${BODY}${RULING}\nEOF"`;
		await expectAllows(harness, { command, cwd: "/tmp" });
	});

	it("blocks a truncating tee whose content cannot be verified", async () => {
		const path = checkPath("cad0p--pc-host-650-r3.md");
		await expectBlocks(
			harness,
			{ command: `tee ${path}`, cwd: "/tmp" },
			{ rule: "design-check-partial-merge-bash", reason: /cannot verify/ },
		);
	});
});
