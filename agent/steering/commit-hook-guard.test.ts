import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

/** Not refused by THIS guard (other rails, e.g. no-main-commit on the test's cwd, may still fire). */
async function notRefusedHere(harness: ReturnType<typeof loadHarness>, input: { command: string }) {
	try {
		await expectAllows(harness, input);
	} catch (e) {
		const msg = String((e as Error)?.message ?? e);
		if (/no-commit-hook-|no-hook-manager|no-hooks-path/.test(msg)) throw e;
	}
}

describe("commit-hook-guard", () => {
	const harness = loadHarness({ config });

	it("blocks write of .git/hooks/pre-commit", async () => {
		await expectBlocks(harness, { write: { path: "/home/pier/personal/github/Goldmine/.git/hooks/pre-commit", content: "#!/bin/sh" } });
	});
	it("blocks write of .githooks/commit-msg", async () => {
		await expectBlocks(harness, { write: { path: "/x/repo/.githooks/commit-msg", content: "x" } });
	});
	it("blocks write of .husky/pre-commit", async () => {
		await expectBlocks(harness, { write: { path: "/x/repo/.husky/pre-commit", content: "x" } });
	});
	it("blocks write of .pre-commit-config.yaml", async () => {
		await expectBlocks(harness, { write: { path: "/x/repo/.pre-commit-config.yaml", content: "x" } });
	});
	it("blocks edit of a hook", async () => {
		await expectBlocks(harness, { edit: { path: "/x/repo/.git/hooks/prepare-commit-msg", edits: [] } });
	});
	it("allows write of pre-push (not a commit hook)", async () => {
		await expectAllows(harness, { write: { path: "/x/repo/.git/hooks/pre-push.txt", content: "x" } });
	});
	it("allows write of a script named pre-commit-notes.md", async () => {
		await expectAllows(harness, { write: { path: "/x/repo/docs/pre-commit-notes.md", content: "x" } });
	});

	it("blocks cp into .git/hooks/pre-commit", async () => {
		await expectBlocks(harness, { command: "cp hook.sh .git/hooks/pre-commit" });
	});
	it("blocks ln -s into .git/hooks/pre-commit", async () => {
		await expectBlocks(harness, { command: "cd /home/pier/personal/github/Goldmine && ln -sf ../../Scripts/x.py .git/hooks/pre-commit" });
	});
	it("blocks chmod +x of a pre-commit hook", async () => {
		await expectBlocks(harness, { command: "chmod +x .git/hooks/pre-commit" });
	});
	it("blocks tee into a hook", async () => {
		await expectBlocks(harness, { command: "printf '#!/bin/sh' | tee .git/hooks/commit-msg" });
	});
	it("blocks pre-commit install", async () => {
		await expectBlocks(harness, { command: "pre-commit install" });
	});
	it("blocks husky", async () => {
		await expectBlocks(harness, { command: "husky install" });
	});
	it("blocks lefthook install", async () => {
		await expectBlocks(harness, { command: "lefthook install" });
	});
	it("blocks git config core.hooksPath", async () => {
		await expectBlocks(harness, { command: "git config core.hooksPath .githooks" });
	});
	it("blocks git config --global core.hooksPath", async () => {
		await expectBlocks(harness, { command: "git config --global core.hooksPath ~/hooks" });
	});
	it("blocks git -c core.hooksPath=hooks commit", async () => {
		await expectBlocks(harness, { command: "git -c core.hooksPath=hooks commit -m x" });
	});

	it("allows git -c core.hooksPath=/dev/null commit", async () => {
		await notRefusedHere(harness, { command: "git -c core.hooksPath=/dev/null commit -m x -- a.md" });
	});
	it("allows git config --unset core.hooksPath", async () => {
		await expectAllows(harness, { command: "git config --unset core.hooksPath" });
	});
	it("allows git config --get core.hooksPath", async () => {
		await expectAllows(harness, { command: "git config --get core.hooksPath" });
	});
	it("allows listing and removing hooks", async () => {
		await expectAllows(harness, { command: "ls .git/hooks && cat .git/hooks/pre-commit && rm -f .git/hooks/pre-commit" });
	});
	it("allows a plain commit", async () => {
		await notRefusedHere(harness, { command: "git commit -m 'x' -- notes/a.md" });
	});
	it("allows running the milestones checker by hand", async () => {
		await expectAllows(harness, { command: "python3 Scripts/orchestration/milestones-check.py personal/github/pcad.it-infra/milestones.md" });
	});
});
