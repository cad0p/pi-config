import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

describe("dev-shm-guard", () => {
	const harness = loadHarness({ config });

	// write / edit tools
	it("blocks write under /dev/shm", async () => {
		await expectBlocks(harness, { write: { path: "/dev/shm/rows/big.txt", content: "x" } });
	});
	it("blocks edit under /dev/shm", async () => {
		await expectBlocks(harness, { edit: { path: "/dev/shm/m2/tools/ci.sh", edits: [] } });
	});
	it("allows write under tshhome", async () => {
		await expectAllows(harness, { write: { path: "/dev/shm/tshhome/.tsh/x", content: "x" } });
	});
	it("allows write under /data/tmp", async () => {
		await expectAllows(harness, { write: { path: "/data/tmp/rows/big.txt", content: "x" } });
	});

	// the incident's shapes
	it("blocks cp -a of a clone into /dev/shm", async () => {
		await expectBlocks(harness, { command: "cd /dev/shm && rm -rf m2 && mkdir m2 && cp -a ~/.cache/x/clone/. m2/" });
	});
	it("blocks cp -a with an absolute /dev/shm target", async () => {
		await expectBlocks(harness, { command: "cp -a clone /dev/shm/mut" });
	});
	it("blocks TMPDIR=/dev/shm go test", async () => {
		await expectBlocks(harness, { command: "TMPDIR=/dev/shm go test -p 2 -count=1 ./..." });
	});
	it("blocks export TMPDIR=/dev/shm then go test", async () => {
		await expectBlocks(harness, { command: "export TMPDIR=/dev/shm && go test ./..." });
	});
	it("blocks git clone into /dev/shm", async () => {
		await expectBlocks(harness, { command: "git clone -q https://github.com/cad0p/pc-control.git /dev/shm/fc-x" });
	});
	it("blocks a python writer run from inside /dev/shm", async () => {
		await expectBlocks(harness, { command: "cd /dev/shm/rows && python3 gen.py" });
	});
	it("blocks a writer nested in bash -c", async () => {
		await expectBlocks(harness, { command: "bash -c 'mkdir -p /dev/shm/x'" });
	});
	it("blocks awk redirecting into /dev/shm from inside /dev/shm", async () => {
		await expectBlocks(harness, { command: "cd /dev/shm/rows && awk 'BEGIN{print 1}' > big.txt" });
	});
	// KNOWN GAP (see dev-shm-guard.ts header): redirect targets are not
	// exposed to predicates. Flip to expectBlocks once pi-steering does.
	it("KNOWN GAP: allows an absolute redirect into /dev/shm from elsewhere", async () => {
		await expectAllows(harness, { command: "awk 'BEGIN{print 1}' > /dev/shm/rows/big.txt" });
	});

	// allowed: reads, cleanup, the tshhome exemption, $TMPDIR
	it("allows ls / du / df of /dev/shm", async () => {
		await expectAllows(harness, { command: "ls -la /dev/shm && du -sh /dev/shm/* && df -h /dev/shm" });
	});
	it("allows rm of /dev/shm leftovers", async () => {
		await expectAllows(harness, { command: "rm -rf /dev/shm/mut-f1 /dev/shm/m310r9" });
	});
	it("allows rebuilding tshhome", async () => {
		await expectAllows(harness, {
			command: "rm -rf /dev/shm/tshhome && mkdir -m 700 /dev/shm/tshhome && cp -a ~/.tsh /dev/shm/tshhome/.tsh",
		});
	});
	it("allows mktemp -d under TMPDIR", async () => {
		await expectAllows(harness, { command: "d=$(mktemp -d) && cp -a clone \"$d/mut\"" });
	});
	it("allows cp into /data/tmp", async () => {
		await expectAllows(harness, { command: "cp -a clone /data/tmp/mut" });
	});
	it("does not match /dev/shmfoo", async () => {
		await expectAllows(harness, { command: "cp a /dev/shmfoo/b" });
	});
});
