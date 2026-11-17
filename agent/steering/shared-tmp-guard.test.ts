import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "shared-tmp-guard-"));
const onFile = join(dir, "scratch-root");
const offFile = join(dir, "absent");
const prev = process.env.PI_STEERING_SCRATCH_ROOT_FILE;
after(() => {
	if (prev === undefined) delete process.env.PI_STEERING_SCRATCH_ROOT_FILE;
	else process.env.PI_STEERING_SCRATCH_ROOT_FILE = prev;
	rmSync(dir, { recursive: true, force: true });
});

describe("shared-tmp-guard on a machine that opted in", () => {
	const harness = loadHarness({ config });
	before(() => {
		writeFileSync(onFile, "/data/tmp\n");
		process.env.PI_STEERING_SCRATCH_ROOT_FILE = onFile;
	});

	it("blocks write under /tmp", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", write: { path: "/tmp/wa-probe/x.json", content: "x" } });
	});
	it("blocks edit under /var/tmp", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", edit: { path: "/var/tmp/l0318/tools/ci.sh", edits: [] } });
	});
	it("blocks mkdir of a lens snapshot in /var/tmp", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", command: "mkdir -p /var/tmp/l0319 && git archive HEAD | tar -x -C /var/tmp/l0319" });
	});
	it("blocks cp into /tmp", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", command: "cp -a clone /tmp/mut" });
	});
	it("blocks TMPDIR=/tmp go test", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", command: "TMPDIR=/tmp go test ./..." });
	});
	it("blocks export TMPDIR=/var/tmp then go test", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", command: "export TMPDIR=/var/tmp && go test ./..." });
	});
	it("blocks a writer run from inside /var/tmp", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", command: "cd /var/tmp/r42e && python3 gen.py" });
	});
	it("blocks pnpm with a store in /tmp", async () => {
		await expectBlocks(harness, { cwd: "/home/u/repo", command: "pnpm install --store-dir /tmp/.pnpm-store" });
	});

	it("allows write under /data/tmp", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", write: { path: "/data/tmp/x/y.md", content: "x" } });
	});
	it("allows cp into /data/tmp (not a /tmp path)", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", command: "cp -a clone /data/tmp/mut" });
	});
	it("allows a socket path in /tmp", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", command: "node srv.js --listen /tmp/app.sock" });
	});
	it("allows reads and cleanup", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", command: "ls -la /tmp && du -sh /var/tmp/* && df -h /tmp && rm -rf /var/tmp/l0316" });
	});
	it("allows mktemp -d under TMPDIR", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", command: "d=$(mktemp -d) && cp -a clone \"$d/mut\"" });
	});
	it("does not match /tmpfoo or /var/tmpx", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", command: "cp a /tmpfoo/b && cp a /var/tmpx/b" });
	});
});

describe("shared-tmp-guard on a machine that did not opt in", () => {
	const harness = loadHarness({ config });
	before(() => {
		process.env.PI_STEERING_SCRATCH_ROOT_FILE = offFile;
	});
	it("allows write under /tmp", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", write: { path: "/tmp/x/y.md", content: "x" } });
	});
	it("allows cp into /var/tmp", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", command: "cp -a clone /var/tmp/mut" });
	});
	it("allows TMPDIR=/tmp go test", async () => {
		await expectAllows(harness, { cwd: "/home/u/repo", command: "TMPDIR=/tmp go test ./..." });
	});
});
