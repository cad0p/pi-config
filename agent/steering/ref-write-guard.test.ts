import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

/**
 * A host whose git exec resolves the current branch to "feature" and the
 * remote to "" (no origin). Without it the git plugin's branch predicate
 * would fail closed ("unknown") and unrelated rules (no-main-commit) would
 * block the allowed git commands below.
 */
const host = {
	exec: async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("branch") && args.includes("--show-current")) {
			return { stdout: "feature\n", stderr: "", code: 0, killed: false };
		}
		return { stdout: "", stderr: "", code: 0, killed: false };
	},
	appendEntry: () => {},
};

describe("ref-write-guard", () => {
	const harness = loadHarness({ config, host });

	// The incident's shape and its indirections. Every one of these writes
	// refs/heads/main through plumbing that the shipped rules do not name.
	for (const command of [
		"git update-ref refs/heads/main 0123456789012345678901234567890123456789",
		"git update-ref refs/heads/master 0123456789012345678901234567890123456789",
		"git update-ref main 0123456789012345678901234567890123456789",
		"git update-ref HEAD 0123456789012345678901234567890123456789",
		"git update-ref --stdin",
		"git update-ref -m import refs/heads/main 0123456789012345678901234567890123456789",
		"git update-ref -d refs/heads/main",
		"git -C /home/pier/personal/github/Goldmine update-ref refs/heads/main HEAD~1",
		"git -c core.hooksPath=/dev/null update-ref refs/heads/main HEAD~1",
		"git --git-dir=/home/pier/personal/github/Goldmine/.git update-ref refs/heads/main HEAD~1",
		"cd /home/pier/personal/github/Goldmine && git update-ref refs/heads/main HEAD~1",
		"bash -c 'git update-ref refs/heads/main HEAD~1'",
		"git branch -f main 0123456789012345678901234567890123456789",
		"git branch --force main 0123456789012345678901234567890123456789",
		"git branch -vf main origin/main",
		"git branch -M main",
		"git branch --move old-name main",
		"git checkout -B main 0123456789012345678901234567890123456789",
		"git checkout -Bmain 0123456789012345678901234567890123456789",
		"git switch -C main",
		"git switch -Cmain",
		"git switch --force-create main",
		"git switch --force-create=main",
		"git fetch . +HEAD:main",
		"git fetch origin +refs/heads/landing:refs/heads/main",
		"git symbolic-ref refs/heads/main refs/heads/landing",
	]) {
		it("blocks: " + command, async () => {
			await expectBlocks(harness, { command }, { rule: "no-main-ref-write" });
		});
	}

	// Fast-forwardable / feature-branch / read-only forms stay allowed.
	for (const command of [
		"git update-ref refs/heads/feature 0123456789012345678901234567890123456789",
		"git update-ref refs/remotes/origin/main 0123456789012345678901234567890123456789",
		"git branch -f feature 0123456789012345678901234567890123456789",
		"git branch --force landing origin/landing",
		"git branch -m feature-renamed",
		"git branch --contains main",
		"git branch --merged main",
		"git branch --list main",
		"git checkout -b main-2",
		"git checkout -B feature-2 0123456789012345678901234567890123456789",
		"git switch -c main-2",
		"git switch -C feature-2",
		"git fetch origin main",
		"git fetch . main:main",
		"git push origin main",
		"git push origin feature:feature",
		"git log --oneline main",
		"git commit -m 'docs: explain git update-ref refs/heads/main'",
		"git commit -m 'branch -f main is forbidden'",
		"echo 'git update-ref refs/heads/main HEAD~1'",
		"cat docs/main-ref-write.md",
	]) {
		it("allows: " + command, async () => {
			await expectAllows(harness, { command });
		});
	}

	// The existing destructive rails are unchanged (not loosened): these
	// fire their own rules, not the new one.
	for (const [command, rule] of [
		["git reset --hard 0123456789012345678901234567890123456789", "no-hard-reset"],
		["git -C /repo reset --hard", "no-hard-reset"],
		["git reset --hard origin/main", "no-hard-reset"],
		["git push -f origin main", "no-force-push"],
		["git push --force origin main", "no-force-push"],
		["git push --force-with-lease origin main", "no-force-push"],
		["git push origin +main", "no-force-push"],
		["git push . +HEAD:main", "no-force-push"],
	] as const) {
		it("existing rule " + rule + " still blocks: " + command, async () => {
			await expectBlocks(harness, { command }, { rule });
		});
	}
});

// The owner's required coverage explicitly names reset --hard "aimed at
// main/master" and force-push. Both are owned by shipped rails that fire on
// any branch (a superset), so this block pins them with the branch resolved
// to main to show the main/master case is covered, not just the feature
// branch the block above uses.
describe("ref-write-guard — main/master target coverage", () => {
	const mainHost = {
		exec: async (cmd: string, args: string[]) => {
			if (cmd === "git" && args.includes("branch") && args.includes("--show-current")) {
				return { stdout: "main\n", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		appendEntry: () => {},
	};
	const harness = loadHarness({ config, host: mainHost });

	for (const command of [
		"git reset --hard HEAD~1",
		"git -C /tmp/vault reset --hard origin/main",
		"git reset --hard 0123456789012345678901234567890123456789",
	]) {
		it("blocks reset --hard while on main: " + command, async () => {
			await expectBlocks(harness, { command }, { rule: "no-hard-reset" });
		});
	}

	for (const command of [
		"git push --force origin main",
		"git push -f origin main",
		"git push --force-with-lease origin main",
		"git push origin +main",
		"git push origin main --force",
	]) {
		it("blocks force-push aimed at main: " + command, async () => {
			await expectBlocks(harness, { command }, { rule: "no-force-push" });
		});
	}

	it("allows a non-force push to main", async () => {
		await expectAllows(harness, { command: "git push origin main" });
	});
});
