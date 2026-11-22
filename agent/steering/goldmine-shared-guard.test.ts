// SPDX-License-Identifier: MIT
/**
 * The shared-Goldmine block/allow matrix (brief goldmine-shared-guard,
 * 2026-11-22). Two rails, two incidents:
 *
 *   - R1 `goldmine-no-autostash` — the 22:51:49Z autostash that swept
 *     another session's in-progress note into a stash (then conflicted
 *     on the pop);
 *   - R2 `goldmine-commit-needs-pathspec` — the 22:57:10Z pathspec-less
 *     `git commit` that swept that session's STAGED edit into a foreign
 *     commit under the wrong message.
 *
 * The pinned gaps (an unresolvable repo, `git add -u`, a pathspec written
 * without `--`) are asserted as ALLOWED/REFUSED exactly as documented in
 * ./goldmine-shared-guard.ts, so a later "fix" that changes behaviour
 * without changing the header fails here.
 */

import { describe, it } from "node:test";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const VAULT = "/home/pier/personal/github/Goldmine";
const NOTE =
	"personal/github/pc-control/prs/2026-11-22-pr-alias-refuse-uppercase.md";
// Not a primary checkout under the pc-* areas and not the vault: the other
// rails (primary-checkout, no-main-commit) stay quiet, so a block here is
// this guard's own.
const ELSEWHERE = "/home/u/work";
const R1 = "goldmine-no-autostash";
const R2 = "goldmine-commit-needs-pathspec";

const harness = loadHarness({ config });

