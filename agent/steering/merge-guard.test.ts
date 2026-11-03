// SPDX-License-Identifier: MIT
// Global pi-steering config — merge guard tests.
//
// Design: Goldmine personal/github/pc-host/plans/2026-11-02-self-hosted-ci-replaces-s2-fallback.md
// §3.6 / P1-W1 step 1 ("agents do not merge directly"). The rule must refuse
// every direct merge route and a push to a renovate branch IN A PRIVATE REPO,
// and must NOT refuse the helper (tools/merge-pr.sh), gh reads, non-renovate
// pushes, or text that merely contains the words — while RELEASING in a public
// repo (owner ruling 2026-11-03: "just gate it to private repos instead,
// simpler") and failing CLOSED when the target repo can't be resolved.
//
// The config is loaded through pi-steering's real loader (jiti), like
// integration.test.ts: node's native type stripping refuses .ts files under
// node_modules, and the config imports raw-.ts subpaths.
//
// exec is stubbed per test: the git branch / upstream predicates shell out, and
// so do the visibility probes (`gh repo view …`, `gh api repos/… --jq .private`,
// `git config --get remote.<name>.url`) — no test touches the network.
//
// The rule caches successful lookups in-process for a few minutes, so a repo
// name must NEVER flip visibility between tests: every public case uses
// PUBLIC_REPO, every private case PRIVATE_REPO (or a fresh fixture name).

// Hermetic global layer: load THIS checkout's agent dir, not the
// machine's live ~/.pi/agent/steering (functional F5).
import "./__test-agent-dir.ts";
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

/** The public repo from the 2026-11-03 incident. Never marked private here. */
const PUBLIC_REPO = "cad0p/pi-usage";
/** The private, governed repo (merge-pr.sh lives beside it). Never public here. */
const PRIVATE_REPO = "cad0p/pc-host";
/** A repo whose visibility lookup fails (not logged in / offline). */
const UNKNOWN_REPO = "cad0p/gh-lookup-down";

interface GitState {
	/** `git branch --show-current` (unset → non-zero, no branch). */
	branch?: string;
	/** `git rev-parse --abbrev-ref @{upstream}` (unset → no upstream). */
	upstream?: string;
	/** Repos that resolve PUBLIC. Every other repo resolves PRIVATE. */
	publicRepos?: string[];
	/** The repo `gh repo view` resolves at the cwd (default: PRIVATE_REPO). */
	cwdRepo?: string;
	/** Every visibility lookup fails (non-zero exit, like gh not logged in). */
	lookupFails?: boolean;
	/** `remote.<name>.url` answers (default: origin → the cwd repo on github.com). */
	remotes?: Record<string, string>;
	/** `branch.<name>.remote` answer for a bare `git push` (default: origin). */
	branchRemote?: string;
}

/**
 * Recording host whose exec stub answers the git queries the shipped
 * predicates make AND the merge guard's visibility probes:
 *   - `gh repo view --json nameWithOwner,isPrivate` at the cwd → `cwdRepo`;
 *   - `gh api repos/<o>/<r> --jq .private` → publicRepos membership;
 *   - `git config --get remote.<name>.url` → the `remotes` map.
 * Everything unlisted exits non-zero, which is exactly the guard's
 * fail-closed input.
 */
