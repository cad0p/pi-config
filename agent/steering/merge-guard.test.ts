// SPDX-License-Identifier: MIT
// Global pi-steering config — merge guard tests.
//
// Design: Goldmine personal/github/pc-host/plans/2026-11-02-self-hosted-ci-replaces-s2-fallback.md
// §3.6 / P1-W1 step 1 ("agents do not merge directly"). The rule must refuse
// every direct merge route and a push to a renovate branch, and must NOT
// refuse the helper (tools/merge-pr.sh), gh reads, non-renovate pushes, or
// text that merely contains the words.
//
// The config is loaded through pi-steering's real loader (jiti), like
// integration.test.ts: node's native type stripping refuses .ts files under
// node_modules, and the config imports raw-.ts subpaths.
//
// exec is stubbed per test: the git branch / upstream predicates shell out.

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

const RULE = "agents-do-not-merge-directly";
const MESSAGE = /merge through tools\/merge-pr\.sh/;

/** exec is stubbed, so the cwd never has to exist. */
const CWD = "/tmp/steering-merge-guard";

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

interface GitState {
	/** `git branch --show-current` (unset → non-zero, no branch). */
	branch?: string;
	/** `git rev-parse --abbrev-ref @{upstream}` (unset → no upstream). */
	upstream?: string;
}

function host(state: GitState = {}) {
	return createRecordingHost({
		exec: (cmd, args) => {
			const reply = (stdout: string): ExecResult => ({
				stdout,
				stderr: "",
				code: stdout === "" ? 1 : 0,
				killed: false,
			});
			if (
				cmd === "git" &&
				args[0] === "branch" &&
				args[1] === "--show-current"
			) {
				return Promise.resolve(reply(state.branch ?? ""));
			}
			if (
				cmd === "git" &&
				args[0] === "rev-parse" &&
				args[1] === "--abbrev-ref" &&
				args[2] === "@{upstream}"
			) {
				return Promise.resolve(reply(state.upstream ?? ""));
			}
			return Promise.resolve(reply(""));
		},
	});
}

async function blocked(command: string, state: GitState = {}): Promise<void> {
	await expectBlocks(
		loadHarness({ config, host: host(state) }),
		{ command, cwd: CWD },
		{ rule: RULE, reason: MESSAGE },
	);
}

async function allowed(command: string, state: GitState = {}): Promise<void> {
	await expectAllows(loadHarness({ config, host: host(state) }), {
		command,
		cwd: CWD,
	});
}

