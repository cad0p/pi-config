// SPDX-License-Identifier: MIT
// Global pi-steering config — integration test.
//
// Two plugin families are exercised end-to-end through the REAL
// loader + loadHarness:
//
//   - The napkin steering plugin (`@cad0p/pi-napkin/steering`,
//     pi-napkin #73): an `isNapkinVault` predicate does a read-only
//     `.napkin/` (or `.obsidian/.napkin/`) walk-up from the command's
//     effective cwd, and two exemptions narrow the shipped
//     `no-main-commit` / `no-main-commit-github` guards to vaults.
//     Exemptions are STRICTLY fail-closed — the walker-unknown cwd
//     test below pins that a dynamic checkout can't slip through.
//     Detection is filesystem-based: the carve-out scenarios use REAL
//     fixture dirs (mkdtemp) for vault / non-vault, plus the real
//     Goldmine path on this machine.
//
//   - The github plugin package (`@cad0p/pi-steering-github`,
//     "every PR must have at least one attached issue" policy):
//     `gh pr create|new|edit` bodies must come from vault body files
//     (`<repo>/prs/`), `gh issue create|edit` bodies from `<repo>/issues/`
//     vault files, PRs need closing keywords in title + body, and
//     merges need the closing keyword in the `--subject` commit-subject channel (body optional). The
//     `missingVaultBodyFile` predicate walks the real filesystem
//     (vault detection + repo-name check via the exec stub), so these
//     scenarios also use REAL fixture dirs.

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { loadSteeringConfig } from "@cad0p/pi-steering";
import {
	createRecordingHost,
	loadHarness,
	mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
// The pinned perl strip program, imported from the installed package's
// own dist so the test can never drift from the predicate's token
// byte-pin (the package does not re-export it from its root).
import { BODY_STRIP } from "./node_modules/@cad0p/pi-steering-github/dist/predicates/missing-vault-body-file.js";

// The config is loaded through pi-steering's real loader (jiti
// evalModule) rather than statically imported: the test runner's
// native type stripping refuses `.ts` files under node_modules, and
// `@cad0p/pi-napkin` ships its `./steering` subpath as raw `.ts`
// (cad0p/pi-napkin #77 — fixed on the runtime path by pi-steering
// #23's jiti loader). Loading via `loadSteeringConfig` also tests the
// exact production load path.
let config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"];

before(async () => {
	const { config: merged, diagnostics } = await loadSteeringConfig(
		process.cwd(),
	);
	for (const d of diagnostics) {
		assert.equal(
			d.type,
			"error",
			`unexpected diagnostic while loading global config: ${d.message}`,
		);
	}
	config = merged;
});

/** The real Goldmine path on THIS machine. */
const REAL_GOLDMINE = `${homedir()}/personal/github/Goldmine`;

/** Fixture dirs created per test, cleaned up after. */
const fixtures: string[] = [];

function makeFixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "steering-fixture-"));
	fixtures.push(dir);
	return dir;
}

function makeVaultFixture(): string {
	const dir = makeFixtureDir();
	mkdirSync(join(dir, ".napkin"));
	return dir;
}

function makeNestedVaultFixture(): string {
	const dir = makeFixtureDir();
	mkdirSync(join(dir, ".obsidian", ".napkin"), { recursive: true });
	return dir;
}

/**
 * A napkin-vault fixture laid out like the real Goldmine convention:
 * `<vault>/open-source/github/<repo>/prs|issues/<date>-pr|issue<N>-<slug>.md`.
 */
interface VaultRepoFixture {
	vault: string;
	repo: string;
	prBodyFile: string;
	issueBodyFile: string;
}

function makeVaultRepoFixture(repo: string): VaultRepoFixture {
	const vault = makeVaultFixture();
	const prsDir = join(vault, "open-source", "github", repo, "prs");
	const issuesDir = join(vault, "open-source", "github", repo, "issues");
	mkdirSync(prsDir, { recursive: true });
	mkdirSync(issuesDir, { recursive: true });
	const prBodyFile = join(prsDir, `2026-08-14-pr1-${repo}-test.md`);
	writeFileSync(prBodyFile, "---\ntags: [test]\n---\n# Title\n\nCloses #12\n\nBody.\n");
	const issueBodyFile = join(issuesDir, `2026-08-14-issue1-${repo}-test.md`);
	writeFileSync(issueBodyFile, "---\ntags: [test]\n---\n# Title\n\nIssue body text.\n");
	return { vault, repo, prBodyFile, issueBodyFile };
}

