// SPDX-License-Identifier: MIT
// Global pi-steering config — E5 threat-model-required tests.
//
// (a) Brief side: a `kind: lens` brief with `lens: red-team` or
// `lens: trust-model` must carry a `Threat model:` line naming the
// model section. (b) Body side: `gh issue|pr create|edit` with the
// pinned vault `--body-file` substitution additionally requires the
// vault note's frontmatter to carry a `threat-model:` key (a section
// name, or `n/a: <reason>` for copy/docs-only notes).
//
// PI_H4_STATE_DIR points the brief side at a fresh temp state root; the
// body side builds a throwaway napkin vault + repo cwd per case.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BODY_STRIP } from "@cad0p/pi-steering-github";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import {
	clearLensStubs,
	installLensStubs,
	lensHeaderLines,
} from "./lens-test-stubs.ts";

const harness = loadHarness({ config });
const REPO = "pc-host";
const PR = "cad0p/pc-host#650";

let state: string;
let briefs: string;
let vault: string;
let cwd: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-threat-model-"));
	briefs = join(state, "briefs");
	mkdirSync(briefs, { recursive: true });
	vault = join(state, "vault");
	mkdirSync(join(vault, ".napkin"), { recursive: true });
	cwd = join(state, REPO);
	mkdirSync(cwd, { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
	installLensStubs(state);
});

afterEach(() => {
	delete process.env.PI_H4_STATE_DIR;
	clearLensStubs();
	rmSync(state, { recursive: true, force: true });
});

function header(extra: string): string {
	return `pr: ${PR}\nround: 1\nkind: lens\nlens: red-team\n${lensHeaderLines(state)}${extra}`;
}

function briefPath(name: string): string {
	return join(briefs, name);
}

