// SPDX-License-Identifier: MIT
// DRAFT (not installed): the no-bare-citation rule's block/allow matrix.
//
// Owner rule R4: a PR/issue body cites code by a permalink pinned to a
// commit, or by symbol name — never a bare `path:NN`, because line
// numbers move and dozens of lens findings went stale pointing at them.
//
// Every allowed form and every refused form has a case here:
//   refused  — --body, --body-file (substitution and direct), gh api
//              field/--input, an undated note, a note dated at/after
//              the activation date, a citation inside a fence when the
//              fence toggle is "scan".
//   allowed  — a commit-pinned permalink, a first-line head (lens
//              verdict / design check), a pre-activation note, a fence
//              under the default toggle, a non-body gh command, a GET
//              api call, an unreadable body, and the documented gaps
//              (`:1566` alone, a URL with a port, --fill).
//
// The strip mirror is pinned against the REAL perl one-liner, so the
// text this rule grades is byte-identical to what gh uploads.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defineConfig } from "@cad0p/pi-steering";
import {
	createRecordingHost,
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import githubPlugin, { BODY_STRIP } from "@cad0p/pi-steering-github";
import {
	ACTIVATION_DATE,
	EXEMPT_FENCED_CODE,
	MAX_REPORTED,
	citationRefusal,
	citationScan,
	firstLineHead,
	frontmatterDate,
	isAnchorPath,
	isCitationPath,
	namedPath,
	noBareCitationPlugin,
	noBareCitationRules,
	scanCitations,
	scanShorthands,
	shorthandMisses,
	splitBlocks,
	stripNoteBody,
} from "./no-bare-citation.ts";

/**
 * The gh descriptor is owned by @cad0p/pi-steering-github (the owner's
 * config already lists it), so it is declared here too — `command: "gh"`
 * needs it. The plugin's OWN rules are disabled: this suite grades one
 * rule, and the shipped body-file rules would refuse the same commands
 * for a different reason (the vault-note form), hiding the verdict.
 */
const config = defineConfig({
	plugins: [githubPlugin, noBareCitationPlugin],
	disabledRules: [
		"gh-repo-flag-before-subcommand",
		"pr-body-from-vault-file",
		"pr-create-needs-issue-link",
		"pr-merge-needs-closing-keywords",
		"issue-body-from-vault-file",
		"gh-repo-create-needs-seed",
	],
	rules: [...noBareCitationRules],
});

/** A clone-shaped exec stub: the remote is cad0p/pc-host. */
const host = createRecordingHost({
	exec: (cmd, args) => {
		const answer = (stdout: string) =>
			Promise.resolve({ stdout, stderr: "", code: 0, killed: false });
		if (cmd === "git" && args[0] === "config" && args[2] === "remote.origin.url") {
			return answer("https://github.com/cad0p/pc-host.git");
		}
		return answer("");
	},
});

const harness = loadHarness({ config, host });

/** A 40-hex head (a real pc-host commit id, used as an opaque token). */
const HEAD = "aeb8343440bb6763a7c47bac15a8aa5d91dfecf1";

const RULE = "no-bare-citation";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "steering-r4-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A note with frontmatter carrying `date:`, an H1, then the body. */
function datedNote(name: string, date: string, body: string): string {
	const path = join(root, name);
	writeFileSync(
		path,
		`---\nrepo: pc-host\ntype: pr\ndate: "${date}"\n---\n# Title\n\n${body}\n`,
	);
	return path;
}

/** A note with frontmatter but NO `date:` key (fail-closed case). */
function undatedNote(name: string, body: string): string {
	const path = join(root, name);
	writeFileSync(path, `---\nrepo: pc-host\ntype: pr\n---\n# Title\n\n${body}\n`);
	return path;
}

/** A plain file (no frontmatter) with exactly `text`. */
function plainFile(name: string, text: string): string {
	const path = join(root, name);
	writeFileSync(path, text);
	return path;
}

/** The pinned vault substitution the shipped body-file rules accept. */
function stripSubstitution(file: string): string {
	return `<(perl -0777 -pe '${BODY_STRIP}' "${file}")`;
}

/** Run one bash command at the fixture root. */
function bash(command: string): { command: string; cwd: string } {
	return { command, cwd: root };
}

/** The raw block reason of a refused command. */
async function reasonOf(command: string): Promise<string> {
	const result = await expectBlocks(harness, bash(command), { rule: RULE });
	const raw = result.reason;
	return typeof raw === "string" ? raw : String(raw);
}

describe("no-bare-citation — the harness matrix", () => {
	it("blocks a bare citation in --body on gh pr create", async () => {
		await expectBlocks(
			harness,
			bash('gh pr create --title "x" --body "the loop is at tools/merge-pr.sh:2081"'),
			{ rule: RULE },
		);
	});

	it("blocks a bare range citation on gh pr comment", async () => {
		await expectBlocks(
			harness,
			bash('gh pr comment 1046 --body "reconcile.sh:183-258 is the cause"'),
			{ rule: RULE },
		);
	});

	it("blocks a bare citation on gh issue comment", async () => {
		await expectBlocks(
			harness,
			bash('gh issue comment 7 --body "see docs/image.md:238"'),
			{ rule: RULE },
		);
	});

	it("blocks a bare citation on gh pr edit", async () => {
		await expectBlocks(
			harness,
			bash('gh pr edit 1046 --body "seedreq.go:558"'),
			{ rule: RULE },
		);
	});

	it("blocks an extensionless known file (Dockerfile:38)", async () => {
		await expectBlocks(
			harness,
			bash('gh issue create --title "x" --body "Dockerfile:38 pins the base"'),
			{ rule: RULE },
		);
	});

	it("blocks a bare citation inside a vault note uploaded by substitution", async () => {
		const note = datedNote(
			"2026-11-15-pr1046-r4.md",
			ACTIVATION_DATE,
			"The gate is at tools/merge-pr.sh:2081.",
		);
		await expectBlocks(
			harness,
			bash(`gh pr create --title "x" --body-file ${stripSubstitution(note)}`),
			{ rule: RULE },
		);
	});

	it("blocks a bare citation in a direct --body-file path", async () => {
		const file = plainFile("body.md", "the gate is at tools/merge-pr.sh:2081\n");
		await expectBlocks(
			harness,
			bash(`gh pr create --title "x" --body-file "${file}"`),
			{ rule: RULE },
		);
	});

	it("blocks an undated note (the transition is for a DATED note)", async () => {
		const note = undatedNote("undated.md", "the gate is at tools/merge-pr.sh:2081.");
		await expectBlocks(
			harness,
			bash(`gh pr create --title "x" --body-file ${stripSubstitution(note)}`),
			{ rule: RULE },
		);
	});

	it("blocks a gh api comment POST built from -f body=", async () => {
		await expectBlocks(
			harness,
			bash(
				"gh api repos/cad0p/pc-host/issues/1046/comments -f body='see tools/merge-pr.sh:2081'",
			),
			{ rule: RULE },
		);
	});

	it("blocks a gh api comment POST built from --input JSON", async () => {
		const json = plainFile(
			"comment.json",
			JSON.stringify({ body: "see tools/merge-pr.sh:2081" }),
		);
		await expectBlocks(
			harness,
			bash(`gh api repos/cad0p/pc-host/issues/1046/comments --input "${json}"`),
			{ rule: RULE },
		);
	});

	it("names every offending line and the permalink fix", async () => {
		const reason = await reasonOf(
			'gh pr create --title "x" --body "a tools/merge-pr.sh:2081 b reconcile.sh:183-258"',
		);
		assert.match(reason, /line 1: tools\/merge-pr\.sh:2081/);
		assert.match(reason, /line 1: reconcile\.sh:183-258/);
		assert.match(
			reason,
			/https:\/\/github\.com\/cad0p\/pc-host\/blob\/<40-hex>\/tools\/merge-pr\.sh#L2081/,
		);
		assert.match(reason, /or the symbol: merge_pr\(\) in tools\/merge-pr\.sh/);
		assert.match(reason, new RegExp(ACTIVATION_DATE));
	});

	it("names at most MAX_REPORTED lines and counts the rest", async () => {
		const body = Array.from(
			{ length: MAX_REPORTED + 2 },
			(_, index) => `hit x/f${index}.sh:${index + 1}`,
		).join("; ");
		const reason = await reasonOf(`gh pr create --title "x" --body "${body}"`);
		assert.match(reason, /7 hits/);
		assert.match(reason, /and 2 more/);
	});

	it("allows a body with no citation", async () => {
		await expectAllows(
			harness,
			bash('gh pr create --title "x" --body "no pointers here, just prose"'),
		);
	});

	it("allows a commit-pinned permalink", async () => {
		await expectAllows(
			harness,
			bash(
				`gh pr comment 1046 --body "see https://github.com/cad0p/pc-host/blob/${HEAD}/tools/merge-pr.sh#L2081"`,
			),
		);
	});

	it("allows a lens verdict bound to a head on the first line", async () => {
		const note = datedNote(
			"2026-11-15-pr1046-r1-functional.md",
			ACTIVATION_DATE,
			`Lens: functional @ ${HEAD}\n\nThe gate is at tools/merge-pr.sh:2081 and reconcile.sh:183-258.\n`,
		);
		await expectAllows(
			harness,
			bash(`gh pr comment 1046 --body-file ${stripSubstitution(note)}`),
		);
	});

	it("allows a design check bound to a head on the first line", async () => {
		await expectAllows(
			harness,
			bash(
				`gh pr comment 1046 --body "Design check: round 3 @ ${HEAD}
tools/merge-pr.sh:2081 is fine here because the body is bound to one commit."`,
			),
		);
	});

	it("allows a note dated before the activation date (the transition)", async () => {
		const note = datedNote(
			"2026-11-14-pr1046-r1.md",
			"2026-11-14",
			"the gate is at tools/merge-pr.sh:2081.",
		);
		await expectAllows(
			harness,
			bash(`gh pr create --title "x" --body-file ${stripSubstitution(note)}`),
		);
	});

	it("allows a citation inside a fenced block under the default toggle", async () => {
		const body = `quoted output:\n\n\`\`\`\n$ tools/merge-pr.sh:2081\n\`\`\`\n`;
		await expectAllows(
			harness,
			bash(`gh pr create --title "x" --body "${body}"`),
		);
	});

	it("allows a non-body gh command", async () => {
		await expectAllows(harness, bash("gh pr list --state open"));
	});

	it("allows a gh api GET on the comments endpoint", async () => {
		await expectAllows(
			harness,
			bash("gh api repos/cad0p/pc-host/issues/1046/comments"),
		);
	});

	it("allows a gh api POST that is not a comment endpoint", async () => {
		await expectAllows(
			harness,
			bash("gh api repos/cad0p/pc-host/issues/1046 -f body='tools/x.sh:12'"),
		);
	});

	it("allows an unreadable body (the shipped body-file rule owns it)", async () => {
		await expectAllows(
			harness,
			bash('gh pr create --title "x" --body-file "/nonexistent/body.md"'),
		);
	});

	it("allows the documented gaps: :N alone, a URL with a port, --fill", async () => {
		await expectAllows(
			harness,
			bash('gh pr create --title "x" --body "the same file, :1566, is where it starts"'),
		);
		await expectAllows(
			harness,
			bash('gh pr create --title "x" --body "https://console.piercloud.net:0 is up"'),
		);
		await expectAllows(harness, bash("gh pr create --title x --fill"));
	});

	it("adds no diagnostic of its own (warnings can disable steering)", () => {
		// The shipped gh descriptor carries a KNOWN-benign overload set
		// (duplicate -t / -l / -m / -r / -s / -d / -h spellings, first
		// entry wins) — pinned in that package's integration.test.ts and
		// named in the owner's index.ts. Anything else, and especially
		// anything naming this plugin or its predicate, is new.
		const foreign = harness.diagnostics.filter(
			(diagnostic) =>
				diagnostic.kind !== "invalid-descriptor" ||
				!/CLI descriptor "gh"/.test(diagnostic.message),
		);
		assert.deepEqual(foreign, []);
	});

	it("is strict and routes only on gh", async () => {
		const rule = noBareCitationRules[0];
		assert.equal(rule.name, RULE);
		assert.equal(rule.tool, "bash");
		assert.equal(rule.command, "gh");
		// Strict = the schema default; an explicit noOverride: false would
		// make the rule overridable, which this policy must not be.
		assert.equal((rule as { noOverride?: boolean }).noOverride, undefined);
	});
});

describe("no-bare-citation — the matcher (pure)", () => {
	const matched = (text: string): string[] =>
		scanCitations(text).map((hit) => hit.text);

	it("matches a path with an extension, with and without a slash", () => {
		assert.deepEqual(matched("a tools/merge-pr.sh:2081 b"), ["tools/merge-pr.sh:2081"]);
		assert.deepEqual(matched("a seedreq.go:558 b"), ["seedreq.go:558"]);
		assert.deepEqual(matched("a .github/workflows/ci.yml:12 b"), [
			".github/workflows/ci.yml:12",
		]);
		assert.deepEqual(matched("a ./tools/x.sh:3 b"), ["./tools/x.sh:3"]);
	});

	it("matches a range and keeps it whole", () => {
		const [hit] = scanCitations("reconcile.sh:183-258");
		assert.equal(hit?.path, "reconcile.sh");
		assert.equal(hit?.lines, "183-258");
	});

	it("matches a known extensionless file", () => {
		assert.deepEqual(matched("a Dockerfile:38 b"), ["Dockerfile:38"]);
		assert.deepEqual(matched("a Makefile:12 b"), ["Makefile:12"]);
		assert.deepEqual(matched("a docker/Dockerfile:38 b"), ["docker/Dockerfile:38"]);
	});

	it("matches an extensionless path under a tool directory", () => {
		assert.deepEqual(matched("a tools/pc-ops:120 b"), ["tools/pc-ops:120"]);
		assert.deepEqual(matched("a bin/pc-wt:44 b"), ["bin/pc-wt:44"]);
	});

	it("does not match a bare hostname with a TLD-shaped extension", () => {
		assert.deepEqual(matched("console.piercloud.net:0 is up"), []);
		assert.deepEqual(matched("https://console.piercloud.net:0 is up"), []);
		assert.deepEqual(matched("https://home.test:32823 is up"), []);
	});

	it("does not match a port, a clock time, or a bare :N", () => {
		assert.deepEqual(matched("127.0.0.1:5432 is the db"), []);
		assert.deepEqual(matched("at 12:30 we ship"), []);
		assert.deepEqual(matched("the same file, :1566, is where it starts"), []);
		assert.deepEqual(matched("V4:12 is not a path"), []);
	});

	it("does not match a path#L anchor (a separate decision)", () => {
		assert.deepEqual(matched("tools/merge-pr.sh#L2081"), []);
	});

	it("does not match a :N inside a URL", () => {
		assert.deepEqual(
			matched("https://github.com/cad0p/pc-host/blob/main/tools/x.sh:12"),
			[],
		);
	});

	it("flags a hit inside a fenced block", () => {
		const body = ["before tools/a.sh:1", "\`\`\`", "tools/b.sh:2", "\`\`\`", "after tools/c.sh:3"].join("\n");
		const hits = scanCitations(body);
		assert.deepEqual(
			hits.map((hit) => [hit.text, hit.inFence]),
			[
				["tools/a.sh:1", false],
				["tools/b.sh:2", true],
				["tools/c.sh:3", false],
			],
		);
	});

	it("flags a hit inside a scheme-less commit-pinned permalink as exempt", () => {
		const [hit] = scanCitations(
			`github.com/cad0p/pc-host/blob/${HEAD}/tools/x.sh:12`,
		);
		assert.equal(hit?.permalink, true);
	});

	it("exempts a scheme-less permalink through the gate", async () => {
		await expectAllows(
			harness,
			bash(
				`gh pr comment 1046 --body "see github.com/cad0p/pc-host/blob/${HEAD}/tools/x.sh:12"`,
			),
		);
	});

	it("isCitationPath rejects directories and bare words", () => {
		assert.equal(isCitationPath("tools"), false);
		assert.equal(isCitationPath("tools/tests"), true);
		assert.equal(isCitationPath("main"), false);
		assert.equal(isCitationPath("x.com"), false);
		assert.equal(isCitationPath("x.sh"), true);
	});

	it("citationScan applies the fence toggle", () => {
		const body = ["\`\`\`", "tools/b.sh:2", "\`\`\`"].join("\n");
		assert.equal(citationScan(body).refused.length, 0);
		assert.equal(citationScan(body, { fencedCode: "scan" }).refused.length, 1);
	});

	it("EXEMPT_FENCED_CODE is the documented default", () => {
		assert.equal(EXEMPT_FENCED_CODE, "exempt");
	});
});

describe("no-bare-citation — the body-level exemptions (pure)", () => {
	const source = (body: string, date: string | null) => ({
		where: "the test body",
		body,
		date,
	});

	it("exempts a note dated before the activation date", () => {
		assert.equal(
			citationRefusal(source("tools/a.sh:1", "2026-11-14")),
			null,
		);
	});

	it("gates a note dated ON the activation date", () => {
		assert.notEqual(
			citationRefusal(source("tools/a.sh:1", ACTIVATION_DATE)),
			null,
		);
	});

	it("gates a body with no date (fail-closed)", () => {
		assert.notEqual(citationRefusal(source("tools/a.sh:1", null)), null);
	});

	it("honours an activationDate override", () => {
		assert.equal(
			citationRefusal(source("tools/a.sh:1", "2026-11-20"), {
				activationDate: "2026-12-01",
			}),
			null,
		);
	});

	it("exempts a body whose first non-blank line names a head", () => {
		assert.equal(
			citationRefusal(source(`\n\nLens: red-team @ ${HEAD}\ntools/a.sh:1`, null)),
			null,
		);
	});

	it("does not exempt a head on the second line", () => {
		assert.notEqual(
			citationRefusal(source(`a summary line\nLens: red-team @ ${HEAD}\ntools/a.sh:1`, null)),
			null,
		);
	});

	it("firstLineHead needs a standalone 40-hex token", () => {
		assert.equal(firstLineHead("Lens: functional @ " + HEAD), HEAD);
		assert.equal(firstLineHead("Lens: functional @ " + HEAD + "ff"), null);
		assert.equal(firstLineHead("Lens: functional @ " + HEAD.slice(0, 39)), null);
		assert.equal(firstLineHead(""), null);
	});

	it("frontmatterDate reads a quoted and an unquoted date", () => {
		assert.equal(frontmatterDate('---\ndate: "2026-11-14"\n---\n'), "2026-11-14");
		assert.equal(frontmatterDate("---\ndate: 2026-11-14T10:00:00Z\n---\n"), "2026-11-14");
		assert.equal(frontmatterDate("---\nrepo: x\n---\n"), null);
	});
});

describe("no-bare-citation — the strip mirror is pinned to perl", () => {
	const fixtures: ReadonlyArray<[string, string]> = [
		["frontmatter + H1", '---\ndate: "2026-11-14"\n---\n# Title\n\nbody tools/a.sh:1\n'],
		["frontmatter only", "---\ndate: x\n---\n\nbody\n"],
		["no frontmatter, H1 kept", "# Title\n\nbody\n"],
		["unterminated frontmatter", "---\ndate: x\nbody\n"],
		["CRLF frontmatter", "---\r\ndate: x\r\n---\r\n# Title\r\n\r\nbody\r\n"],
		["BOM frontmatter", "\uFEFF---\ndate: x\n---\n# Title\n\nbody\n"],
		["#foo is not an H1", "---\ndate: x\n---\n#foo\nbody\n"],
		["indented heading kept", "---\ndate: x\n---\n  # Title\n\nbody\n"],
		["empty", ""],
	];

	for (const [name, text] of fixtures) {
		it(`matches perl: ${name}`, () => {
			const perl = spawnSync("perl", ["-0777", "-pe", BODY_STRIP], {
				input: text,
				encoding: "utf8",
			});
			assert.equal(perl.error, undefined, "perl must be installed");
			assert.equal(perl.status, 0);
			assert.equal(stripNoteBody(text), perl.stdout);
		});
	}
});

describe("no-bare-citation — bodies it cannot inspect (pinned gaps)", () => {
	it("allows a stdin body file", async () => {
		await expectAllows(harness, bash('gh pr create --title x --body-file -'));
	});

	it("allows a stdin api field", async () => {
		await expectAllows(
			harness,
			bash("gh api repos/cad0p/pc-host/issues/1/comments -f body=@-"),
		);
	});

	it("allows a stdin api --input", async () => {
		await expectAllows(
			harness,
			bash("gh api repos/cad0p/pc-host/issues/1/comments --input -"),
		);
	});

	it("allows an --input file that is not JSON", async () => {
		const file = plainFile("not-json.txt", "tools/x.sh:12\n");
		await expectAllows(
			harness,
			bash(`gh api repos/cad0p/pc-host/issues/1/comments --input "${file}"`),
		);
	});

	it("allows an --input JSON with no body key", async () => {
		const file = plainFile("no-body.json", JSON.stringify({ event: "COMMENT" }));
		await expectAllows(
			harness,
			bash(`gh api repos/cad0p/pc-host/issues/1/comments --input "${file}"`),
		);
	});

	it("blocks a gh api PATCH that edits a comment body", async () => {
		await expectBlocks(
			harness,
			bash(
				"gh api -X PATCH repos/cad0p/pc-host/issues/comments/1 -f body='tools/x.sh:12'",
			),
			{ rule: RULE },
		);
	});

	it("allows a gh api PATCH with no body field", async () => {
		await expectAllows(
			harness,
			bash("gh api -X PATCH repos/cad0p/pc-host/issues/comments/1 -f body_text='x'"),
		);
	});
});

describe("no-bare-citation — the shorthand matcher (pure)", () => {
	const shorthand = (text: string): string[] =>
		scanShorthands(text).map((hit) => hit.text);

	it("matches :N and :N-M after a path in the same paragraph", () => {
		assert.deepEqual(
			shorthand("the S5 tasks in ansible/tasks/main.yml cite (:365-434)"),
			[":365-434"],
		);
		assert.deepEqual(shorthand("tools/merge-pr.sh moves, see :2081"), [":2081"]);
	});

	it("keeps the anchor: the LAST path named before the shorthand", () => {
		const [hit] = scanShorthands("first a.sh, then tools/b.go, at :12");
		assert.equal(hit?.anchor, "tools/b.go");
		assert.equal(hit?.path, "tools/b.go");
		assert.equal(hit?.kind, "shorthand");
		assert.equal(hit?.permalink, false);
		assert.equal(hit?.lines, "12");
	});

	it("matches after a code-spanned path whose line part is outside the span", () => {
		assert.deepEqual(shorthand("`pc-slice.timer.j2`:7-11 is the row"), [":7-11"]);
	});

	it("matches a chain of line numbers after one path", () => {
		assert.deepEqual(
			shorthand("internal/db/migrate_test.go:49/:58 and :61"),
			[":58", ":61"],
		);
	});

	it("matches after a v1 citation", () => {
		assert.deepEqual(
			shorthand("the gate is at tools/merge-pr.sh:2081, :2085 and :2090"),
			[":2085", ":2090"],
		);
	});

	it("matches after a permalink and after a commit:path token", () => {
		assert.deepEqual(
			shorthand(
				`see https://github.com/cad0p/pc-host/blob/${HEAD}/tools/x.sh#L12 and :14`,
			),
			[":14"],
		);
		assert.deepEqual(
			shorthand("e8b29af:terraform/aws-mail/receipt.tf opens at :29"),
			[":29"],
		);
	});

	it("matches after a possessive code span and a #L anchor", () => {
		assert.deepEqual(shorthand("`enroll.html`'s comment is at :253-259"), [":253-259"]);
		assert.deepEqual(shorthand("tools/x.sh#L12 is fine, :14 is not"), [":14"]);
	});

	it("normalizes an en dash range to an ASCII hyphen", () => {
		const [hit] = scanShorthands("tools/x.sh lines :365\u2013434");
		assert.equal(hit?.text, ":365\u2013434");
		assert.equal(hit?.lines, "365-434");
	});

	it("does not match without a path in the same block", () => {
		assert.deepEqual(shorthand("the same file, :1566, is where it starts"), []);
	});

	it("does not match a path named in a previous paragraph (blank line)", () => {
		assert.deepEqual(shorthand("tools/x.sh is the file\n\nthe tasks cite (:365-434)"), []);
	});

	it("does not match a path named in a previous list item", () => {
		assert.deepEqual(
			shorthand("- tools/x.sh names the file\n- the tasks cite (:365-434)"),
			[],
		);
	});

	it("matches inside one list item, including its continuation lines", () => {
		assert.deepEqual(
			shorthand("- tools/x.sh names the file,\n  and the tasks cite (:365-434)"),
			[":365-434"],
		);
	});

	it("does not match a path named in a previous table row", () => {
		const table = [
			"| file | line |",
			"| --- | --- |",
			"| tools/x.sh | :365 |",
			"| other | :12 |",
		].join("\n");
		assert.deepEqual(shorthand(table), [":365"]);
	});

	it("does not match a path named in a heading", () => {
		assert.deepEqual(shorthand("# tools/x.sh\n\nthe tasks cite (:365-434)"), []);
		assert.deepEqual(shorthand("# tools/x.sh :365"), [":365"]);
	});

	it("does not resolve a path named in prose into a fenced block", () => {
		assert.deepEqual(shorthand("tools/x.sh is the file\n\n```\n:365-434\n```"), []);
		const [hit] = scanShorthands("```\ntools/x.sh\n:365-434\n```");
		assert.equal(hit?.inFence, true);
		assert.equal(hit?.text, ":365-434");
	});

	it("does not resolve a path named in prose into an indented code block", () => {
		assert.deepEqual(shorthand("tools/x.sh is the file\n\n    :365-434"), []);
	});

	it("splitBlocks names the block kinds and their first line", () => {
		const body = [
			"# h",
			"",
			"para a",
			"para b",
			"",
			"- item",
			"  cont",
			"- item2",
			"",
			"| a | b |",
			"",
			"```",
			"fence",
			"```",
			"",
			"    code",
			"",
		].join("\n");
		assert.deepEqual(
			splitBlocks(body).map((block) => [block.kind, block.line]),
			[
				["heading", 1],
				["paragraph", 3],
				["list-item", 6],
				["list-item", 8],
				["table-row", 10],
				["fence", 12],
				["code", 16],
			],
		);
	});
});

describe("no-bare-citation — the false-positive ledger (pure)", () => {
	// Every case names a path FIRST, so the only thing that can save the
	// `:N` is the boundary rule (or the anchor rule) — not a missing anchor.
	const after = (tail: string): string => `tools/x.sh is the file; ${tail}`;
	const refused = (text: string): string[] =>
		scanShorthands(text).map((hit) => hit.text);
	const reasons = (text: string): string[] =>
		shorthandMisses(text).map((miss) => miss.reason);

	const cases: ReadonlyArray<[string, string, RegExp]> = [
		["a clock time with a zone", after("it ran at 02:41Z"), /clock time or a ratio/],
		["a clock time", after("it ran at 12:30 today"), /clock time or a ratio/],
		["an ISO timestamp", after("at 2026-11-15T02:41:00Z"), /clock time or a ratio/],
		["a ratio", after("a 3:1 ratio"), /clock time or a ratio/],
		["a video ratio", after("a 16:9 crop"), /clock time or a ratio/],
		["an IPv6 literal", after("it dials fe80::1"), /IPv6 or a double colon/],
		["a bracketed IPv6 with a port", after("it dials [::1]:8080"), /IPv6|host:port/],
		["an IPv6 prefix", after("2001:db8::1 is the leaf"), /IPv6 or a double colon/],
		["a URL with a port", after("see https://console.piercloud.net:0"), /host:port/],
		[
			"a database URL with a port",
			after("postgres://u:p@127.0.0.1:55511/db"),
			/clock time or a ratio|host:port/,
		],
		["a placeholder host with a port", after("served at <bridge>:8443"), /placeholder host/],
		["a localhost port", after("it listens on localhost:8080"), /host:port/],
		["a lens label", after("Lens:2: CLEAN"), /word or a host:port/],
		["a YAML key", after("line:12 is the key"), /word or a host:port/],
		["a YAML key with no space", after("date:2026-11-15"), /word or a host:port/],
		["a JSON key", after('{"v":1} is the document'), /quoted key/],
		["a JSON key with a name", after('"schema_version":47'), /quoted key/],
		["a numeric emoji shortcode", after(":100: and :1234:"), /emoji shortcode/],
		[
			"an ARN",
			after("arn:aws:iam::219806732058:user/pc-operator"),
			/IPv6 or a double colon|runs into/,
		],
		[
			"a dotted identifier as the only anchor",
			"ReconcileClass.Expected is the field, at :12",
			/no path named earlier/,
		],
		["a dotted host", after("HTTPS://OPS.PierCloud.NET.:443"), /dotted token/],
	];

	for (const [name, text, reason] of cases) {
		it(`does not read ${name} as a citation`, () => {
			assert.deepEqual(refused(text), []);
			const found = reasons(text);
			assert.ok(
				found.some((entry) => reason.test(entry)),
				`expected ${reason} in ${JSON.stringify(found)}`,
			);
		});
	}

	it("a named emoji shortcode is not even a candidate", () => {
		const text = after(":smile: :+1: :woman-technologist:");
		assert.deepEqual(refused(text), []);
		assert.deepEqual(reasons(text), []);
	});

	it("a label written without a space is still a word, not a citation", () => {
		assert.deepEqual(refused(after("Lens:2: CLEAN")), []);
		assert.deepEqual(refused(after("Lens:2")), []);
	});

	it("a line number followed by a colon is a citation (the :172: shape)", () => {
		// `:172: ${message}` is how a note quotes a test's printed line; the
		// corpus has 10 of these and 0 numeric labels, so the colon after the
		// number is punctuation, not a disqualifier.
		assert.deepEqual(
			refused(after("the pair is `:172: \u2026 (SQLSTATE 42501)`")),
			[":172"],
		);
	});

	it("a spaced label and a spaced YAML key have no candidate at all", () => {
		for (const text of [after("Lens: 2: CLEAN"), after("date: 2026-11-15")]) {
			assert.deepEqual(refused(text), []);
			assert.deepEqual(reasons(text), []);
		}
	});

	it("never reports a matched shorthand as a miss", () => {
		const body =
			"tools/x.sh at :12, 12:30, :100:, internal/db/x.go:49/:58, and :smile:";
		const hits = new Set(
			scanShorthands(body).map((hit) => `${hit.line}:${hit.text}`),
		);
		for (const miss of shorthandMisses(body)) {
			assert.equal(
				hits.has(`${miss.line}:${miss.text}`),
				false,
				`${miss.text} is both a hit and a miss`,
			);
		}
	});

	it("namedPath rejects a dotted identifier and reads a commit:path token", () => {
		assert.equal(namedPath("ReconcileClass.Expected"), null);
		assert.equal(isAnchorPath("ReconcileClass.Expected"), false);
		assert.equal(isAnchorPath("e.g"), false);
		assert.equal(isAnchorPath("i.e"), false);
		assert.equal(isAnchorPath("x.h"), false);
		assert.equal(isAnchorPath("src/x.h"), true);
		assert.equal(namedPath("e.g. the guard"), null);
		assert.equal(isAnchorPath("internal/db/migrate_test.go"), true);
		assert.equal(
			namedPath("e8b29af:terraform/aws-mail/receipt.tf"),
			"terraform/aws-mail/receipt.tf",
		);
		assert.equal(namedPath("`pc-slice.timer.j2`:7-11"), "pc-slice.timer.j2");
		assert.equal(namedPath("`enroll.html`'s"), "enroll.html");
	});
});

describe("no-bare-citation — the shorthand in the harness", () => {
	it("blocks a shorthand after a path in --body", async () => {
		await expectBlocks(
			harness,
			bash('gh pr comment 1046 --body "the S5 tasks in ansible/tasks/main.yml cite (:365-434)"'),
			{ rule: RULE },
		);
	});

	it("blocks a shorthand in a vault note uploaded by substitution", async () => {
		const note = datedNote(
			"2026-11-16-pr1046-r2.md",
			ACTIVATION_DATE,
			"The gate is at tools/merge-pr.sh:2081, and :2085 is the retry.",
		);
		await expectBlocks(
			harness,
			bash(`gh pr create --title "x" --body-file ${stripSubstitution(note)}`),
			{ rule: RULE },
		);
	});

	it("names the shorthand, its anchor and the permalink fix", async () => {
		const reason = await reasonOf(
			'gh pr comment 1046 --body "tools/merge-pr.sh moves; the retry is at :2085"',
		);
		assert.match(reason, /1 hit/);
		assert.match(reason, /a bare :NN shorthand/);
		assert.match(reason, /line 1: :2085 \(a shorthand for tools\/merge-pr\.sh\)/);
		assert.match(
			reason,
			/https:\/\/github\.com\/cad0p\/pc-host\/blob\/<40-hex>\/tools\/merge-pr\.sh#L2085/,
		);
	});

	it("allows a shorthand in a head-bound body", async () => {
		await expectAllows(
			harness,
			bash(
				`gh pr comment 1046 --body "Design check: round 3 @ ${HEAD}
tools/merge-pr.sh moves; the retry is at :2085."`,
			),
		);
	});

	it("allows a shorthand in a note dated before the activation date", async () => {
		const note = datedNote(
			"2026-11-14-pr1046-r1.md",
			"2026-11-14",
			"tools/merge-pr.sh moves; the retry is at :2085.",
		);
		await expectAllows(
			harness,
			bash(`gh pr create --title "x" --body-file ${stripSubstitution(note)}`),
		);
	});

	it("allows a shorthand inside a fenced block under the default toggle", async () => {
		const body = "tools/x.sh is the file\\n\\n```\\n:365-434\\n```\\n";
		await expectAllows(
			harness,
			bash(`gh pr create --title "x" --body "${body}"`),
		);
	});

	it("still allows a bare :N with no path in its paragraph", async () => {
		await expectAllows(
			harness,
			bash('gh pr create --title "x" --body "the same file, :1566, is where it starts"'),
		);
	});
});
