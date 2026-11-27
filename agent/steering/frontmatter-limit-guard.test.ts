import { describe, it, before, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

/** Blocked, and by THIS guard. */
async function blocksHere(harness: ReturnType<typeof loadHarness>, input: Parameters<typeof expectBlocks>[1]) {
	let msg = "";
	try {
		await expectAllows(harness, input);
	} catch (e) {
		msg = String((e as Error)?.message ?? e);
	}
	if (!/frontmatter-limit-(write|edit|shell)/.test(msg)) throw new Error("not blocked by frontmatter-limit-*: " + (msg || "allowed"));
}

const FM = (extra: string) => `---\ntitle: x\n${extra}---\n# T\n`;

describe("frontmatter-limit-guard", () => {
	const harness = loadHarness({ config });
	let root = "";
	before(() => {
		root = mkdtempSync(join(tmpdir(), "fmlim-"));
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "Scripts"));
		writeFileSync(join(root, "Scripts", "chk.py"), "import sys\ns=open(sys.argv[1]).read()\nif 'BAD' in s:\n    print('L9: BAD found; move it to log.md'); sys.exit(1)\n");
		writeFileSync(join(root, "lim.md"), FM("limit-lines: 8\nlimit-line-chars: 40\n") + "a\n");
		writeFileSync(join(root, "chk.md"), FM("steering-check: Scripts/chk.py\n") + "ok\n");
		writeFileSync(join(root, "free.md"), FM("") + "a\n");
		writeFileSync(join(root, "escape.md"), FM("steering-check: ../../etc/x.py\n") + "a\n");
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	it("allows a write within limit-lines", async () => {
		await expectAllows(harness, { write: { path: join(root, "lim.md"), content: FM("limit-lines: 8\n") + "a\nb\n" } });
	});
	it("blocks a write over limit-lines", async () => {
		await blocksHere(harness, { write: { path: join(root, "lim.md"), content: FM("limit-lines: 8\n") + "a\nb\nc\nd\ne\nf\n" } });
	});
	it("blocks a write that drops the key but breaks the file's current limit", async () => {
		await blocksHere(harness, { write: { path: join(root, "lim.md"), content: "x\n".repeat(20) } });
	});
	it("blocks an edit that adds a too-long line", async () => {
		await blocksHere(harness, { edit: { path: join(root, "lim.md"), edits: [{ oldText: "a\n", newText: "a".repeat(60) + "\n" }] } });
	});
	it("allows a small edit", async () => {
		await expectAllows(harness, { edit: { path: join(root, "lim.md"), edits: [{ oldText: "a\n", newText: "b\n" }] } });
	});
	it("runs steering-check and blocks on its failure", async () => {
		await blocksHere(harness, { edit: { path: join(root, "chk.md"), edits: [{ oldText: "ok\n", newText: "BAD\n" }] } });
	});
	it("runs steering-check and allows on its pass", async () => {
		await expectAllows(harness, { edit: { path: join(root, "chk.md"), edits: [{ oldText: "ok\n", newText: "fine\n" }] } });
	});
	it("refuses a steering-check outside the git root", async () => {
		await blocksHere(harness, { edit: { path: join(root, "escape.md"), edits: [{ oldText: "a\n", newText: "b\n" }] } });
	});
	it("ignores a file without limit keys", async () => {
		await expectAllows(harness, { write: { path: join(root, "free.md"), content: "x\n".repeat(500) } });
	});
	it("ignores a new file without limit keys", async () => {
		await expectAllows(harness, { write: { path: join(root, "new.md"), content: "x\n".repeat(500) } });
	});

	it("blocks sed -i on a limited file", async () => {
		await blocksHere(harness, { command: `sed -i 's/a/b/' ${join(root, "lim.md")}` });
	});
	it("blocks cp onto a limited file", async () => {
		await blocksHere(harness, { command: `cp /etc/hostname ${join(root, "chk.md")}` });
	});
	it("blocks tee onto a limited file", async () => {
		await blocksHere(harness, { command: `echo x | tee ${join(root, "lim.md")}` });
	});
	it("allows cp from a limited file", async () => {
		await expectAllows(harness, { command: `cp ${join(root, "lim.md")} ${join(root, "copy.md")}` });
	});
	it("allows sed without -i on a limited file", async () => {
		await expectAllows(harness, { command: `sed -n 1,5p ${join(root, "lim.md")}` });
	});
	it("allows sed -i on a file without limits", async () => {
		await expectAllows(harness, { command: `sed -i 's/a/b/' ${join(root, "free.md")}` });
	});
});
