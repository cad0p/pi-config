// SPDX-License-Identifier: MIT
// Global pi-steering config - the vision-review gates (pc-host #983).
//
// A lens verdict carries a 'Vision:' line and the merge helper checks only
// that one EXISTS. So the brief must make the reviewer answer the
// invariants, and the verdict must name them: a trio shipped "Vision: FIT"
// for work treating "the host cannot incus exec into the guest" as a
// defect, when the vision says the host is the adversary and there is no
// host-to-guest execution path to build.
//
// Three gates, red-before/green-after:
//   1. vision-review-section - a lens brief needs the VISION REVIEW
//      section (ids, answer shape, out-of-scope line, FIT | MOSTLY-FIT |
//      UNFIT).
//   2. vision-verdict-shape - a posted 'Vision:' line needs a canonical
//      id and a reason.
//   3. vision-drift-invariant - a proposal to make a host-to-guest path
//      work needs V4; a statement of fact does not.
//
// PI_H4_STATE_DIR and PI_H4_CLONES_ROOT point at a fresh temp root, so the
// suite never reads the operator's real state, clone or vault.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import {
	BLOCKING_HUNKS_ASK,
	clearLensStubs,
	installLensStubs,
	LENS_HEAD,
	lensHeaderLines,
} from "./lens-test-stubs.ts";
import {
	ADVERSARY_INVARIANT,
	driftProposal,
	loadInvariants,
	hostGuestExemption,
	visionSectionRefusal,
	visionSectionText,
	visionVerdictRefusal,
} from "./vision-review.ts";

const harness = loadHarness({ config });

const PR = "cad0p/pc-host#650";
/** The repo and head every lensBrief() fixture names (pr: PR, head: LENS_HEAD). */
const PIN = { owner: "cad0p", repo: "pc-host", head: LENS_HEAD };
/** A permalink at the brief's head. */
const BASE = "https://github.com/cad0p/pc-host/blob/" + LENS_HEAD + "/";
const CONSUMERS =
	"consumers: none — pre-launch: no tenant slices run; no compatibility window is owed";

function writeCanonical(root: string, count: number): string {
	const ids = Array.from({ length: count }, (_, i) => "V" + (i + 1));
	const doc = ["---", "title: synthetic canonical list", "---", "# Invariants", "", ...ids.map((id) => "### " + id + " - the subject of " + id), ""].join("\n");
	const path = join(root, "invariants-v" + count + ".md");
	writeFileSync(path, doc);
	return path;
}

let state: string;
let briefs: string;
let notes: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-vision-review-"));
	briefs = join(state, "briefs");
	notes = join(state, "notes");
	mkdirSync(briefs, { recursive: true });
	mkdirSync(notes, { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
	process.env.PI_H4_INVARIANTS_FILE = writeCanonical(state, 17);
	installLensStubs(state);
});

afterEach(() => {
	delete process.env.PI_H4_STATE_DIR;
	delete process.env.PI_H4_INVARIANTS_FILE;
	clearLensStubs();
	rmSync(state, { recursive: true, force: true });
});

/** A lens brief: a valid header (head + passing run) and a body. */
function lensBrief(section: string, extra = ""): string {
	return [
		"pr: " + PR,
		"round: 1",
		"kind: lens",
		CONSUMERS,
		lensHeaderLines(state).trim(),
		"",
		section,
		"",
		"# Brief",
		"",
		BLOCKING_HUNKS_ASK,
		extra,
		"",
	].join("\n");
}

/** A path in the temp root a note write can target. */
function note(name: string): string {
	return join(notes, name);
}

/** The canonical section, with one line swapped out. */
function sectionWithout(line: string): string {
	return visionSectionText(undefined, PIN)
		.split("\n")
		.filter((entry) => !entry.includes(line))
		.join("\n");
}

