// SPDX-License-Identifier: MIT
// Global pi-steering config — pre-launch compatibility gate tests.
//
// Owner rule (Goldmine reflections/2026-11-03-pre-launch-no-compat-
// windows-for-things-nothing-runs.md, addendum 2026-11-09): every brief
// write carries a `consumers:` header — either the pre-launch default
// ("none — pre-launch: no tenant slices run; no compatibility window is
// owed") or a concrete RUNNING consumer plus `evidence: <path:line or
// URL>`. With the default, a brief whose body demands compatibility
// work (backwards compatibility, already-signed releases that must stay
// verifiable, dual readers, compatibility/migration/deprecation
// windows, keeping the old producer working) is refused; a line that
// disclaims the obligation is allowed. Design-check rationales get the
// same scan.
//
// The two incidents this pins: #148 item D (a dual-accept window for
// pc-unlock/1 producers nothing ran) and pc-tenant #228 (a design brief
// that demanded already-signed releases stay verifiable, so the design
// agent ruled B).
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
import {
	COMPAT_DISCLAIMER,
	COMPAT_NOTE,
	compatDemand,
	evidenceValid,
	isPrelaunchDefault,
	PRELAUNCH_DEFAULT,
	prelaunchCompatRules,
} from "./prelaunch-compat-guard.ts";
import { parseBriefHeader } from "./brief-gates.ts";

const harness = loadHarness({ config });

let state: string;
let briefs: string;
let checks: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-prelaunch-"));
	briefs = join(state, "briefs");
	checks = join(state, "design-checks");
	mkdirSync(briefs, { recursive: true });
	mkdirSync(checks, { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
});

afterEach(() => {
	delete process.env.PI_H4_STATE_DIR;
	rmSync(state, { recursive: true, force: true });
});

const PR = "cad0p/pc-host#650";

const MISSING_HEADER = /briefs need a 'consumers:' line in the header/;
const DEMAND = /demands compatibility work/;
const NO_EVIDENCE = /names a running consumer .* but no usable 'evidence:' line/;
const CHECK_DEMAND = /assumes a compatibility obligation nobody has/;

/** A brief path in the temp briefs dir. */
function briefPath(name: string): string {
	return join(briefs, name);
}

interface BriefOptions {
	/** Omit the line with `null`; otherwise the value (default: the default). */
	consumers?: string | null;
	/** Omit the line when undefined. */
	evidence?: string;
	/** Body after the header block. */
	body?: string;
	kind?: string;
	round?: number;
}

/** A brief with a complete header; `consumers:` unless opts.consumers is null. */
function brief(opts: BriefOptions = {}): string {
	const lines = [
		`pr: ${PR}`,
		`round: ${opts.round ?? 1}`,
		`kind: ${opts.kind ?? "impl"}`,
	];
	if (opts.consumers !== null) {
		lines.push(`consumers: ${opts.consumers ?? PRELAUNCH_DEFAULT}`);
	}
	if (opts.evidence !== undefined) lines.push(`evidence: ${opts.evidence}`);
	lines.push("", opts.body ?? "# Brief\n\nDo the thing.\n");
	return lines.join("\n");
}

/** Write a design-check file and return its path. */
function designCheck(name: string, body: string): string {
	const path = join(checks, name);
	writeFileSync(path, body);
	return path;
}

