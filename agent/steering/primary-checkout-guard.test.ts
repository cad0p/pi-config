// SPDX-License-Identifier: MIT
// Global pi-steering config — primary-checkout guard tests.
//
// Owner rule: the primary checkout of every pc-* repo (a directory
// /home/pier/personal/github/pc-<name> whose .git is a DIRECTORY) stays
// on main and is never edited; work happens in a worktree. The guard
// must refuse the mutating verbs and the edit/write surface there,
// whether the primary is reached by cwd (`cd … &&`), by `git -C`, or
// from inside a `bash -c` wrapper — and must NOT touch worktrees
// (pc-website-demo, /data/tmp/wt/*), whose .git is a FILE.
//
// The config is loaded through pi-steering's real loader (jiti), like
// integration.test.ts and merge-guard.test.ts. exec is stubbed: the
// fast-forward allow probes `git rev-parse --abbrev-ref HEAD`, and the
// shipped git-plugin rails probe the branch too — no test touches a repo.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadSteeringConfig } from "@cad0p/pi-steering";
import {
	createRecordingHost,
	expectAllows,
	expectBlocks,
	loadHarness,
	mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	isFfOnlyOriginMain,
	isFfOnlyPull,
	isMainSwitch,
	isPrimaryCheckout,
	mutationKind,
	parseGitCall,
	primaryOfPath,
} from "./primary-checkout-guard.ts";

const RULE_GIT = "no-primary-checkout-git";
const RULE_WRITE = "no-primary-checkout-write";
const RULE_EDIT = "no-primary-checkout-edit";
const MESSAGE = /the primary checkout stays on main: edit in a worktree/;

const ROOT = "/home/pier/personal/github";
const PRIMARY = `${ROOT}/pc-host`;
/** A linked worktree of pc-website: .git is a FILE, so it is not a primary. */
const WORKTREE = `${ROOT}/pc-website-demo`;
/** Scratch worktree outside the workspace root. */
const SCRATCH_WT = "/data/tmp/wt/pc-host-123";
/** A cwd that is not a repo at all. */
const OTHER = "/tmp/steering-primary-guard";

let config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"];

before(async () => {
	const { config: merged, diagnostics } = await loadSteeringConfig(
		process.cwd(),
	);
	const errors = diagnostics.filter((d) => d.type === "error");
	assert.deepEqual(
		errors.map((d) => d.message),
		[],
		"the global config must load without error diagnostics",
	);
	config = merged;
});

const ok = (stdout: string): ExecResult => ({
	stdout,
	stderr: "",
	code: 0,
	killed: false,
});
const fail: ExecResult = { stdout: "", stderr: "", code: 1, killed: false };

/**
 * Recording host whose exec stub answers the one probe the guard makes
 * (`git -C <repo> rev-parse --abbrev-ref HEAD`). `branch` is the answer
 * for every repo; null makes the probe fail (fail-closed input).
 */
function host(branch: string | null = "main") {
	return createRecordingHost({
		exec: (cmd, args) => {
			if (
				cmd === "git" &&
				args[0] === "-C" &&
				args[2] === "rev-parse" &&
				args[3] === "--abbrev-ref" &&
				args[4] === "HEAD"
			) {
				return Promise.resolve(branch === null ? fail : ok(branch));
			}
			return Promise.resolve(fail);
		},
	});
}