describe("vision-review - the brief gate", () => {
	it("blocks a lens brief with no VISION REVIEW section", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief("") },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section", reason: /no '## VISION REVIEW' section/ },
		);
	});

	it("allows a lens brief carrying the canonical section", async () => {
		await expectAllows(harness, {
			write: {
				path: join(briefs, "p1-r1-functional.md"),
				content: lensBrief(visionSectionText(undefined, PIN)),
			},
			cwd: "/tmp",
		});
	});

	it("blocks the section's wrong token: MISFIT is not a verdict", async () => {
		const section = visionSectionText(undefined, PIN).replace(
			"Verdict words: FIT | MOSTLY-FIT | UNFIT",
			"Verdict words: FIT | MOSTLY-FIT | MISFIT",
		);
		await expectBlocks(
			harness,
			{
				write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief(section) },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section", reason: /MISFIT.*third token is UNFIT/ },
		);
	});

	it("blocks a section that names no candidate invariant id", async () => {
		const section = [
			"## VISION REVIEW",
			"",
			"Answer every candidate, one line each, with its verdict and evidence.",
			"",
			"Verdict words: FIT | MOSTLY-FIT | UNFIT.",
			"",
			"Out of scope: name each id you ruled out, and why.",
			"",
			"Evidence: a file:line, a measured number, or an artifact.",
		].join("\n");
		await expectBlocks(
			harness,
			{
				write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief(section) },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section", reason: /names no candidate invariant id/ },
		);
	});

	it("blocks a section naming an invented id (V18)", async () => {
		const section = visionSectionText(undefined, PIN).replace("Candidates: ", "Candidates: V18 ");
		await expectBlocks(
			harness,
			{
				write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief(section) },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section", reason: /names V18, which is not in the canonical list/ },
		);
	});

	it("blocks a section with no out-of-scope line", async () => {
		const section = sectionWithout("Out of scope:");
		await expectBlocks(
			harness,
			{
				write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief(section) },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section", reason: /never asks which candidates are out of scope/ },
		);
	});

	it("blocks a section that does not say what evidence is needed", async () => {
		const section = [
			"## VISION REVIEW",
			"",
			"Answer every candidate: V4 FIT (<evidence>).",
			"",
			"Verdict words: FIT | MOSTLY-FIT | UNFIT.",
			"",
			"Out of scope: name each id you ruled out, and why.",
		].join("\n");
		await expectBlocks(
			harness,
			{
				write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief(section) },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section", reason: /does not state the evidence/ },
		);
	});

	it("blocks a section missing the UNFIT token", async () => {
		const section = visionSectionText(undefined, PIN)
			.split("\n")
			.map((line) =>
				line.startsWith("Verdict words:") ? "Verdict words: FIT | MOSTLY-FIT." : line,
			)
			.join("\n");
		await expectBlocks(
			harness,
			{
				write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief(section) },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section", reason: /does not carry the token set \(missing UNFIT\)/ },
		);
	});

	it("allows an impl brief without the section", async () => {
		await expectAllows(harness, {
			write: {
				path: join(briefs, "p1-r1-impl.md"),
				content: "pr: " + PR + "\nround: 1\nkind: impl\n" + CONSUMERS + "\n",
			},
			cwd: "/tmp",
		});
	});

	it("blocks the same lens brief through the edit tool", async () => {
		const path = join(briefs, "p1-r1-functional.md");
		writeFileSync(path, lensBrief(""));
		await expectBlocks(
			harness,
			{
				edit: { path, edits: [{ oldText: "# Brief", newText: "# Brief\n" }] },
				cwd: "/tmp",
			},
			{ rule: "vision-review-section-edit" },
		);
	});

	it("blocks a bash -c lens brief with no VISION REVIEW section", async () => {
		const path = join(briefs, "p1-r1-wrapper.md");
		const content = lensBrief("");
		const command = "bash -c \"cat > " + path + " <<'EOF'\n" + content + "EOF\"";
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "vision-review-section-bash", reason: /VISION REVIEW/ },
		);
	});

	
});