describe("prelaunch-compat — the consumers header", () => {
	it("blocks a brief with no consumers line", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("no-consumers.md"), content: brief({ consumers: null }) },
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: MISSING_HEADER },
		);
	});

	it("blocks a brief whose consumers line is empty", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("empty-consumers.md"), content: brief({ consumers: "" }) },
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: MISSING_HEADER },
		);
	});

	it("blocks a consumers line in the body (the header block is the contract)", async () => {
		const content = `pr: ${PR}\nround: 1\nkind: impl\n\n# Brief\n\nconsumers: ${PRELAUNCH_DEFAULT}\n`;
		await expectBlocks(
			harness,
			{ write: { path: briefPath("body-consumers.md"), content }, cwd: "/tmp" },
			{ rule: "prelaunch-compat-gate", reason: MISSING_HEADER },
		);
	});

	it("blocks a bare 'consumers: none' (not the default, and no evidence)", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("bare-none.md"), content: brief({ consumers: "none" }) },
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: NO_EVIDENCE },
		);
	});

	it("blocks a named consumer with no evidence line", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("consumer-no-evidence.md"),
					content: brief({ consumers: "the pc-host-01 slice installer" }),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: NO_EVIDENCE },
		);
	});

	it("blocks a named consumer whose evidence is a bare path", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("consumer-bare-path.md"),
					content: brief({
						consumers: "the pc-host-01 slice installer",
						evidence: "pc-host/tools/install.sh",
					}),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: NO_EVIDENCE },
		);
	});

	it("allows a named consumer with a path:line evidence", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("consumer-evidence.md"),
				content: brief({
					consumers: "the pc-host-01 slice installer",
					evidence: "pc-host/tools/install.sh:42",
					body: "Keep the old client working until the installer is re-released.\n",
				}),
			},
			cwd: "/tmp",
		});
	});

	it("allows a named consumer with a URL evidence", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("consumer-url.md"),
				content: brief({
					consumers: "the aqta.ai seal tenant",
					evidence: "https://github.com/cad0p/pc-host/issues/12#issuecomment-1",
				}),
			},
			cwd: "/tmp",
		});
	});

	it("allows the pre-launch default with no compatibility language", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("default-clean.md"),
				content: brief({ body: "# Brief\n\nAdd the manifest key; no other repo reads it.\n" }),
			},
			cwd: "/tmp",
		});
	});

	it("allows the hyphen spelling of the default", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("default-hyphen.md"),
				content: brief({
					consumers:
						"none - pre-launch: no tenant slices run; no compatibility window is owed",
				}),
			},
			cwd: "/tmp",
		});
	});

	it("leaves a headerless brief to design-check-gate", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("headerless.md"), content: "# Just a title\n" },
				cwd: "/tmp",
			},
			{ rule: "design-check-gate", reason: /briefs need a header/ },
		);
	});
});