/** A vault note under <vault>/open-source/github/<repo>/<section>/. */
function vaultNote(section: "issues" | "prs", name: string, content: string): string {
	const dir = join(vault, "open-source", "github", REPO, section);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function stripSubstitution(file: string): string {
	return `<(perl -0777 -pe '${BODY_STRIP}' "${file}")`;
}

function note(frontmatter: string, body = "# Title\n\nBody.\n"): string {
	return `---\ntags: [test]\n${frontmatter}---\n${body}`;
}

describe("threat-model-required — brief side", () => {
	it("blocks a red-team lens brief with no Threat model line", async () => {
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("r1-red.md"), content: header("") },
				cwd: "/tmp",
			},
			{ rule: "threat-model-required", reason: /Threat model:/ },
		);
	});

	it("allows a red-team lens brief that names the model section", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("r1-red-ok.md"),
				content: header("Threat model: verification-base §Threat models / CI gate\n"),
			},
			cwd: "/tmp",
		});
	});

	it("blocks a trust-model lens brief with no Threat model line", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("r1-trust.md"),
					content: `pr: ${PR}\nround: 1\nkind: lens\nlens: trust-model\n${lensHeaderLines(state)}`,
				},
				cwd: "/tmp",
			},
			{ rule: "threat-model-required" },
		);
	});

	it("allows a functional lens brief without a Threat model line", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("r1-functional.md"),
				content: `pr: ${PR}\nround: 1\nkind: lens\nlens: functional\n${lensHeaderLines(state)}`,
			},
			cwd: "/tmp",
		});
	});

	it("allows a fold brief without a Threat model line", async () => {
		await expectAllows(harness, {
			write: {
				path: briefPath("r1-fold.md"),
				content: `pr: ${PR}\nround: 1\nkind: fold\n`,
			},
			cwd: "/tmp",
		});
	});

	it("blocks a red-team brief whose Threat model line is empty", async () => {
		await expectBlocks(
			harness,
			{
				write: {
					path: briefPath("r1-empty.md"),
					content: header("Threat model:\n"),
				},
				cwd: "/tmp",
			},
			{ rule: "threat-model-required" },
		);
	});

	it("blocks a bash -c red-team brief with no Threat model line", async () => {
		const path = briefPath("r1-wrapper.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${header("")}EOF"`;
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "threat-model-required-bash" },
		);
	});
});

describe("threat-model-required — body side", () => {
	it("allows gh issue create when the note names a threat model", async () => {
		const file = vaultNote(
			"issues",
			"2026-11-07-issue1-x.md",
			note("threat-model: verification-base §Threat models / CI gate\n"),
		);
		await expectAllows(harness, {
			command: `gh issue create --title "tracking" --body-file ${stripSubstitution(file)}`,
			cwd,
		});
	});

	it("blocks gh issue create when the note has no threat-model key", async () => {
		const file = vaultNote(
			"issues",
			"2026-11-07-issue1-x.md",
			note(""),
		);
		await expectBlocks(
			harness,
			{
				command: `gh issue create --title "tracking" --body-file ${stripSubstitution(file)}`,
				cwd,
			},
			{ rule: "threat-model-required-body", reason: /threat-model:/ },
		);
	});

	it("allows an n/a: threat model (copy/docs-only note)", async () => {
		const file = vaultNote(
			"issues",
			"2026-11-07-issue2-x.md",
			note("threat-model: n/a: copy-only note\n"),
		);
		await expectAllows(harness, {
			command: `gh issue create --title "tracking" --body-file ${stripSubstitution(file)}`,
			cwd,
		});
	});

	it("blocks an empty threat-model value", async () => {
		const file = vaultNote(
			"issues",
			"2026-11-07-issue3-x.md",
			note("threat-model:\n"),
		);
		await expectBlocks(
			harness,
			{
				command: `gh issue create --title "tracking" --body-file ${stripSubstitution(file)}`,
				cwd,
			},
			{ rule: "threat-model-required-body" },
		);
	});

	it("blocks a note with no frontmatter at all", async () => {
		const file = vaultNote(
			"issues",
			"2026-11-07-issue4-x.md",
			"# Title\n\nNo frontmatter.\n",
		);
		await expectBlocks(
			harness,
			{
				command: `gh issue create --title "tracking" --body-file ${stripSubstitution(file)}`,
				cwd,
			},
			{ rule: "threat-model-required-body" },
		);
	});

	it("blocks gh issue edit when the note has no threat-model key", async () => {
		const file = vaultNote(
			"issues",
			"2026-11-07-issue5-x.md",
			note(""),
		);
		await expectBlocks(
			harness,
			{
				command: `gh issue edit 29 --body-file ${stripSubstitution(file)}`,
				cwd,
			},
			{ rule: "threat-model-required-body" },
		);
	});

	it("allows gh pr edit when the PR note names a threat model", async () => {
		const file = vaultNote(
			"prs",
			"2026-11-07-pr1-x.md",
			note("threat-model: verification-base §Threat models / merge tooling\n"),
		);
		await expectAllows(harness, {
			command: `gh pr edit 46 --body-file ${stripSubstitution(file)}`,
			cwd,
		});
	});

	it("blocks gh pr edit when the PR note has no threat-model key", async () => {
		const file = vaultNote(
			"prs",
			"2026-11-07-pr2-x.md",
			note(""),
		);
		await expectBlocks(
			harness,
			{
				command: `gh pr edit 46 --body-file ${stripSubstitution(file)}`,
				cwd,
			},
			{ rule: "threat-model-required-body" },
		);
	});

	it("allows gh pr edit with no body-affecting flag", async () => {
		await expectAllows(harness, {
			command: 'gh pr edit 46 --title "chore: retitle"',
			cwd,
		});
	});

	it("leaves a DIRECT body-file path to the shipped body-file rule", async () => {
		const file = vaultNote(
			"issues",
			"2026-11-07-issue6-x.md",
			note(""),
		);
		await expectBlocks(
			harness,
			{
				command: `gh issue create --title "tracking" --body-file "${file}"`,
				cwd,
			},
			{ rule: "issue-body-from-vault-file" },
		);
	});
});