function host(state: GitState = {}) {
	const publicRepos = new Set(
		(state.publicRepos ?? []).map((r) => r.toLowerCase()),
	);
	const cwdRepo = state.cwdRepo ?? PRIVATE_REPO;
	const remotes = state.remotes ?? {
		origin: `https://github.com/${cwdRepo}.git`,
	};
	const ok = (stdout: string): ExecResult => ({
		stdout,
		stderr: "",
		code: 0,
		killed: false,
	});
	const fail: ExecResult = { stdout: "", stderr: "", code: 1, killed: false };
	const isPublic = (full: string) => publicRepos.has(full.toLowerCase());
	return createRecordingHost({
		exec: (cmd, args) => {
			if (
				cmd === "git" &&
				args[0] === "branch" &&
				args[1] === "--show-current"
			) {
				return Promise.resolve(
					state.branch === undefined ? fail : ok(state.branch),
				);
			}
			if (
				cmd === "git" &&
				args[0] === "rev-parse" &&
				args[1] === "--abbrev-ref" &&
				args[2] === "@{upstream}"
			) {
				return Promise.resolve(
					state.upstream === undefined ? fail : ok(state.upstream),
				);
			}
			if (cmd === "git" && args[0] === "config" && args[1] === "--get") {
				const key = args[2] ?? "";
				const remote = /^remote\.(.+)\.url$/.exec(key);
				if (remote !== null) {
					const url = remotes[remote[1] ?? ""];
					return Promise.resolve(url === undefined ? fail : ok(url));
				}
				if (/^branch\..+\.remote$/.test(key)) {
					return Promise.resolve(ok(state.branchRemote ?? "origin"));
				}
				return Promise.resolve(fail);
			}
			if (cmd === "gh" && state.lookupFails !== true) {
				// The named-repo probe: `gh api repos/<o>/<r> --jq .private`.
				const endpoint = /^repos\/([^/]+\/[^/]+)$/.exec(args[1] ?? "");
				if (args[0] === "api" && endpoint !== null) {
					return Promise.resolve(
						ok(isPublic(endpoint[1] ?? "") ? "false" : "true"),
					);
				}
				// The cwd probe: `gh repo view --json nameWithOwner,isPrivate`.
				if (args[0] === "repo" && args[1] === "view") {
					return Promise.resolve(
						ok(
							JSON.stringify({
								nameWithOwner: cwdRepo,
								isPrivate: !isPublic(cwdRepo),
							}),
						),
					);
				}
			}
			return Promise.resolve(fail);
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

/**
 * The rule name that fired, or null. Used where another rule may also fire.
 * Pass `h` to inspect the exec calls the evaluation made.
 */
async function firedRule(
	command: string,
	state: GitState = {},
	h = host(state),
): Promise<string | null> {
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

/** Assert the merge guard RELEASED (another rule may still fire). */
async function notMergeGuard(
	command: string,
	state: GitState = {},
): Promise<void> {
	assert.notEqual(
		await firedRule(command, state),
		RULE,
		`the merge guard must not fire on: ${command}`,
	);
}

/** The `gh` exec calls one evaluation made, joined for assertions. */
async function ghCalls(
	command: string,
	state: GitState,
): Promise<string[]> {
	const h = host(state);
	await firedRule(command, state, h);
	return h.execCalls
		.filter((c) => c.cmd === "gh")
		.map((c) => c.args.join(" "));
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

	it("is generic within private repos: the same call is blocked from any cwd", async () => {
		await blocked("gh pr merge 999999 --squash");
		// CWD is a synthetic path outside every repo; the rule has no cwd gate
		// (the repo is resolved through the stubbed gh probes, both private).
		await expectBlocks(
			loadHarness({ config, host: host() }),
			{ command: "gh pr merge 999999 --squash", cwd: "/home/pier/personal/github/pc-control" },
			{ rule: RULE },
		);
	});
});

describe("merge guard — visibility gate: gh pr merge", () => {
	it("allows a public repo targeted with -R (the 2026-11-03 incident)", async () => {
		// Unrelated github rules may still fire (foreign -R redirect, closing
		// keyword): what matters here is that the MERGE GUARD released.
		await notMergeGuard("gh pr merge 999999 --squash -R cad0p/pi-usage", {
			publicRepos: [PUBLIC_REPO],
		});
	});

	it("allows the public -R merge end-to-end from inside that repo", async () => {
		await allowed(
			`gh pr merge 999999 --squash --subject "feat: x (closes #12)" -R cad0p/pi-usage`,
			{ publicRepos: [PUBLIC_REPO], cwdRepo: PUBLIC_REPO },
		);
	});

	it("allows every -R spelling of a public repo", async () => {
		const state: GitState = { publicRepos: [PUBLIC_REPO] };
		await notMergeGuard(
			"gh -R cad0p/pi-usage pr merge 999999 --squash",
			state,
		);
		await notMergeGuard(
			"gh pr merge --repo=cad0p/pi-usage 999999 --squash",
			state,
		);
		await notMergeGuard(
			"gh pr merge 999999 --squash -Rcad0p/pi-usage",
			state,
		);
		await notMergeGuard("gh pr merge 999999 -R=cad0p/pi-usage --squash", state);
	});

	it("blocks a private repo targeted with -R, in every spelling", async () => {
		const state: GitState = { publicRepos: [PUBLIC_REPO] };
		await blocked("gh pr merge 999999 --squash -R cad0p/pc-host", state);
		await blocked("gh pr merge --repo=cad0p/pc-host 999999 --squash", state);
		await blocked("gh pr merge 999999 --squash -Rcad0p/pc-host", state);
		await blocked("gh -R cad0p/pc-host pr merge 999999 --squash", state);
	});

	it("probes a -R target BY NAME, never the cwd", async () => {
		// A dedicated repo: successful lookups are cached per repo for a few
		// minutes, so this must not ride on an earlier test's answer.
		const calls = await ghCalls("gh pr merge 999999 --squash -R cad0p/probe-merge", {
			publicRepos: ["cad0p/probe-merge"],
			cwdRepo: PRIVATE_REPO,
		});
		assert.deepEqual(calls, ["api repos/cad0p/probe-merge --jq .private"]);
	});

	it("allows a merge in a public cwd repo", async () => {
		await allowed(
			`gh pr merge 999999 --squash --subject "feat: x (closes #12)"`,
			{ publicRepos: [PUBLIC_REPO], cwdRepo: PUBLIC_REPO },
		);
	});

	it("probes the cwd with gh repo view, in the command's cwd", async () => {
		const state: GitState = {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PUBLIC_REPO,
		};
		const h = host(state);
		await firedRule("gh pr merge 999999 --squash", state, h);
		const call = h.execCalls.find((c) => c.cmd === "gh");
		assert.equal(
			call?.args.join(" "),
			"repo view --json nameWithOwner,isPrivate",
		);
		assert.equal(call?.cwd, CWD);
	});

	it("blocks a merge in a private cwd repo", async () => {
		await blocked("gh pr merge 999999 --squash", {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PRIVATE_REPO,
		});
	});

	it("honours GH_REPO from the command's own env", async () => {
		const state: GitState = {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PRIVATE_REPO,
		};
		await notMergeGuard("GH_REPO=cad0p/pi-usage gh pr merge 999999 --squash", state);
		await blocked("GH_REPO=cad0p/pc-host gh pr merge 999999 --squash", state);
	});

	it("honours an in-chain export GH_REPO (walker env)", async () => {
		await notMergeGuard(
			"export GH_REPO=cad0p/pi-usage && gh pr merge 999999 --squash",
			{ publicRepos: [PUBLIC_REPO], cwdRepo: PRIVATE_REPO },
		);
	});

	it("-R beats GH_REPO (gh's own precedence)", async () => {
		await notMergeGuard(
			"GH_REPO=cad0p/pc-host gh pr merge 999999 --squash -R cad0p/pi-usage",
			{ publicRepos: [PUBLIC_REPO] },
		);
	});
});

describe("merge guard — visibility gate: gh api", () => {
	it("allows the REST merge endpoint on a public repo", async () => {
		await allowed("gh api -X PUT repos/cad0p/pi-usage/pulls/999999/merge", {
			publicRepos: [PUBLIC_REPO],
		});
		await allowed("gh api repos/cad0p/pi-usage/pulls/999999/merge -X PUT", {
			publicRepos: [PUBLIC_REPO],
		});
	});

	it("blocks the REST merge endpoint on a private repo", async () => {
		await blocked("gh api -X PUT repos/cad0p/pc-host/pulls/999999/merge", {
			publicRepos: [PUBLIC_REPO],
		});
	});

	it("resolves {owner}/{repo} placeholders to the cwd repo", async () => {
		const command = "gh api -X PUT repos/{owner}/{repo}/pulls/999999/merge";
		await allowed(command, {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PUBLIC_REPO,
		});
		await blocked(command, {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PRIVATE_REPO,
		});
	});

	it("resolves placeholders through GH_REPO, like gh does", async () => {
		const command = "gh api -X PUT repos/{owner}/{repo}/pulls/999999/merge";
		await allowed(`GH_REPO=cad0p/pi-usage ${command}`, {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PRIVATE_REPO,
		});
		await blocked(`GH_REPO=cad0p/pc-host ${command}`, {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PUBLIC_REPO,
		});
	});

	it("routes renovate-ref writes through the same gate", async () => {
		await allowed(
			"gh api -X PATCH repos/cad0p/pi-usage/git/refs/heads/renovate/x -f sha=abc123",
			{ publicRepos: [PUBLIC_REPO] },
		);
		await blocked(
			"gh api -X PATCH repos/cad0p/pc-host/git/refs/heads/renovate/x -f sha=abc123",
			{ publicRepos: [PUBLIC_REPO] },
		);
	});
});

describe("merge guard — visibility gate: renovate push", () => {
	it("allows a renovate push to a public named remote", async () => {
		await allowed("git push origin HEAD:renovate/x", {
			publicRepos: [PUBLIC_REPO],
			remotes: { origin: `https://github.com/${PUBLIC_REPO}.git` },
		});
	});

	it("allows a renovate push to a public URL given on the command line", async () => {
		await allowed(
			"git push https://github.com/cad0p/pi-usage.git HEAD:renovate/x",
			{ publicRepos: [PUBLIC_REPO] },
		);
		await allowed("git push git@github.com:cad0p/pi-usage.git renovate/x", {
			publicRepos: [PUBLIC_REPO],
		});
	});

	it("blocks a renovate push to a private remote", async () => {
		await blocked("git push origin HEAD:renovate/x", {
			publicRepos: [PUBLIC_REPO],
			remotes: { origin: `https://github.com/${PRIVATE_REPO}.git` },
		});
	});

	it("uses the branch's remote for a bare push", async () => {
		await allowed("git push", {
			branch: "renovate/x",
			branchRemote: "upstream",
			remotes: { upstream: "ssh://git@github.com/cad0p/pi-usage.git" },
			publicRepos: [PUBLIC_REPO],
		});
		await blocked("git push", {
			branch: "renovate/x",
			branchRemote: "upstream",
			remotes: { upstream: "https://gitlab.com/cad0p/x.git" },
			publicRepos: [PUBLIC_REPO],
		});
	});

	it("probes the remote URL, then the repo visibility", async () => {
		// A dedicated repo: the lookup cache must not hide the probe here.
		const state: GitState = {
			publicRepos: ["cad0p/probe-push"],
			remotes: { origin: "https://github.com/cad0p/probe-push.git" },
		};
		const h = host(state);
		await firedRule("git push origin HEAD:renovate/x", state, h);
		assert.deepEqual(
			h.execCalls.map((c) => `${c.cmd} ${c.args.join(" ")}`),
			[
				"git config --get remote.origin.url",
				"gh api repos/cad0p/probe-push --jq .private",
			],
		);
	});
});

describe("merge guard — visibility gate: fail-closed", () => {
	it("blocks when the named-repo lookup fails (not logged in / offline)", async () => {
		await blocked(`gh pr merge 999999 --squash -R ${UNKNOWN_REPO}`, {
			lookupFails: true,
			publicRepos: [PUBLIC_REPO],
		});
		await blocked(
			`gh api -X PUT repos/${UNKNOWN_REPO}/pulls/999999/merge`,
			{ lookupFails: true, publicRepos: [PUBLIC_REPO] },
		);
	});

	it("blocks when the cwd lookup fails", async () => {
		await blocked("gh pr merge 999999 --squash", {
			lookupFails: true,
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PUBLIC_REPO,
		});
	});

	it("blocks when the command's cwd is walker-unknown", async () => {
		const state: GitState = {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PUBLIC_REPO,
		};
		await blocked('cd "$X" && gh pr merge 999999 --squash', state);
		await blocked(
			'cd "$X" && gh api -X PUT repos/{owner}/{repo}/pulls/999999/merge',
			state,
		);
	});

	it("blocks a gh api merge with no resolvable repos/<o>/<r> segment", async () => {
		await blocked("gh api -X PUT /pulls/999999/merge", {
			publicRepos: [PUBLIC_REPO],
		});
	});

	it("blocks a GraphQL merge mutation regardless of visibility", async () => {
		const state: GitState = {
			publicRepos: [PUBLIC_REPO],
			cwdRepo: PUBLIC_REPO,
		};
		await blocked(
			`gh api graphql -f 'query=mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
			state,
		);
		await blocked(
			`gh api graphql -f 'query=mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
			state,
		);
	});

	it("blocks a renovate push whose remote is not a GitHub repo", async () => {
		await blocked("git push origin HEAD:renovate/x", {
			remotes: { origin: "https://gitlab.com/cad0p/x.git" },
		});
		await blocked("git push origin HEAD:renovate/x", {
			remotes: { origin: "/srv/git/bare.git" },
		});
		await blocked("git push origin HEAD:renovate/x", { remotes: {} });
	});

	it("blocks a renovate push when the branch cannot be named", async () => {
		await blocked("git push", { publicRepos: [PUBLIC_REPO] });
		await blocked("git push", { branch: "renovate/x", remotes: {} });
	});
});

describe("merge guard — visibility gate: the disarm stays visibility-blind", () => {
	it("allows the disarm on a private, public, or unresolvable repo", async () => {
		await allowed("gh -R cad0p/pc-host pr merge 999999 --disable-auto", {
			lookupFails: true,
		});
		await allowed("gh -R cad0p/pi-usage pr merge 999999 --disable-auto", {
			lookupFails: true,
		});
		await allowed("gh pr merge 999999 --disable-auto", { lookupFails: true });
	});

	it("never probes visibility for a disarm", async () => {
		assert.deepEqual(await ghCalls("gh pr merge 999999 --disable-auto", {}), []);
	});
});