describe("vision-review - the brief's evidence link", () => {
	/** The canonical section with its answer-shape link rewritten. */
	function sectionLinking(base: string): string {
		return visionSectionText(undefined, PIN).split(BASE).join(base);
	}

	async function refused(section: string, reason: RegExp): Promise<void> {
		await expectBlocks(
			harness,
			{ write: { path: join(briefs, "p1-r1-functional.md"), content: lensBrief(section) }, cwd: "/tmp" },
			{ rule: "vision-review-section", reason },
		);
	}

	it("refuses the old 'a file:line' wording", async () => {
		const old = [
			"## VISION REVIEW",
			"",
			"Candidates: V4 V6. Answer every candidate, one line each: V4 FIT (<evidence: a file:line, a measured number, or an artifact>).",
			"",
			"Verdict words: FIT | MOSTLY-FIT | UNFIT (the third is UNFIT).",
			"",
			"Out of scope: name each candidate id you ruled out, and why.",
		].join("\n");
		await refused(old, /does not state the evidence.*pinned to this brief's repo and head/);
	});

	it("refuses a link left with the placeholder repo and head", async () => {
		await refused(
			sectionLinking("https://github.com/<owner>/<repo>/blob/<head>/"),
			/does not state the evidence/,
		);
	});

	it("refuses a link pinned to another head", async () => {
		await refused(
			sectionLinking("https://github.com/cad0p/pc-host/blob/" + "2".repeat(40) + "/"),
			/does not state the evidence/,
		);
	});

	it("refuses a link to another repo", async () => {
		await refused(
			sectionLinking("https://github.com/cad0p/pc-tenant/blob/" + LENS_HEAD + "/"),
			/does not state the evidence/,
		);
	});

	it("refuses a link pinned to a branch", async () => {
		await refused(
			sectionLinking("https://github.com/cad0p/pc-host/blob/main/"),
			/does not state the evidence/,
		);
	});

	it("accepts a real path and line in the link", async () => {
		await expectAllows(harness, {
			write: {
				path: join(briefs, "p1-r1-functional.md"),
				content: lensBrief(
					visionSectionText(undefined, PIN).replace("<path>#L<line>", "docs/host-incus.md#L41"),
				),
			},
			cwd: "/tmp",
		});
	});
});

describe("vision-review - the verdict gate", () => {
	/** The gh pr comment command a lens posts its verdict with. */
	function comment(body: string): string {
		return 'gh pr comment 650 --body "' + body + '"';
	}

	it("blocks a bare 'Vision: FIT'", async () => {
		await expectBlocks(
			harness,
			{
				command: comment(
					"Lens: functional: CLEAN @ " + "a".repeat(40) + "\nVision: FIT",
				),
				cwd: "/tmp",
			},
			{ rule: "vision-verdict-shape", reason: /names no invariant id/ },
		);
	});

	it("blocks 'Vision: FIT - reviewed'", async () => {
		await expectBlocks(
			harness,
			{ command: comment("Vision: FIT - reviewed"), cwd: "/tmp" },
			{ rule: "vision-verdict-shape", reason: /names no invariant id/ },
		);
	});

	it("blocks 'Vision: MISFIT' and names UNFIT", async () => {
		await expectBlocks(
			harness,
			{
				command: comment("Vision: MISFIT - V4: the host starts nothing in the slice"),
				cwd: "/tmp",
			},
			{ rule: "vision-verdict-shape", reason: /MISFIT.*the third is UNFIT/ },
		);
	});

	it("blocks an invented id (V18)", async () => {
		await expectBlocks(
			harness,
			{
				command: comment(
					"Vision: V18 FIT (docs/host-incus.md:41: nothing starts in the slice)",
				),
				cwd: "/tmp",
			},
			{ rule: "vision-verdict-shape", reason: /names V18, which is not in the canonical list/ },
		);
	});

	it("blocks a canonical id with no reason", async () => {
		await expectBlocks(
			harness,
			{ command: comment("Vision: V4 FIT - reviewed"), cwd: "/tmp" },
			{ rule: "vision-verdict-shape", reason: /but no reason/ },
		);
	});

	it("allows a verdict naming the invariant and the evidence", async () => {
		// A real verdict body opens with its head (Lens: <lens> @ <40-hex>),
		// which is what lets no-bare-citation accept the file:line evidence.
		await expectAllows(harness, {
			command: comment(
				"Lens: functional @ " + "a".repeat(40) + "\n\n" +
					"Vision: V4 FIT (docs/host-incus.md:41: no host-started action runs in the guest); V6 N/A(no CC work)",
			),
			cwd: "/tmp",
		});
	});

	it("allows a verdict whose id links to a permalink at its head", async () => {
		await expectAllows(harness, {
			command: comment(
				"Lens: functional @ " + LENS_HEAD + "\n\n" +
					"Vision: [V4](" + BASE + "docs/host-incus.md#L41) FIT (no host-started action runs in the guest)",
			),
			cwd: "/tmp",
		});
	});

	it("refuses a linked id with no reason: the URL is not a reason", async () => {
		await expectBlocks(
			harness,
			{
				command: comment(
					"Lens: functional @ " + LENS_HEAD + "\n\n" +
						"Vision: [V4](" + BASE + "docs/host-incus.md#L41) FIT",
				),
				cwd: "/tmp",
			},
			{ rule: "vision-verdict-shape", reason: /no reason/ },
		);
	});

	it("refuses an evidence link pinned to a branch", async () => {
		await expectBlocks(
			harness,
			{
				command: comment(
					"Lens: functional @ " + LENS_HEAD + "\n\n" +
						"Vision: [V4](https://github.com/cad0p/pc-host/blob/main/docs/host-incus.md#L41) FIT (no host-started action runs in the guest)",
				),
				cwd: "/tmp",
			},
			{ rule: "vision-verdict-shape", reason: /'main', which is not a commit/ },
		);
	});

	it("refuses an evidence link pinned to another commit than the verdict's head", async () => {
		const other = "2".repeat(40);
		await expectBlocks(
			harness,
			{
				command: comment(
					"Lens: functional @ " + LENS_HEAD + "\n\n" +
						"Vision: [V4](https://github.com/cad0p/pc-host/blob/" + other + "/docs/host-incus.md#L41) FIT (no host-started action runs in the guest)",
				),
				cwd: "/tmp",
			},
			{ rule: "vision-verdict-shape", reason: new RegExp("links evidence at " + other + ", but this verdict is for " + LENS_HEAD) },
		);
	});

	it("allows a comment with no Vision line at all", async () => {
		await expectAllows(harness, {
			command: comment("Progress: the gate is green, reading round 2"),
			cwd: "/tmp",
		});
	});

	it("ignores a Vision line inside a code fence (a quoted template)", async () => {
		const fence = String.fromCharCode(96).repeat(3);
		const body = "The brief's template was:\n\n" + fence + "\nVision: FIT\n" + fence;
		await expectAllows(harness, { command: comment(body), cwd: "/tmp" });
	});

	it("reads a --body-file verdict", async () => {
		const file = join(notes, "verdict.md");
		writeFileSync(
			file,
			"Lens: functional: CLEAN @ " + "a".repeat(40) + "\nVision: FIT\n",
		);
		await expectBlocks(
			harness,
			{ command: "gh pr comment 650 --body-file " + file, cwd: "/tmp" },
			{ rule: "vision-verdict-shape", reason: /names no invariant id/ },
		);
	});

	
});

describe("vision-review - the drift class", () => {
	it("allows the docs' statement of fact", async () => {
		await expectAllows(harness, {
			write: {
				path: note("host-teleport-recovery.md"),
				content:
					"From the host, incus exec does not work: the guest is not reachable that way.\n",
			},
			cwd: "/tmp",
		});
	});

	it("allows 'there is no host-to-guest execution path'", async () => {
		await expectAllows(harness, {
			write: {
				path: note("host-watchdogs.md"),
				content:
					"There is no host-to-guest execution path, by design (V4: the tenant administers the slice).\n",
			},
			cwd: "/tmp",
		});
	});

	it("allows a question about the path", async () => {
		await expectAllows(harness, {
			write: {
				path: note("red-team-questions.md"),
				content: "Can the host incus exec into the guest?\n",
			},
			cwd: "/tmp",
		});
	});

	it("blocks 'make incus exec work' and names V4", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: note("design.md"),
					content:
						"Make incus exec work from the host so the operator can seed the guest.\n",
				},
				cwd: "/tmp",
			},
			{ rule: "vision-drift-invariant", reason: /invariant V4/ },
		);
	});

	it("blocks 'add a guest agent'", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: note("design.md"),
					content: "Add a guest agent inside the slice so the platform can drive it.\n",
				},
				cwd: "/tmp",
			},
			{ rule: "vision-drift-invariant", reason: /a guest agent/ },
		);
	});

	it("blocks the assertion 'the host can run commands in the guest'", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: note("design.md"),
					content:
						"The host can run commands in the guest, so the operator seeds it.\n",
				},
				cwd: "/tmp",
			},
			{ rule: "vision-drift-invariant", reason: /the host can run commands in the guest/ },
		);
	});

	it("blocks the incident's shape: a denied fact framed as a defect", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: note("design.md"),
					content:
						"The host cannot incus exec into the guest, a gap we must fix.\n",
				},
				cwd: "/tmp",
			},
			{ rule: "vision-drift-invariant", reason: /gap we must fix/ },
		);
	});

	it("allows a proposal that cites V4 and how the design satisfies it", async () => {
		await expectAllows(harness, {
			write: {
				path: note("design.md"),
				content:
					"Add a guest agent inside the slice: V4: started by the slice's own systemd, no host-started action enters the guest.\n",
			},
			cwd: "/tmp",
		});
	});

	it("blocks a gh pr comment that proposes the path", async () => {
		await expectBlocks(
			harness,
			{
				command: 'gh pr comment 650 --body "Make incus exec work from the host."',
				cwd: "/tmp",
			},
			{ rule: "vision-drift-invariant-gh", reason: /invariant V4/ },
		);
	});

	it("blocks an edit that adds the proposal to a note", async () => {
		const path = note("design.md");
		writeFileSync(path, "# Design\n\nNothing to see.\n");
		await expectBlocks(
			harness,
			{
				edit: {
					path,
					edits: [
						{
							oldText: "Nothing to see.",
							newText:
								"Add a guest agent inside the slice so the platform can drive it.",
						},
					],
				},
				cwd: "/tmp",
			},
			{ rule: "vision-drift-invariant-edit" },
		);
	});
});