describe("prelaunch-compat — a demand under the pre-launch default", () => {
	it("blocks the pc-tenant #228 design brief (already-signed releases)", async () => {
		// The orchestrator's brief, verbatim header + the two lines that
		// bent the design. It carries no consumers line, and the demand is
		// read first: the substantive refusal, with the owner's words.
		const content = [
			"pr: cad0p/pc-tenant#228",
			"round: 1",
			"kind: design-ruling",
			"Threat model: a slice image bakes the wrong platform CA bundle or platform/unlock origins (from an untracked operator-local input), so the slice trusts an attacker-chosen control plane or unlock origin; the release must make the baked anchor provable from tracked inputs, without breaking verification of already-signed releases (0.3.0-0.3.5) on pc-host-01 or the slice installer.",
			"",
			"# pc-tenant #228 — design ruling: where the platform-trust anchor is recorded",
			"",
			"Decide with the H4 constraints: H4 is on a critical path; cross-repo schema changes cost a coordinated pc-host window; already-signed releases must stay verifiable.",
			"",
		].join("\n");
		const result = await expectBlocks(
			harness,
			{ write: { path: briefPath("228-design-ruling.md"), content }, cwd: "/tmp" },
			{ rule: "prelaunch-compat-gate", reason: DEMAND },
		);
		const reason = String((result as { reason?: unknown }).reason ?? "");
		assert.match(reason, /line 4 demands compatibility work \(an already-signed release/);
		assert.match(reason, /no enrolled slice is running it come on/);
		assert.match(reason, /there's no need to support any already signed release/);
		assert.match(reason, /no customers asking us for perfect uptime/);
		assert.ok(reason.includes(COMPAT_NOTE), "names the reflection note");
		assert.match(reason, /compatibility work starts when the first tenant does/);
		assert.match(reason, /consumers: <it>' and 'evidence: <path:line or URL>/);
	});

	it("blocks a dual-accept window (#148 item D)", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("dual-accept.md"),
					content: brief({
						body: "Q1 = option A': keep a bounded dual-accept of /1 until the fleet is above the floor.\n",
					}),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: /a dual reader or dual-accept window/ },
		);
	});

	it("blocks a dual reader for staged releases", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("dual-reader.md"),
					content: brief({ body: "Add a dual reader for staged releases.\n" }),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: /a dual reader or dual-accept window/ },
		);
	});

	it("blocks backwards compatibility", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("backwards.md"),
					content: brief({ body: "Keep backwards-compatibility with the /1 payload.\n" }),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: /backwards compatibility/ },
		);
	});

	it("blocks an existing release that must stay verifiable", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("existing-release.md"),
					content: brief({
						body: "The existing releases must remain verifiable after the key change.\n",
					}),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: /an existing release that must stay verifiable/ },
		);
	});

	it("blocks a compatibility window", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("compat-window.md"),
					content: brief({ body: "Run a compatibility window for the old manifest.\n" }),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: /a compatibility window/ },
		);
	});

	it("blocks a migration window for the old manifest format", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("migration-window.md"),
					content: brief({
						body: "Open a migration window for the old manifest format.\n",
					}),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: /a migration or deprecation window/ },
		);
	});

	it("blocks keeping the old producer working", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("keep-old.md"),
					content: brief({ body: "Keep the old producer working until the fleet moves.\n" }),
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: /keeping the old shape working/ },
		);
	});

	it("allows a demand line that disclaims the obligation", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("disclaimed.md"),
				content: brief({
					body: "No compatibility window is owed for the /1 producer: nothing runs it.\n",
				}),
			},
			cwd: "/tmp",
		});
	});

	it("allows a brief that states the pre-launch rule", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("states-rule.md"),
				content: brief({
					body: "Pre-launch: no tenant slices run; no compatibility window is owed, so change the contract in one step.\n",
				}),
			},
			cwd: "/tmp",
		});
	});

	it("allows 'residual accepted' (the unanchored-dual false positive)", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("residual-accepted.md"),
				content: brief({
					body: "Q2 #430 residual accepted under local-only gating, option (b).\n",
				}),
			},
			cwd: "/tmp",
		});
	});

	it("allows a host migration window that names no compatibility noun", async () => {
		// The Debian plan's red-team briefs: "what does the migration
		// window open up (DR path, unlock chain, egress allowlists ...)".
		await expectAllows(harness, {
			write: {
				path: briefPath("debplan-red-team.md"),
				content: brief({
					body: "- red-team: what does the migration window open up (DR path, unlock chain, egress allowlists to Debian mirrors on Fastly, unsigned/unchecked repos, a guest left half-migrated, the interim mitigation's blast radius)?\n",
				}),
			},
			cwd: "/tmp",
		});
	});

	it("blocks an edit that adds a demand to a default brief", async () => {
		const path = briefPath("edit-demand.md");
		writeFileSync(path, brief());
		await expectBlocks(
			harness,
			{
				edit: {
					path,
					edits: [
						{
							oldText: "Do the thing.",
							newText: "Do the thing. Already-signed releases must stay verifiable.",
						},
					],
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate-edit", reason: DEMAND },
		);
	});

	it("blocks a bash -c heredoc redirect that demands compatibility", async () => {
		const path = briefPath("wrapper-demand.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${brief({ body: "Keep a dual reader for staged releases.\n" })}EOF"`;
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "prelaunch-compat-gate-bash", reason: DEMAND },
		);
	});

	it("allows a bash -c heredoc redirect under the default", async () => {
		const path = briefPath("wrapper-clean.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${brief()}EOF"`;
		await expectAllows(harness, { command, cwd: "/tmp" });
	});
});

describe("prelaunch-compat — design checks", () => {
	it("blocks a design check whose rationale assumes the obligation", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: join(checks, "cad0p--pc-tenant-228-r1.md"),
					content:
						"verdict: B\nruling: keep schema v1 so already-signed releases must stay verifiable.\n",
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: CHECK_DEMAND },
		);
	});

	it("allows a design check that states the disclaimer", async () => {
		await expectAllows(harness, {
			write: {
				path: join(checks, "cad0p--pc-tenant-228-r1.md"),
				content:
					"verdict: A\nruling: add the manifest key in one step; pre-launch, no compatibility window is owed.\n",
			},
			cwd: "/tmp",
		});
	});

	it("allows a write outside the briefs and design-checks dirs", async () => {
		await expectAllows(harness, {
			write: {
				path: join(state, "notes", "x.md"),
				content: "already-signed releases must stay verifiable\n",
			},
			cwd: "/tmp",
		});
	});
});