describe("goldmine-no-autostash (R1)", () => {
	it("blocks a pull with --autostash in the vault", async () => {
		await expectBlocks(harness, { command: "git pull --autostash", cwd: VAULT }, { rule: R1 });
	});
	it("blocks --autostash on origin main, from a vault subdirectory", async () => {
		await expectBlocks(
			harness,
			{ command: "git pull --autostash origin main", cwd: VAULT + "/personal" },
			{ rule: R1 },
		);
	});
	it("blocks a pull with --autostash reached through cd in the same command", async () => {
		await expectBlocks(
			harness,
			{ command: "cd " + VAULT + " && git pull --autostash", cwd: ELSEWHERE },
			{ rule: R1 },
		);
	});
	it("blocks git -C <vault> rebase --autostash from elsewhere", async () => {
		await expectBlocks(
			harness,
			{ command: "git -C " + VAULT + " rebase --autostash origin/main", cwd: ELSEWHERE },
			{ rule: R1 },
		);
	});
	it("blocks the config form git -c rebase.autoStash=true pull", async () => {
		await expectBlocks(harness, { command: "git -c rebase.autoStash=true pull", cwd: VAULT }, { rule: R1 });
	});
	it("blocks the glued config form -crebase.autoStash=true", async () => {
		await expectBlocks(
			harness,
			{ command: "git -crebase.autoStash=true rebase origin/main", cwd: VAULT },
			{ rule: R1 },
		);
	});
	it("blocks a bare git stash", async () => {
		await expectBlocks(harness, { command: "git stash", cwd: VAULT }, { rule: R1 });
	});
	it("blocks a bare git stash carrying only flags", async () => {
		await expectBlocks(harness, { command: "git stash -u", cwd: VAULT }, { rule: R1 });
	});
	it("blocks git stash push with no pathspec", async () => {
		await expectBlocks(harness, { command: "git stash push", cwd: VAULT }, { rule: R1 });
	});
	it("blocks git stash push -m <msg> (the message is not a pathspec)", async () => {
		await expectBlocks(
			harness,
			{ command: "git stash push -m \"wip before pull\"", cwd: VAULT },
			{ rule: R1 },
		);
	});
	it("blocks git stash save (it takes a message, never a pathspec)", async () => {
		await expectBlocks(harness, { command: "git stash save wip", cwd: VAULT }, { rule: R1 });
	});
	it("blocks a stash push nested in sh -c (codemode-nested bash shape)", async () => {
		// codemode's await tools.bash({ command }) reaches steering as a bash
		// tool call; the walker descends into the payload but keeps the outer cwd.
		await expectBlocks(
			harness,
			{ command: "sh -c 'git stash push -m wip'", cwd: VAULT },
			{ rule: R1 },
		);
	});
	it("blocks a payload cd into the vault from elsewhere (codemode-nested)", async () => {
		await expectBlocks(
			harness,
			{ command: "sh -c 'cd " + VAULT + " && git pull --autostash'", cwd: ELSEWHERE },
			{ rule: R1 },
		);
	});
	it("carries the owner's fix, verbatim", async () => {
		await expectBlocks(
			harness,
			{ command: "git pull --autostash", cwd: VAULT },
			{ rule: R1, reason: /never stash or autostash others' work/ },
		);
	});
});

describe("goldmine-commit-needs-pathspec (R2)", () => {
	it("blocks git commit -m with no pathspec", async () => {
		await expectBlocks(
			harness,
			{ command: "git commit -m \"note: x\"", cwd: VAULT },
			{ rule: R2 },
		);
	});
	it("blocks it from a vault subdirectory", async () => {
		await expectBlocks(
			harness,
			{ command: "git commit -m \"note: x\"", cwd: VAULT + "/personal/github/pc-control" },
			{ rule: R2 },
		);
	});
	it("blocks git commit -am (bundled -a)", async () => {
		await expectBlocks(
			harness,
			{ command: "git commit -am \"note: x\"", cwd: VAULT },
			{ rule: R2 },
		);
	});
	it("blocks git commit -a -m", async () => {
		await expectBlocks(
			harness,
			{ command: "git commit -a -m x", cwd: VAULT },
			{ rule: R2 },
		);
	});
	it("blocks git commit --all even with a pathspec", async () => {
		await expectBlocks(
			harness,
			{ command: "git commit --all -m x -- " + NOTE, cwd: VAULT },
			{ rule: R2 },
		);
	});
	it("blocks a pathspec-less commit reached through cd", async () => {
		await expectBlocks(
			harness,
			{ command: "cd " + VAULT + " && git commit -m x", cwd: ELSEWHERE },
			{ rule: R2 },
		);
	});
	it("blocks git -C <vault> commit -m from elsewhere", async () => {
		await expectBlocks(
			harness,
			{ command: "git -C " + VAULT + " commit -m x", cwd: ELSEWHERE },
			{ rule: R2 },
		);
	});
	it("blocks git commit --only with no paths", async () => {
		await expectBlocks(
			harness,
			{ command: "git commit --only -m x", cwd: VAULT },
			{ rule: R2 },
		);
	});
	it("blocks git commit with an empty pathspec", async () => {
		await expectBlocks(harness, { command: "git commit -m x --", cwd: VAULT }, { rule: R2 });
	});
	it("blocks git commit with a pathspec written without --", async () => {
		// Implicit pathspec (git commit -m msg <path>) is refused on purpose:
		// the explicit -- form is the fix, so the refusal teaches it.
		await expectBlocks(
			harness,
			{ command: "git commit -m x " + NOTE, cwd: VAULT },
			{ rule: R2 },
		);
	});
	it("blocks git add -A", async () => {
		await expectBlocks(harness, { command: "git add -A", cwd: VAULT }, { rule: R2 });
	});
	it("blocks a bundled git add -Av", async () => {
		await expectBlocks(harness, { command: "git add -Av", cwd: VAULT }, { rule: R2 });
	});
	it("blocks git add --all", async () => {
		await expectBlocks(harness, { command: "git add --all", cwd: VAULT }, { rule: R2 });
	});
	it("blocks git add .", async () => {
		await expectBlocks(harness, { command: "git add .", cwd: VAULT }, { rule: R2 });
	});
	it("blocks git add ./ (same top-level pathspec)", async () => {
		await expectBlocks(harness, { command: "git add ./", cwd: VAULT }, { rule: R2 });
	});
	it("blocks a commit nested in sh -c (codemode-nested bash shape)", async () => {
		await expectBlocks(
			harness,
			{ command: "sh -c 'git commit -a -m x'", cwd: VAULT },
			{ rule: R2 },
		);
	});
	it("blocks a payload cd into the vault then git add -A (codemode-nested)", async () => {
		await expectBlocks(
			harness,
			{ command: "bash -c 'cd " + VAULT + " && git add -A'", cwd: ELSEWHERE },
			{ rule: R2 },
		);
	});
	it("carries the owner's message, verbatim", async () => {
		await expectBlocks(
			harness,
			{ command: "git add -A", cwd: VAULT },
			{ rule: R2, reason: /other sessions have staged work in this checkout/ },
		);
	});
});

describe("goldmine guard: the sanctioned sync and commit forms stay allowed", () => {
	it("allows git pull --no-rebase origin main (the taught sync)", async () => {
		await expectAllows(harness, { command: "git pull --no-rebase origin main", cwd: VAULT });
	});
	it("allows a plain git pull and a --rebase pull without autostash", async () => {
		await expectAllows(harness, { command: "git pull", cwd: VAULT });
		await expectAllows(harness, { command: "git pull --rebase origin main", cwd: VAULT });
	});
	it("allows fetch / status / log reads", async () => {
		await expectAllows(harness, { command: "git fetch origin main && git status --short", cwd: VAULT });
		await expectAllows(harness, { command: "git log --oneline -5", cwd: VAULT });
	});
	it("allows git commit -m <msg> -- <paths>", async () => {
		await expectAllows(
			harness,
			{ command: "git commit -m \"note: alias refuse uppercase\" -- " + NOTE, cwd: VAULT },
		);
	});
	it("allows a commit with several explicit paths", async () => {
		await expectAllows(
			harness,
			{ command: "git commit -m x -- personal/a.md personal/b.md", cwd: VAULT },
		);
	});
	it("allows git commit --only with paths", async () => {
		await expectAllows(harness, { command: "git commit --only -m x personal/a.md", cwd: VAULT });
	});
	it("allows a commit whose message mentions an autostash and a path flag", async () => {
		await expectAllows(
			harness,
			{ command: "git commit -m \"docs: never --autostash -A here\" -- " + NOTE, cwd: VAULT },
		);
	});
	it("allows git add -- <paths> and a single named path", async () => {
		await expectAllows(harness, { command: "git add -- " + NOTE, cwd: VAULT });
		await expectAllows(harness, { command: "git add " + NOTE, cwd: VAULT });
	});
	it("allows a dot-leading named path", async () => {
		await expectAllows(harness, { command: "git add .github/workflows/ci.yml", cwd: VAULT });
	});
	it("allows stash reads, apply/pop and pathspec-scoped pushes", async () => {
		await expectAllows(harness, { command: "git stash list", cwd: VAULT });
		await expectAllows(harness, { command: "git stash show -p", cwd: VAULT });
		await expectAllows(harness, { command: "git stash pop", cwd: VAULT });
		await expectAllows(harness, { command: "git stash apply stash@{0}", cwd: VAULT });
		await expectAllows(harness, { command: "git stash push -- " + NOTE, cwd: VAULT });
		await expectAllows(harness, { command: "git stash push " + NOTE, cwd: VAULT });
		await expectAllows(
			harness,
			{ command: "git stash push -m wip -- " + NOTE, cwd: VAULT },
		);
	});
	it("allows the vault's gm-commit.sh plumbing (git commit-tree)", async () => {
		// Scripts/orchestration/gm-commit.sh: fetch, read-tree, update-index,
		// write-tree, commit-tree, push. No pull, no stash, no add, no commit.
		await expectAllows(
			harness,
			{ command: "git commit-tree -S -p origin/main -m \"msg\" HEAD^{tree}", cwd: VAULT },
		);
		await expectAllows(harness, { command: "git fetch -q origin main", cwd: VAULT });
		await expectAllows(harness, { command: "git read-tree origin/main", cwd: VAULT });
		await expectAllows(
			harness,
			{ command: "git update-index --add --cacheinfo 100644,abc123," + NOTE, cwd: VAULT },
		);
		await expectAllows(harness, { command: "git push -q origin HEAD:main", cwd: VAULT });
	});
});

describe("goldmine guard: scoped to the vault checkout only", () => {
	it("allows an autostash pull in another repo", async () => {
		await expectAllows(harness, { command: "git pull --autostash", cwd: ELSEWHERE });
	});
	it("allows a bare stash and an unscoped stage in another repo", async () => {
		await expectAllows(harness, { command: "git stash", cwd: ELSEWHERE });
		await expectAllows(harness, { command: "git stash push -m wip", cwd: ELSEWHERE });
		await expectAllows(harness, { command: "git add -A", cwd: ELSEWHERE });
	});
	it("allows an unscoped commit off main in another repo", async () => {
		await expectAllows(harness, {
			command: "git checkout -b feat/x && git commit -a -m x",
			cwd: ELSEWHERE,
		});
	});
	it("allows a checkout whose path merely starts with the vault name", async () => {
		// under() is component-boundary: /…/Goldmine-notes is NOT the vault.
		await expectAllows(harness, { command: "git add -A", cwd: VAULT + "-notes" });
	});
	it("allows a distill scratch worktree", async () => {
		await expectAllows(harness, { command: "git add .", cwd: "/data/tmp/wt/goldmine-distill" });
	});
	it("pins the documented gap: an unresolvable repo is not placed, so it is allowed", async () => {
		// Header gap 1: this guard is a shared-checkout rail, not a repo-wide
		// git policy. cd "$VAR" is invisible, so the command is left alone
		// (git add is outside every other rail's reach, so this asserts
		// exactly one thing: this guard stays off).
		await expectAllows(harness, {
			command: "cd \"$VAULT_DIR\" && git add -A",
			cwd: ELSEWHERE,
		});
	});
});