/** The rule name that fired, or null. Used where another rule may also fire. */
async function firedRule(
	command: string,
	state: GitState = {},
): Promise<string | null> {
	const h = host(state);
	const harness = loadHarness({ config, host: h });
	const event = {
		type: "tool_call",
		toolCallId: "tc1",
		toolName: "bash",
		input: { command },
	} as unknown as Parameters<typeof harness.evaluate>[0];
	const result = await harness.evaluate(
		event,
		mockExtensionContext(CWD, h.entries),
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

describe("merge guard — gh pr merge (any form)", () => {
	it("blocks a plain squash merge", async () => {
		await blocked("gh pr merge 999999 --squash");
	});

	it("blocks the --admin form", async () => {
		await blocked("gh pr merge 999999 --admin --squash");
	});

	it("blocks with -R/--repo before the subcommand", async () => {
		await blocked("gh -R cad0p/pc-host pr merge 999999 --squash");
	});

	it("blocks with --repo=… after the subcommand", async () => {
		await blocked("gh pr merge --repo=cad0p/pc-host 999999 --squash");
	});

	it("blocks with --repo after the PR number", async () => {
		await blocked("gh pr merge 999999 --squash -R cad0p/pc-host");
	});

	it("blocks with a shell env prefix", async () => {
		await blocked("GITHUB_TOKEN=x gh pr merge 999999 --squash");
	});

	it("blocks inside sh -c", async () => {
		await blocked("sh -c 'gh pr merge 999999 --squash'");
	});

	it("blocks inside bash -c", async () => {
		await blocked("bash -c 'gh pr merge 999999 --admin'");
	});

	it("blocks the --auto (arming) form", async () => {
		await blocked("gh pr merge 999999 --auto --squash");
	});

	it("allows gh pr merge --help (introspection, not a merge)", async () => {
		await allowed("gh pr merge --help");
	});
});

describe("merge guard — gh pr merge <n> --disable-auto (disarm) allowed", () => {
	it("allows the plain disarm form", async () => {
		await allowed("gh pr merge 999999 --disable-auto");
	});
	it("allows flag before the number", async () => {
		await allowed("gh pr merge --disable-auto 999999");
	});
	it("allows -R before and after", async () => {
		await allowed("gh -R cad0p/pc-host pr merge 999999 --disable-auto");
		await allowed("gh pr merge 999999 --disable-auto -R cad0p/pc-host");
		await allowed("gh pr merge 999999 -R cad0p/pc-host --disable-auto");
	});
	it("allows --repo and --repo=", async () => {
		await allowed("gh pr merge 999999 --disable-auto --repo cad0p/pc-host");
		await allowed("gh pr merge --repo=cad0p/pc-host 999999 --disable-auto");
	});
	it("allows an env prefix", async () => {
		await allowed("GITHUB_TOKEN=x gh pr merge 999999 --disable-auto");
	});
	it("allows sh -c / bash -c wrappers", async () => {
		await allowed("sh -c 'gh pr merge 999999 --disable-auto'");
		await allowed("bash -c 'gh -R cad0p/pc-host pr merge 999999 --disable-auto'");
	});
	for (const flag of [
		"--admin", "--squash", "--merge", "--rebase", "--auto",
		"--match-head-commit abc123", "-d", "--delete-branch", "--body x",
		"-t x", "-b x", "-s", "-m", "-r",
	]) {
		it(`blocks --disable-auto combined with ${flag}`, async () => {
			await blocked(`gh pr merge 999999 --disable-auto ${flag}`);
			await blocked(`gh pr merge 999999 ${flag} --disable-auto -R cad0p/pc-host`);
		});
	}
	it("blocks --auto alone", async () => {
		await blocked("gh pr merge 999999 --auto");
	});
	it("blocks a wrapped combined form", async () => {
		await blocked("sh -c 'gh pr merge 999999 --disable-auto --admin'");
	});
	it("blocks --disable-auto without a number or with a non-numeric selector", async () => {
		await blocked("gh pr merge --disable-auto");
		await blocked("gh pr merge some-branch --disable-auto");
	});
	it("allows the disablePullRequestAutoMerge mutation", async () => {
		await allowed(
			`gh api graphql -f 'query=mutation { disablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
		);
	});
});

describe("merge guard — REST merge endpoint", () => {
	it("blocks gh api -X PUT …/pulls/<n>/merge", async () => {
		await blocked(
			"gh api -X PUT repos/cad0p/pc-host/pulls/999999/merge",
		);
	});

	it("blocks with the method after the URL", async () => {
		await blocked(
			"gh api repos/cad0p/pc-host/pulls/999999/merge -X PUT",
		);
	});

	it("blocks the --method spelling with a body", async () => {
		await blocked(
			"gh api --method PUT /repos/cad0p/pc-host/pulls/999999/merge -f merge_method=squash",
		);
	});

	it("allows a GET of the PR itself", async () => {
		await allowed("gh api repos/cad0p/pc-host/pulls/999999");
	});
});

describe("merge guard — GraphQL merge mutations", () => {
	it("blocks mergePullRequest", async () => {
		await blocked(
			`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
		);
	});

	it("blocks enablePullRequestAutoMerge", async () => {
		await blocked(
			`gh api graphql -f 'query=mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
		);
	});

	it("blocks mergeBranch", async () => {
		await blocked(
			`gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: "x"}) { clientMutationId } }'`,
		);
	});
});