describe("vision-review - pure checks", () => {
	

	it("tells a fact from a proposal in the same shape", () => {
		assert.equal(driftProposal("incus exec does not work from the host."), null);
		assert.equal(driftProposal("incus exec does not work yet from the host.")?.line, 1);
		assert.equal(driftProposal("we should add a guest agent")?.phrase, "a guest agent");
		assert.equal(driftProposal("no guest agent runs inside the slice"), null);
	});

	it("refuses a verdict with no id and allows one with an id and evidence", () => {
		const set = loadInvariants();
		assert.match(String(visionVerdictRefusal("FIT", set)), /no invariant id/);
		assert.equal(
			visionVerdictRefusal(
				"V4 FIT (docs/host-incus.md:41: no host-started action runs in the guest)",
				set,
			),
			null,
		);
	});

	it("names the section's contract in the refusal", () => {
		const reason = String(
			visionSectionRefusal("# Brief\n", loadInvariants(), "b.md"),
		);
		assert.match(reason, /VISION REVIEW/);
		assert.match(reason, new RegExp("\\[" + ADVERSARY_INVARIANT + "\\]\\(https://github\\.com/<owner>/<repo>/blob/<head>/<path>#L<line>\\) FIT"));
	});

	it("pins the known gaps: a bare gh pr comment and a top-level cat redirect", async () => {
		// No --body / --body-file: the body comes from stdin or an editor, so
		// the gate cannot see it (documented in vision-review.ts).
		await expectAllows(harness, { command: "gh pr comment 650", cwd: "/tmp" });
		// A top-level redirect is invisible to pi-steering bash rules (the
		// same gap brief-gates.ts documents): write notes with the write tool.
		await expectAllows(harness, { command: "cat > " + note("design.md"), cwd: "/tmp" });
	});
});