/** The rule name that fired, or null. */
async function firedRule(
	event: Parameters<typeof expectBlocks>[1],
	branch: string | null = "main",
): Promise<string | null> {
	const h = host(branch);
	const harness = loadHarness({ config, host: h });
	const ctx = mockExtensionContext(OTHER, h.entries);
	const result = await harness.evaluate(
		event as unknown as Parameters<typeof harness.evaluate>[0],
		ctx,
		1,
	);
	if (result === undefined || result === null || result.block !== true) {
		return null;
	}
	const raw = result.reason ?? "";
	const reason = typeof raw === "string" ? raw : String(raw);
	const match = reason.match(/(?:^|\n)\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
	return match?.[1] ?? null;
}

async function blocked(
	command: string,
	rule = RULE_GIT,
	branch: string | null = "main",
): Promise<void> {
	await expectBlocks(
		loadHarness({ config, host: host(branch) }),
		{ command, cwd: OTHER },
		{ rule, reason: MESSAGE },
	);
}

/** Assert the primary guard released (another rail may still fire). */
async function allowed(
	command: string,
	branch: string | null = "main",
): Promise<void> {
	const fired = await firedRule({ command, cwd: OTHER }, branch);
	assert.ok(
		fired === null || !fired.startsWith("no-primary-checkout"),
		`the primary guard must not fire on: ${command} (fired ${fired})`,
	);
}

describe("primary-checkout guard — the matcher", () => {
	it("recognises a primary by its .git DIRECTORY", () => {
		assert.equal(isPrimaryCheckout(PRIMARY), true);
		assert.equal(isPrimaryCheckout(WORKTREE), false);
		assert.equal(isPrimaryCheckout(OTHER), false);
	});

	it("resolves the primary a path lives in", () => {
		assert.equal(primaryOfPath(`${PRIMARY}/src/main.go`), PRIMARY);
		assert.equal(primaryOfPath(PRIMARY), PRIMARY);
		assert.equal(primaryOfPath(WORKTREE + "/src/x.ts"), null);
		assert.equal(primaryOfPath(SCRATCH_WT + "/src/x.ts"), null);
		assert.equal(primaryOfPath("/home/pier/personal/github/not-a-repo"), null);
	});

	it("applies -C cumulatively, as git does", () => {
		const call = parseGitCall(
			["-C", PRIMARY, "-C", "tools", "commit", "-m", "x"],
			OTHER,
		);
		assert.equal(call?.repo, `${PRIMARY}/tools`);
		assert.equal(call?.subcommand, "commit");
	});

	it("keeps an unresolvable base unresolvable", () => {
		assert.equal(parseGitCall(["commit", "-m", "x"], null)?.repo, null);
		assert.equal(
			parseGitCall(["-C", "relative", "commit"], null)?.repo,
			null,
		);
		assert.equal(
			parseGitCall(["-C", PRIMARY, "commit"], null)?.repo,
			PRIMARY,
		);
	});

	it("classifies the switch forms", () => {
		assert.equal(isMainSwitch(["main"]), true);
		assert.equal(isMainSwitch(["-q", "main"]), true);
		assert.equal(isMainSwitch(["feature/x"]), false);
		assert.equal(isMainSwitch(["-b", "feature/x"]), false);
		assert.equal(isMainSwitch(["-bmain"]), false);
		assert.equal(isMainSwitch(["--detach", "main"]), false);
		assert.equal(isMainSwitch(["--", "README.md"]), false);
		assert.equal(isMainSwitch(["-"]), false);
	});

	it("classifies the fast-forward forms", () => {
		assert.equal(isFfOnlyOriginMain(["--ff-only", "origin/main"]), true);
		assert.equal(isFfOnlyOriginMain(["origin/main"]), false);
		assert.equal(isFfOnlyOriginMain(["--ff-only", "feature/x"]), false);
		assert.equal(isFfOnlyPull(["--ff-only"]), true);
		assert.equal(isFfOnlyPull(["--ff-only", "origin"]), true);
		assert.equal(isFfOnlyPull(["--ff-only", "origin", "main"]), true);
		assert.equal(isFfOnlyPull(["--ff-only", "origin", "feature"]), false);
		assert.equal(isFfOnlyPull([]), false);
	});

	it("classifies the mutating verbs", () => {
		for (const verb of [
			"commit",
			"rebase",
			"reset",
			"cherry-pick",
			"revert",
			"am",
			"stash",
		]) {
			assert.equal(mutationKind(verb, []), "mutation", verb);
		}
		assert.equal(mutationKind("merge", ["origin/main"]), "mutation");
		assert.equal(mutationKind("merge", ["--ff-only", "origin/main"]), "ff-only");
		assert.equal(mutationKind("pull", []), "mutation");
		assert.equal(mutationKind("pull", ["--ff-only"]), "ff-only");
		for (const read of ["fetch", "status", "log", "show", "diff", "worktree"]) {
			assert.equal(mutationKind(read, []), null, read);
		}
	});
});

describe("primary-checkout guard — reached by cwd", () => {
	for (const command of [
		`cd ${PRIMARY} && git checkout -b feature/x`,
		`cd ${PRIMARY} && git switch -c feature/x`,
		`cd ${PRIMARY} && git checkout feature/x`,
		`cd ${PRIMARY} && git switch --detach origin/main`,
		`cd ${PRIMARY} && git commit -m "x"`,
		`cd ${PRIMARY} && git commit --amend --no-edit`,
		`cd ${PRIMARY} && git merge feature/x`,
		`cd ${PRIMARY} && git rebase origin/main`,
		`cd ${PRIMARY} && git reset --hard origin/main`,
		`cd ${PRIMARY} && git cherry-pick abc123`,
		`cd ${PRIMARY} && git revert abc123`,
		`cd ${PRIMARY} && git am < p.patch`,
		`cd ${PRIMARY} && git stash`,
		`cd ${PRIMARY} && git pull`,
		`cd ${PRIMARY}/tools && git commit -m "x"`,
	]) {
		it(`blocks: ${command}`, async () => {
			await blocked(command);
		});
	}

	it("blocks the pc-website incident shape (branch + commit on the primary)", async () => {
		await blocked(
			`cd ${ROOT}/pc-website && git checkout -b docs/privacy-category-level-review`,
		);
		await blocked(`cd ${ROOT}/pc-website && git commit -m "docs: privacy"`);
	});
});

describe("primary-checkout guard — reached by git -C", () => {
	for (const command of [
		`git -C ${PRIMARY} commit -m "x"`,
		`git -C ${PRIMARY} checkout -b feature/x`,
		`git -C ${PRIMARY} switch -c feature/x`,
		`git -C ${ROOT}/pc-website checkout -b docs/x`,
		`git -C ${ROOT}/pc-control switch feature/x`,
		`git -C ${ROOT}/pc-control-mail commit -am "x"`,
		`git -C ${ROOT}/pc-admin merge origin/main`,
		`git -C ${ROOT}/pc-tenant pull`,
		`git -C ${ROOT}/pc-renovate stash pop`,
		`git -C ${PRIMARY} -c user.name=x commit -m "x"`,
		`git --no-pager -C ${PRIMARY} commit -m "x"`,
		`git -C${PRIMARY} commit -m "x"`,
	]) {
		it(`blocks: ${command}`, async () => {
			await blocked(command);
		});
	}
});

describe("primary-checkout guard — codemode / nested bash shape", () => {
	// codemode's `await tools.bash({ command })` reaches steering as a plain
	// bash tool call, and an agent that wraps the same command in `bash -c`
	// must not slip past the guard: the walker descends into the wrapper.
	for (const command of [
		`bash -c 'cd ${PRIMARY} && git commit -m "x"'`,
		`bash -lc 'cd ${PRIMARY} && git checkout -b feature/x'`,
		`sh -c 'git -C ${PRIMARY} commit -m "x"'`,
		`bash -c "git -C ${ROOT}/pc-website switch -c docs/x"`,
		`bash -c 'cd ${PRIMARY} && git stash'`,
	]) {
		it(`blocks: ${command}`, async () => {
			await blocked(command);
		});
	}
});

describe("primary-checkout guard — worktrees are not primaries", () => {
	for (const command of [
		`cd ${WORKTREE} && git commit -m "x"`,
		`cd ${WORKTREE} && git checkout -b feature/x`,
		`git -C ${WORKTREE} commit -m "x"`,
		`git -C ${WORKTREE} switch -c feature/x`,
		`cd ${SCRATCH_WT} && git commit -m "x"`,
		`git -C ${SCRATCH_WT} rebase origin/main`,
		`cd ${OTHER} && git commit -m "x"`,
		// the wrapper payload scan must not over-reach either
		`bash -c 'cd ${WORKTREE} && git commit -m "x"'`,
		`bash -c 'cd ${SCRATCH_WT} && git checkout -b feature/x'`,
		`bash -c 'cd ${PRIMARY} && git status --short'`,
	]) {
		it(`allows: ${command}`, async () => {
			await allowed(command);
		});
	}
});

describe("primary-checkout guard — the allowed read + sync surface", () => {
	for (const command of [
		`cd ${PRIMARY} && git fetch origin`,
		`cd ${PRIMARY} && git status --short`,
		`cd ${PRIMARY} && git log --oneline -5`,
		`cd ${PRIMARY} && git show HEAD`,
		`cd ${PRIMARY} && git diff origin/main`,
		`cd ${PRIMARY} && git branch --show-current`,
		`cd ${PRIMARY} && git switch main`,
		`cd ${PRIMARY} && git checkout main`,
		`cd ${PRIMARY} && git worktree add /data/tmp/wt/pc-host-x -b x`,
		`cd ${PRIMARY} && git worktree list`,
		`cd ${PRIMARY} && git worktree prune`,
		`git -C ${PRIMARY} fetch --prune origin`,
		`git -C ${PRIMARY} worktree add /data/tmp/wt/pc-host-y -b y`,
	]) {
		it(`allows: ${command}`, async () => {
			await expectAllows(loadHarness({ config, host: host() }), {
				command,
				cwd: OTHER,
			});
		});
	}

	it("allows merge --ff-only origin/main while the primary is on main", async () => {
		await expectAllows(loadHarness({ config, host: host("main") }), {
			command: `git -C ${PRIMARY} merge --ff-only origin/main`,
			cwd: OTHER,
		});
	});

	it("allows pull --ff-only while the primary is on main", async () => {
		await expectAllows(loadHarness({ config, host: host("main") }), {
			command: `git -C ${PRIMARY} pull --ff-only origin main`,
			cwd: OTHER,
		});
	});

	it("allows the ff-only sync after an in-chain switch to main", async () => {
		await expectAllows(loadHarness({ config, host: host("feature/x") }), {
			command: `cd ${PRIMARY} && git switch main && git merge --ff-only origin/main`,
			cwd: OTHER,
		});
	});

	it("blocks the ff-only sync while the primary sits on another branch", async () => {
		await blocked(
			`git -C ${ROOT}/pc-website merge --ff-only origin/main`,
			RULE_GIT,
			"docs/privacy-category-level-review",
		);
	});

	it("blocks the ff-only sync when the branch cannot be resolved", async () => {
		await blocked(
			`git -C ${PRIMARY} merge --ff-only origin/main`,
			RULE_GIT,
			null,
		);
	});

	it("blocks a mutating verb when the cwd cannot be resolved (fail closed)", async () => {
		await blocked(`cd "$(mktemp -d)" && git commit -m "x"`);
	});

	it("blocks a mutating verb with no repo at all (fail closed)", async () => {
		await blocked(`cd "$SOME_UNSET_DIR" && git checkout -b feature/x`);
	});
});

describe("primary-checkout guard — edit / write surface", () => {
	it("blocks a write inside a primary", async () => {
		await expectBlocks(
			loadHarness({ config, host: host() }),
			{ write: { path: `${PRIMARY}/README.md`, content: "x" }, cwd: OTHER },
			{ rule: RULE_WRITE, reason: MESSAGE },
		);
	});

	it("blocks an edit inside a primary", async () => {
		await expectBlocks(
			loadHarness({ config, host: host() }),
			{
				edit: {
					path: `${ROOT}/pc-website/src/pages/index.astro`,
					edits: [{ oldText: "a", newText: "b" }],
				},
				cwd: OTHER,
			},
			{ rule: RULE_EDIT, reason: MESSAGE },
		);
	});

	it("blocks the pc-website incident shape (a note written into the primary)", async () => {
		await expectBlocks(
			loadHarness({ config, host: host() }),
			{
				write: {
					path: `${ROOT}/pc-website/docs/privacy.md`,
					content: "x",
				},
				cwd: OTHER,
			},
			{ rule: RULE_WRITE, reason: MESSAGE },
		);
	});

	it("blocks a relative path resolved against a primary session cwd", async () => {
		await expectBlocks(
			loadHarness({ config, host: host() }),
			{ write: { path: "docs/x.md", content: "x" }, cwd: PRIMARY },
			{ rule: RULE_WRITE, reason: MESSAGE },
		);
	});

	it("allows the primary's .local/ scratch directory", async () => {
		await expectAllows(loadHarness({ config, host: host() }), {
			write: { path: `${PRIMARY}/.local/notes.md`, content: "x" },
			cwd: OTHER,
		});
		await expectAllows(loadHarness({ config, host: host() }), {
			edit: {
				path: `${PRIMARY}/.local/scratch.txt`,
				edits: [{ oldText: "a", newText: "b" }],
			},
			cwd: OTHER,
		});
	});

	it("allows a write in a worktree", async () => {
		await expectAllows(loadHarness({ config, host: host() }), {
			write: { path: `${WORKTREE}/src/x.ts`, content: "x" },
			cwd: OTHER,
		});
		await expectAllows(loadHarness({ config, host: host() }), {
			write: { path: `${SCRATCH_WT}/src/x.ts`, content: "x" },
			cwd: OTHER,
		});
	});

	it("allows a write outside the workspace root", async () => {
		await expectAllows(loadHarness({ config, host: host() }), {
			write: { path: `${OTHER}/pc-host/x.ts`, content: "x" },
			cwd: OTHER,
		});
	});
});