/** The pinned perl substitution form the vault body-file rules require. */
function stripSubstitution(file: string): string {
	return `<(perl -0777 -pe '${BODY_STRIP}' "${file}")`;
}

/**
 * JS mirror of the pinned perl program (test stub only — the real
 * behavior is pinned by body-strip.test.ts spawning perl).
 */
function stripFrontmatter(content: string): string {
	return content.replace(
		/^(?:\uFEFF)?---\r?\n(?:.*?\r?\n)?(?:---|\.\.\.)\r?\n(?:\r?\n)*(?:[ \t]*\r?\n)*(?:#(?!\S)[^\n]*(?:\r?\n)?(?:[ \t]*\r?\n)*)?/,
		"",
	);
}

afterEach(() => {
	for (const dir of fixtures.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Build a host whose `exec` stub answers git queries as if the cwd is
 * a github clone on a feature branch. The branch predicate shells out
 * to `git branch --show-current`; the github rule's `remote:`
 * predicate and the `missingVaultBodyFile` predicate shell out to
 * `git config --get remote.origin.url`.
 */
function hostWithRemote(remoteUrl: string): ReturnType<typeof createRecordingHost> {
	return createRecordingHost({
		exec: (cmd, args) => {
			const sub = args[0];
			if (cmd === "git" && sub === "branch" && args[1] === "--show-current") {
				return Promise.resolve({ stdout: "main", stderr: "", code: 0, killed: false } satisfies ExecResult);
			}
			if (cmd === "git" && sub === "config" && args[1] === "--get" && args[2] === "remote.origin.url") {
				return Promise.resolve({
					stdout: remoteUrl,
					stderr: "",
					code: 0,
					killed: false,
				} satisfies ExecResult);
			}
			if (cmd === "perl" && args[0] === "-0777" && args[1] === "-pe") {
				// The keyword check runs the pinned one-liner: answer with
				// the stripped file content (canonical = what gh uploads).
				const file = args[3];
				if (file === undefined) {
					return Promise.resolve({ stdout: "", stderr: "", code: 1, killed: false } satisfies ExecResult);
				}
				return Promise.resolve({
					stdout: stripFrontmatter(readFileSync(file, "utf8")),
					stderr: "",
					code: 0,
					killed: false,
				} satisfies ExecResult);
			}
			return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false } satisfies ExecResult);
		},
	});
}

function hostOnMainGithub(): ReturnType<typeof createRecordingHost> {
	return hostWithRemote("https://github.com/cad0p/Goldmine.git");
}

/**
 * Evaluate a bash command at a given cwd. Uses a fresh host + ctx per
 * call so exec state doesn't leak across assertions. The cwd must be
 * a REAL directory — the vault predicates walk the filesystem.
 */
async function evaluateBash(
	cwd: string,
	command: string,
	host: ReturnType<typeof createRecordingHost> = hostOnMainGithub(),
): Promise<{ block: boolean; rule: string | null | undefined }> {
	const ctx = mockExtensionContext(cwd, host.entries);
	const harness = loadHarness({ config, host, includeDefaults: true });
	const event = {
		type: "tool_call",
		toolCallId: "tc1",
		toolName: "bash",
		input: { command },
	} as unknown as Parameters<typeof harness.evaluate>[0];
	const result = await harness.evaluate(event, ctx, 1);
	if (result === undefined || result === null || result.block !== true) {
		return { block: false, rule: null };
	}
	const raw = result.reason ?? "";
	const reason = typeof raw === "string" ? raw : String(raw);
	const match = reason.match(/^\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
	return { block: true, rule: match ? match[1] : null };
}

describe("global config — shape", () => {
	it("declares gitPlugin + the napkin steering plugin + the github plugin package (opt-in since the monorepo split)", () => {
		// Since the pi-steering monorepo split (2026-08-10) DEFAULT_PLUGINS
		// is empty: plugins are opt-in and MUST be declared here. The
		// github plugin ships as @cad0p/pi-steering-github (2026-08-14)
		// — PR issue-link + vault body-file policy.
		const pluginNames = config.plugins?.map((p) => p.name) ?? [];
		assert.deepEqual(pluginNames, ["git", "napkin", "github", "agent-dir"]);
	});

	it("napkin plugin ships the two exemptions targeting the SHIPPED commit-on-main rules", () => {
		// The exemptions live on the plugin (pi-napkin #73), not in
		// this config. They target the git plugin's rule names — a
		// stable public contract.
		const plugin = config.plugins?.find((p) => p.name === "napkin");
		assert.ok(plugin, "napkin plugin should be registered");
		const exemptions = plugin?.exemptions ?? [];
		assert.equal(exemptions.length, 2);
		const targets = exemptions.map((e) => e.rule).sort();
		assert.deepEqual(targets, ["no-main-commit", "no-main-commit-github"]);
	});

	it("does NOT disable the shipped commit-on-main rules", () => {
		const disabled = config.disabledRules ?? [];
		assert.ok(!disabled.includes("no-main-commit"));
		assert.ok(!disabled.includes("no-main-commit-github"));
	});

	it("github prototype: strict rules in roster order with the vault predicate registered", () => {
		const plugin = config.plugins?.find((p) => p.name === "github");
		assert.ok(plugin, "github plugin should be registered");
		// Body-file rule first — first-match-wins routing until #47
		// (aggregation with per-rule stop) lands.
		assert.deepEqual(
			plugin?.rules?.map((r) => r.name),
			[
				"pr-body-from-vault-file",
				"pr-create-needs-issue-link",
				"pr-merge-needs-closing-keywords",
				"issue-body-from-vault-file",
				"gh-repo-create-needs-seed",
			],
		);
		for (const r of plugin?.rules ?? []) {
			assert.equal(r.tool, "bash");
			assert.equal(r.field, "command");
			assert.ok(!("noOverride" in r), `${r.name} must be strict`);
		}
		assert.equal(typeof plugin?.predicates?.missingVaultBodyFile, "function");
	});
});

describe("global config — carve-out behavior (real fixtures)", () => {
	it("allows `git commit` on main inside a vault root (.napkin/ marker)", async () => {
		const vault = makeVaultFixture();
		const { block, rule } = await evaluateBash(vault, "git commit -m 'note'");
		assert.equal(block, false, `expected allow at ${vault}, got block by ${rule}`);
	});

	it("allows `git commit` on main inside a vault subdirectory (walk-up)", async () => {
		const vault = makeVaultFixture();
		const subdir = join(vault, "notes");
		mkdirSync(subdir);
		const { block, rule } = await evaluateBash(subdir, "git commit -m 'note'");
		assert.equal(block, false, `expected allow at ${subdir}, got block by ${rule}`);
	});

	it("allows `git commit` on main inside a nested-layout vault (.obsidian/.napkin/)", async () => {
		const vault = makeNestedVaultFixture();
		const { block, rule } = await evaluateBash(vault, "git commit -m 'note'");
		assert.equal(block, false, `expected allow at ${vault}, got block by ${rule}`);
	});

	it("allows `git commit` on main inside the agent dir (~/.pi — config repo commits by design)", async () => {
		// The global steering config repo itself: ~/.pi/agent/steering is
		// a real github clone on main whose ruleset has NO pull_request
		// rule — config syncs commit to main directly.
		const agentDir = join(homedir(), ".pi", "agent", "steering");
		const { block, rule } = await evaluateBash(agentDir, "git commit -m 'note'");
		assert.equal(block, false, `expected allow at ${agentDir}, got block by ${rule}`);
	});

	it("allows `git commit` on main in an agent-dir subdirectory (settings/, prompts/)", async () => {
		const { block, rule } = await evaluateBash(
			join(homedir(), ".pi", "agent", "settings"),
			"git commit -m 'note'",
		);
		assert.equal(block, false, `expected allow at ~/.pi/agent/settings, got block by ${rule}`);
	});

	it("still blocks `git commit` on main OUTSIDE any vault (github clone)", async () => {
		const outside = makeFixtureDir();
		const { block, rule } = await evaluateBash(outside, "git commit -m 'x'");
		assert.equal(block, true, `expected block outside vault at ${outside}`);
		assert.equal(
			rule,
			"no-main-commit-github",
			`expected shipped github rule to fire, got ${rule}`,
		);
	});

	it("carve-out is scoped to commit-on-main — force-push still blocks in the vault", async () => {
		const vault = makeVaultFixture();
		const { block, rule } = await evaluateBash(vault, "git push --force");
		assert.equal(block, true, "force-push must block inside vault");
		assert.equal(rule, "no-force-push", `expected no-force-push, got ${rule}`);
	});

	it("carve-out is scoped to commit-on-main — hard-reset still blocks in the vault", async () => {
		const vault = makeVaultFixture();
		const { block, rule } = await evaluateBash(vault, "git reset --hard HEAD~1");
		assert.equal(block, true, "hard-reset must block inside vault");
		assert.equal(rule, "no-hard-reset", `expected no-hard-reset, got ${rule}`);
	});

	it("walker-unknown cwd stays fail-closed — `cd \"$X\" && git commit` blocks", async () => {
		// The carve-out must NOT open a dynamic-checkout bypass. The
		// walker surfaces "unknown" for `cd "$X"`; exemptions are
		// STRICTLY fail-closed (#26 milestone 7) — unknown cwd does
		// NOT exempt, the guard's own `onUnknown` policy fires
		// fail-CLOSED.
		const vault = makeVaultFixture();
		const { block } = await evaluateBash(vault, 'cd "$X" && git commit -m y');
		assert.equal(block, true, "dynamic-cwd commit must not slip past the carve-out");
	});
});

describe("global config — github rules (issue-link + vault body-file policy)", () => {
	const repo = "fixture-repo";
	const remote = `https://github.com/cad0p/${repo}.git`;
	const host = hostWithRemote(remote);

	// ---- pr-body-from-vault-file (runs FIRST — first-match-wins) ----

	it("allows pr create with keyword title + stripped vault prs/ body file (frontmatter + H1)", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("allows a chain-set \$BODY vault body file (issue #51 resolved-by-default words)", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`BODY=${fx.prBodyFile} && gh pr create --title "feat: x (closes #12)" --body-file <(perl -0777 -pe '${BODY_STRIP}' "$BODY")`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("allows pr create with a stripped body file in a nested-layout vault (.obsidian/.napkin/)", async () => {
		const vault = makeNestedVaultFixture();
		const prsDir = join(vault, "open-source", "github", repo, "prs");
		mkdirSync(prsDir, { recursive: true });
		const bodyFile = join(prsDir, "2026-08-14-pr1-nested.md");
		writeFileSync(bodyFile, "Closes #12\n");
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(bodyFile)}`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("allows pr edit with a stripped vault prs/ body file", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr edit 46 --body-file ${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("allows issue create with a stripped vault issues/ body file", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh issue create --title "tracking" --body-file ${stripSubstitution(fx.issueBodyFile)}`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("allows issue edit with a stripped vault issues/ body file", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh issue edit 29 --body-file ${stripSubstitution(fx.issueBodyFile)}`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("allows the glued --body-file=<(…) form (walker-split into two words)", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file=${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("blocks pr create with inline --body (vault body file required)", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body "Closes #12"`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it("blocks a DIRECT vault path (only the strip-helper substitution is accepted)", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file "${fx.prBodyFile}"`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it("blocks issue create with a DIRECT vault path", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh issue create --title "tracking" --body-file "${fx.issueBodyFile}"`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "issue-body-from-vault-file");
	});

	it("blocks pr create with a non-strip inner command (<(cat …))", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file <(cat "${fx.prBodyFile}")`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it("blocks pr create with a substitution pointing OUTSIDE any vault", async () => {
		// Form OK, but the path must resolve inside a napkin vault — a
		// non-vault path is missing (restored validation, #12).
		const outside = makeFixtureDir();
		const bodyFile = join(outside, "body.md");
		writeFileSync(bodyFile, "Closes #12\n");
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(bodyFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it("blocks pr create with a substitution pointing at a wrong-section file", async () => {
		// issues/ file carrying a keyword: the vault-relative path must
		// contain <repo>/<section>/ (restored validation, #12).
		const fx = makeVaultRepoFixture(repo);
		const kwFile = join(dirname(fx.issueBodyFile), "2026-08-14-issue2-kw.md");
		writeFileSync(kwFile, "Closes #12\n");
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(kwFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it("blocks pr create with a substitution pointing at another repo's file", async () => {
		// File lives under open-source/github/other-repo/prs/ — the
		// vault-relative path must contain the COMMAND repo's name
		// (origin basename, cwd-folder fallback) (restored, #12).
		const fx = makeVaultRepoFixture("other-repo");
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it('blocks a substitution under a dynamic cwd (cd "$X") — fail-closed', async () => {
		// The path resolves against the command's cwd; a walker-unknown
		// cwd is unverifiable → missing (restored validation, #12).
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`cd "$X" && gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it("blocks pr edit with inline --body", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr edit 46 --body "Closes #12"`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-body-from-vault-file");
	});

	it("blocks issue create with inline --body", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh issue create --title "tracking" --body "notes"`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "issue-body-from-vault-file");
	});

	it("blocks issue create with a prs/ file via substitution (wrong section)", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh issue create --title "tracking" --body-file ${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "issue-body-from-vault-file");
	});

	// ---- pr-create-needs-issue-link ----

	it("blocks pr create when the stripped vault body lacks the closing keyword", async () => {
		const fx = makeVaultRepoFixture(repo);
		const badFile = join(dirname(fx.prBodyFile), "2026-08-14-pr2-nokw.md");
		writeFileSync(badFile, "## What\n\nNo keywords here.\n");
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(badFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-create-needs-issue-link");
	});

	it("blocks pr create when the closing keyword ONLY appears in frontmatter", async () => {
		const fx = makeVaultRepoFixture(repo);
		const kwFile = join(dirname(fx.prBodyFile), "2026-08-14-pr2-fmkw.md");
		writeFileSync(
			kwFile,
			"---\ncloses: #12\n---\n# Title\n\nNo keyword here.\n",
		);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(kwFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-create-needs-issue-link");
	});

	it("blocks pr create when the title lacks the keyword (body file has it)", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x" --body-file ${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-create-needs-issue-link");
	});

	it("blocks pr create with a bare (#12) title mention (mention != close)", async () => {
		const fx = makeVaultRepoFixture(repo);
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "feat: x (#12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-create-needs-issue-link");
	});

	it("allows multi-issue keyword-per-issue in the vault body file", async () => {
		const fx = makeVaultRepoFixture(repo);
		const multiFile = join(dirname(fx.prBodyFile), "2026-08-14-pr3-multi.md");
		writeFileSync(multiFile, "Closes #12, closes #15\n");
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr create --title "fix: multi (closes #12)" --body-file ${stripSubstitution(multiFile)}`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	// ---- pr-merge-needs-closing-keywords ----

	it("allows pr merge with keyword in BOTH --subject and --body", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr merge --squash --subject "feat: x (closes #12)" --body "Closes #12"`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("blocks pr merge without --subject (commit-subject channel required)", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr merge --squash --body "Closes #12"`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-merge-needs-closing-keywords");
	});

	it("allows pr merge with --subject only (commit subject closes; body optional)", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr merge --squash --subject "feat: x (closes #12)"`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("blocks pr merge with a bare mention only", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr merge --squash --subject "feat: x (see #12)" --body "see #12"`,
			host,
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "pr-merge-needs-closing-keywords");
	});

	it("does not gate other gh subcommands (view / branch / close)", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			`gh pr view 12 --json body,title`,
			host,
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
		const { block: blockClose } = await evaluateBash(
			makeFixtureDir(),
			`gh issue close 12`,
			host,
		);
		assert.equal(blockClose, false, `expected allow, got block by ${rule}`);
	});
});

describe("global config — gh-repo-create-needs-seed (repo create must seed)", () => {
	it("blocks bare gh repo create with the rule name in the reason tag", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			"gh repo create cad0p/pi-config",
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "gh-repo-create-needs-seed");
	});

	it("blocks gh repo create with only non-seed flags (--source . --push)", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			"gh repo create cad0p/pi-config --source . --push",
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "gh-repo-create-needs-seed");
	});

	it("blocks the gh repo new alias (new = create)", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			"gh repo new cad0p/pi-config",
		);
		assert.equal(block, true, "expected block");
		assert.equal(rule, "gh-repo-create-needs-seed");
	});

	it("allows gh repo create with --add-readme", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			"gh repo create cad0p/pi-config --add-readme",
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});

	it("allows gh repo create with --license mit", async () => {
		const { block, rule } = await evaluateBash(
			makeFixtureDir(),
			"gh repo create cad0p/pi-config --license mit",
		);
		assert.equal(block, false, `expected allow, got block by ${rule}`);
	});
});

describe("global config — real-path guard (this machine)", () => {
	it("end-to-end: git commit on main at the real Goldmine path is allowed", async () => {
		// The full evaluator against the REAL Goldmine vault on this
		// machine. With the plugin's dynamic detection this is also a
		// coverage-matrix check: Goldmine carries a `.napkin/` dir in
		// the repo, so the walk-up must resolve it.
		const { block, rule } = await evaluateBash(REAL_GOLDMINE, "git commit -m 'note'");
		assert.equal(block, false, `expected allow at real path ${REAL_GOLDMINE}, got block by ${rule}`);
	});
});