describe("vision-review - the canonical list is loaded, not copied", () => {
	function grownSection(ids: string): string {
		return [
			"## VISION REVIEW",
			"",
			"Candidates: " + ids,
			"",
			"[V18](" + BASE + "<path>#L<line>) FIT (<what you checked>)",
			"",
			"Verdict words: FIT | MOSTLY-FIT | UNFIT.",
			"",
			"Out of scope: name each id you ruled out, and why.",
			"",
			"Evidence: the id's permalink, a measured number, or an artifact.",
		].join("\n");
	}

	it("picks up V18 and V19 with no code change and still refuses V20", async () => {
		process.env.PI_H4_INVARIANTS_FILE = writeCanonical(state, 19);
		assert.deepEqual(loadInvariants().ids.slice(-2), ["V18", "V19"]);
		await expectAllows(harness, {
			write: { path: join(briefs, "p1-r1-grown.md"), content: lensBrief(grownSection("V18 V19")) },
			cwd: "/tmp",
		});
		await expectBlocks(
			harness,
			{ write: { path: join(briefs, "p1-r1-grown2.md"), content: lensBrief(grownSection("V20")) }, cwd: "/tmp" },
			{ rule: "vision-review-section", reason: /names V20, which is not in the canonical list/ },
		);
	});

	it("refuses with the path when the canonical file cannot be read", async () => {
		const good = visionSectionText(loadInvariants(), PIN);
		process.env.PI_H4_INVARIANTS_FILE = join(state, "no-such-invariants.md");
		await expectBlocks(
			harness,
			{ write: { path: join(briefs, "p1-r1-nolist.md"), content: lensBrief(good) }, cwd: "/tmp" },
			{ rule: "vision-review-section", reason: /cannot read the canonical invariants list at .*no-such-invariants/ },
		);
	});
});

