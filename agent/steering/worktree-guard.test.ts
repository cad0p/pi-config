// SPDX-License-Identifier: MIT
// Global pi-steering config - worktree guard tests (pc-host #764, owner calls 8 and 10).
//
// One creation path and one placement: `pc-wt new` places a worktree as a
// sibling of its primary checkout. The guard refuses the verbs that change a
// registration or a placement (`git worktree add|move|remove|prune`), a clone
// into a scratch root or into `<primary>-<slug>`, and any Goldmine or ~/.pi
// worktree (there are none: writers commit on main, their own paths only).
//
// The config is loaded through pi-steering's real loader (jiti), like
// primary-checkout-guard.test.ts. exec is stubbed: the shipped git rails probe
// the branch, and no test touches a repo. `namesAWorktree` reads the real
// primary directories, which is what the rule does on this host.

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
	AGENT_DIR,
	VAULT,
	badDestination,
	namesAWorktree,
	payloadCalls,
	refused,
	worktreeCall,
} from "./worktree-guard.ts";

const RULE = "no-worktree-outside-pc-wt";
const MESSAGE = /worktrees are created by pc-wt/;
const VAULT_MESSAGE = /commit on main, your paths only/;
const OTHER = "/tmp/steering-worktree-guard";
const PRIMARY = "/home/pier/personal/github/pc-host";

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

/** A recording host: the branch probe answers "main", everything else fails. */
function host() {
	return createRecordingHost({
		exec: (cmd, args) => {
			if (
				cmd === "git" &&
				args[0] === "-C" &&
				args[2] === "rev-parse" &&
				args[3] === "--abbrev-ref" &&
				args[4] === "HEAD"
			) {
				return Promise.resolve(ok("main"));
			}
			return Promise.resolve(fail);
		},
	});
}

async function blocked(command: string, reason = MESSAGE): Promise<void> {
	await expectBlocks(
		loadHarness({ config, host: host() }),
		{ command, cwd: OTHER },
		{ rule: RULE, reason },
	);
}

async function allowed(command: string): Promise<void> {
	await expectAllows(loadHarness({ config, host: host() }), {
		command,
		cwd: OTHER,
	});
}

describe("worktree-guard: the classification", () => {
	it("reads the verb and the repo of a worktree call", () => {
		const call = worktreeCall(["worktree", "add", "/tmp/x", "-b", "b"], OTHER);
		assert.deepEqual(call, { kind: "worktree", verb: "add", repo: OTHER });
		const withDashC = worktreeCall(
			["-C", PRIMARY, "worktree", "prune"],
			OTHER,
		);
		assert.deepEqual(withDashC, { kind: "worktree", verb: "prune", repo: PRIMARY });
	});

	it("refuses the four registration verbs and allows the read ones", () => {
		for (const verb of ["add", "move", "remove", "prune"]) {
			assert.equal(
				refused({ kind: "worktree", verb, repo: OTHER }),
				true,
				verb + " must be refused",
			);
		}
		for (const verb of ["list", "lock", "unlock", "repair"]) {
			assert.equal(
				refused({ kind: "worktree", verb, repo: OTHER }),
				false,
				verb + " must be allowed",
			);
		}
		// An unknown verb fails closed.
		assert.equal(refused({ kind: "worktree", verb: "future", repo: OTHER }), true);
	});

	it("refuses a clone into a scratch root or into <primary>-<slug>", () => {
		assert.equal(badDestination("/data/tmp/wt/pc-host-x"), true);
		assert.equal(badDestination("/tmp/x"), true);
		assert.equal(badDestination(PRIMARY + "-x"), true);
		assert.equal(badDestination("/home/pier/personal/github/new-repo"), false);
		assert.equal(namesAWorktree(PRIMARY), false);
	});

	it("threads a cd through a wrapper payload", () => {
		const calls = payloadCalls(
			"cd " + PRIMARY + " && git worktree add /tmp/x -b b",
			OTHER,
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { kind: "worktree", verb: "add", repo: PRIMARY });
	});
});

describe("worktree-guard: the rule", () => {
	it("refuses git worktree add", async () => {
		await blocked("git worktree add /data/tmp/wt/pc-host-x -b feat/x");
	});

	it("refuses git -C <primary> worktree add", async () => {
		await blocked(
			"git -C " + PRIMARY + " worktree add /data/tmp/wt/pc-host-x -b feat/x",
		);
	});

	it("refuses a worktree add inside a bash -c payload", async () => {
		await blocked(
			"bash -c 'cd " + PRIMARY + " && git worktree add /tmp/x -b feat/x'",
		);
	});

	it("refuses git worktree prune", async () => {
		await blocked("git worktree prune");
	});

	it("refuses git worktree remove --force", async () => {
		await blocked("git worktree remove --force /data/tmp/wt/pc-host-x");
	});

	it("refuses a clone into <primary>-<slug>", async () => {
		await blocked("git clone git@github.com:cad0p/pc-host.git " + PRIMARY + "-x");
	});

	it("refuses a clone into a scratch root", async () => {
		await blocked("git clone git@github.com:cad0p/pc-host.git /data/tmp/wt/x");
	});

	it("refuses a Goldmine worktree with the commit-on-main message", async () => {
		await blocked(
			"git -C " + VAULT + " worktree add /home/pier/personal/github/gm-x -b vault/x",
			VAULT_MESSAGE,
		);
	});

	it("refuses a ~/.pi worktree with the commit-on-main message", async () => {
		await blocked(
			"git -C " + AGENT_DIR + " worktree add /home/pier/personal/github/pi-x -b cfg/x",
			VAULT_MESSAGE,
		);
	});

	it("allows pc-wt new", async () => {
		await allowed("pc-wt new pc-host fix-764 --branch feat/x");
	});

	it("allows git worktree list", async () => {
		await allowed("git worktree list");
	});

	it("allows git worktree lock", async () => {
		await allowed("git -C " + PRIMARY + " worktree lock --reason keep /tmp/x");
	});

	it("allows a clone at a fresh primary name", async () => {
		await allowed(
			"git clone git@github.com:cad0p/new-repo.git /home/pier/personal/github/new-repo",
		);
	});
});