describe("prelaunch-compat — known gaps (pinned)", () => {
	it("known gap: a top-level cat > brief.md redirect is invisible to bash rules", async () => {
		// pi-steering evaluates one extracted ref at a time: `cat` carries
		// no redirect target. The `bash -c` wrapper form IS gated.
		const path = briefPath("top-level-gap.md");
		const command = `cat > ${path} <<'EOF'\n${brief({ consumers: null })}\nKeep a dual reader.\nEOF`;
		await expectAllows(harness, { command, cwd: "/tmp" });
	});

	it("known gap: tee -a hides the appended demand (the gate reads the file)", async () => {
		const path = briefPath("tee-gap.md");
		writeFileSync(path, brief());
		await expectAllows(harness, { command: `tee -a ${path}`, cwd: "/tmp" });
	});

	it("known gap: a design check for a REAL consumer cannot state the obligation", async () => {
		// A design check has no consumers header to carry the evidence, so
		// the only escape is the line-level disclaimer. Pinned as a gap.
		await expectBlocks(
			harness,
			{
				write: {
					path: join(checks, "cad0p--pc-host-700-r1.md"),
					content: "verdict: continue\nruling: the running tenant needs a dual reader.\n",
				},
				cwd: "/tmp",
			},
			{ rule: "prelaunch-compat-gate", reason: CHECK_DEMAND },
		);
	});
});

describe("prelaunch-compat — the pure helpers", () => {
	it("accepts the default with an em dash, an en dash or a hyphen", () => {
		assert.equal(isPrelaunchDefault(PRELAUNCH_DEFAULT), true);
		assert.equal(
			isPrelaunchDefault(
				"none – pre-launch: no tenant slices run; no compatibility window is owed",
			),
			true,
		);
		assert.equal(
			isPrelaunchDefault(
				"  none - pre-launch:   no tenant slices run; no compatibility window is owed  ",
			),
			true,
		);
		assert.equal(isPrelaunchDefault("none"), false);
		assert.equal(isPrelaunchDefault("the pc-host-01 slice installer"), false);
	});

	it("requires a path:line or a URL as evidence", () => {
		assert.equal(evidenceValid("pc-host/tools/install.sh:42"), true);
		assert.equal(evidenceValid("/home/pier/x.sh:42-50"), true);
		assert.equal(evidenceValid("https://example.test/run/1"), true);
		assert.equal(evidenceValid("pc-host/tools/install.sh"), false);
		assert.equal(evidenceValid("cad0p/pc-host#12"), false);
		assert.equal(evidenceValid("see the notes"), false);
		assert.equal(evidenceValid(null), false);
	});

	it("scans line by line and lets a disclaimer on the line win", () => {
		assert.equal(compatDemand("no compatibility window is owed"), null);
		assert.equal(
			compatDemand("keep a dual reader")?.phrase,
			"a dual reader or dual-accept window",
		);
		// The disclaimer is line-scoped: it does not cover the next line.
		assert.notEqual(
			compatDemand("pre-launch: nothing runs\nkeep a dual reader"),
			null,
		);
	});

	it("pins the disclaimer vocabulary", () => {
		for (const phrase of ["no compatibility", "not owed", "nothing runs", "pre-launch"]) {
			assert.equal(COMPAT_DISCLAIMER.test(phrase), true, phrase);
		}
	});

	it("parses consumers and evidence out of the header", () => {
		const header = parseBriefHeader(
			brief({ consumers: "the installer", evidence: "x.sh:1" }),
		);
		assert.equal(header.consumers, "the installer");
		assert.equal(header.evidence, "x.sh:1");
		assert.equal(header.complete, true);
		const missing = parseBriefHeader(brief({ consumers: null }));
		assert.equal(missing.consumers, null);
		assert.equal(missing.evidence, null);
	});

	it("registers one rule per surface", () => {
		assert.deepEqual(
			prelaunchCompatRules.map((rule) => rule.name),
			[
				"prelaunch-compat-gate",
				"prelaunch-compat-gate-edit",
				"prelaunch-compat-gate-bash",
			],
		);
	});
});