describe("vision-review - the explicit host-guest-proposal exemption", () => {
	const meta =
		"---" + "\n" + "host-guest-proposal: none - the investigation note that quotes the shape" + "\n" + "---" + "\n\n" +
		"The failure being prevented: make incus exec work, which V4 forbids." + "\n";

	it("refuses the same text without the exemption line", async () => {
		await expectBlocks(
			harness,
			{ write: { path: note("meta.md"), content: meta.split("---")[2] ?? "" }, cwd: "/tmp" },
			{ rule: "vision-drift-invariant", reason: /invariant V4/ },
		);
	});

	it("accepts the meta-discussion that declares it", async () => {
		await expectAllows(harness, { write: { path: note("meta.md"), content: meta }, cwd: "/tmp" });
	});

	it("refuses a bare none with no reason, with or without a proposal", async () => {
		const bare = "---" + "\n" + "host-guest-proposal: none" + "\n" + "---" + "\n\n" +
			"Make incus exec work from the host." + "\n";
		await expectBlocks(
			harness,
			{ write: { path: note("bare.md"), content: bare }, cwd: "/tmp" },
			{ rule: "vision-drift-invariant", reason: /bare .host-guest-proposal:. line/ },
		);
		const metaBare = bare.split("Make")[0] + "The failure being prevented: make incus exec work, which V4 forbids." + "\n";
		await expectBlocks(
			harness,
			{ write: { path: note("bare2.md"), content: metaBare }, cwd: "/tmp" },
			{ rule: "vision-drift-invariant", reason: /bare .host-guest-proposal:. line/ },
		);
	});

	it("reads the exemption helper directly", () => {
		assert.equal(hostGuestExemption("host-guest-proposal: none - a note about the drift"), "ok");
		assert.equal(hostGuestExemption("host-guest-proposal: none"), "bare");
		assert.equal(hostGuestExemption("plain note"), "absent");
	});
});