describe("merge guard — push to renovate/**", () => {
	it("blocks an explicit destination refspec", async () => {
		await blocked("git push origin HEAD:renovate/x");
	});

	it("blocks a same-name refspec", async () => {
		await blocked("git push origin renovate/x");
	});

	it("blocks the refs/heads spelling", async () => {
		await blocked("git push origin HEAD:refs/heads/renovate/x");
	});

	it("blocks a deletion of a renovate branch", async () => {
		await blocked("git push origin :renovate/x");
	});

	it("blocks a rename onto renovate/", async () => {
		await blocked("git push origin main:renovate/x");
	});

	it("blocks --delete with the branch name", async () => {
		await blocked("git push --delete origin renovate/x");
	});

	it("blocks a bare push after an in-chain git checkout of a renovate branch", async () => {
		await blocked("git checkout renovate/x && git push");
	});

	it("blocks a bare push when the current branch is renovate/x (gh pr checkout case)", async () => {
		// Two separate tool calls in a pi session: the checkout has run, so
		// the branch predicate shells out and sees renovate/x.
		await blocked("git push", { branch: "renovate/x" });
	});

	it("blocks -u origin HEAD from a renovate branch", async () => {
		await blocked("git push -u origin HEAD", { branch: "renovate/x" });
	});

	it("blocks a bare push whose upstream is origin/renovate/x", async () => {
		await blocked("git push", {
			branch: "my-fix",
			upstream: "origin/renovate/x",
		});
	});

	it("allows an explicit non-renovate destination from a renovate branch (writes no renovate ref)", async () => {
		await allowed("git push origin HEAD:my-fix", { branch: "renovate/x" });
	});
});

describe("merge guard — gh api writes to git/refs/heads/renovate/**", () => {
	it("blocks PATCH of a renovate ref", async () => {
		await blocked(
			"gh api -X PATCH repos/cad0p/pc-host/git/refs/heads/renovate/x -f sha=abc123",
		);
	});

	it("blocks DELETE of a renovate ref", async () => {
		await blocked(
			"gh api -X DELETE repos/cad0p/pc-host/git/refs/heads/renovate/x",
		);
	});

	it("blocks the leading-slash spelling with a force flag", async () => {
		await blocked(
			"gh api --method PATCH /repos/cad0p/pc-host/git/refs/heads/renovate/renovate-x -f force=true",
		);
	});
});

describe("merge guard — the helper and the reads stay allowed", () => {
	it("allows tools/merge-pr.sh as a command", async () => {
		await allowed(
			"tools/merge-pr.sh --mode local cad0p/pc-host 523 0123456789abcdef0123456789abcdef01234567",
		);
	});

	it("allows bash tools/merge-pr.sh", async () => {
		await allowed(
			"bash tools/merge-pr.sh gate cad0p/pc-host 523 0123456789abcdef0123456789abcdef01234567",
		);
	});

	it("allows gh pr view / checks / list / diff", async () => {
		await allowed("gh pr view 999999 --json body -R cad0p/pc-host");
		await allowed("gh pr checks 999999");
		await allowed("gh pr list -R cad0p/pc-host");
		await allowed("gh pr diff 999999");
	});

	it("does not fire on gh pr create (other github rules may still apply)", async () => {
		assert.notEqual(
			await firedRule(
				`gh pr create --title "feat: x (closes #12)" --body "Closes #12"`,
			),
			RULE,
		);
	});

	it("allows gh api GETs of pulls/<n> and rulesets", async () => {
		await allowed("gh api -X GET repos/cad0p/pc-host/pulls/999999");
		await allowed("gh api repos/cad0p/pc-host/rulesets");
		await allowed("gh api repos/cad0p/pc-host/rulesets/123");
	});

	it("allows a push of a non-renovate branch", async () => {
		await allowed("git push origin my-fix", {
			branch: "my-fix",
			upstream: "origin/my-fix",
		});
		await allowed("git push", {
			branch: "my-fix",
			upstream: "origin/my-fix",
		});
		await allowed("git push origin main", {
			branch: "main",
			upstream: "origin/main",
		});
	});

	it("allows text that merely contains the words", async () => {
		await allowed('grep -rn "gh pr merge" docs/');
		await allowed('rg "pulls/999999/merge" .');
		await allowed('cat tools/merge-pr.sh | grep "gh pr merge"');
		await allowed('git log --grep "gh pr merge"');
	});

	it("is generic: the same call is blocked from any cwd", async () => {
		await blocked("gh pr merge 999999 --squash");
		// CWD is a synthetic path outside every repo; the rule has no cwd gate.
		await expectBlocks(
			loadHarness({ config, host: host() }),
			{ command: "gh pr merge 999999 --squash", cwd: "/home/pier/personal/github/pc-control" },
			{ rule: RULE },
		);
	});
});
