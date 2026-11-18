import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import {
	FORK_LOOP,
	hasCgroupCap,
	isLoadGeneratorShape,
	isUncappedSyntheticLoad,
	SYNTHETIC_LOAD_ROUTED,
} from "./synthetic-load-guard.ts";

// The shared-tmp guard is opt-in per machine: it arms when the file
// named by PI_STEERING_SCRATCH_ROOT_FILE (default
// ~/.config/pi-steering/scratch-root) exists, and this host HAS opted
// in — /data/tmp paths in the cases below would trip no-shared-tmp-bash
// before this guard even runs. Pin the switch OFF for the whole file so
// the matrix does not depend on the host setting (same seam as
// shared-tmp-guard.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "synthetic-load-guard-"));
const offFile = join(scratchDir, "absent");
const prevScratch = process.env.PI_STEERING_SCRATCH_ROOT_FILE;
before(() => {
	process.env.PI_STEERING_SCRATCH_ROOT_FILE = offFile;
});
after(() => {
	if (prevScratch === undefined)
		delete process.env.PI_STEERING_SCRATCH_ROOT_FILE;
	else process.env.PI_STEERING_SCRATCH_ROOT_FILE = prevScratch;
	rmSync(scratchDir, { recursive: true, force: true });
});

describe("synthetic-load-guard", () => {
	const harness = loadHarness({ config });

	// --- the two incident shapes (pc-host #1273) --------------------------
	// The literal 383-burn.sh spinner line: a busy loop under 'timeout 300'.
	// A timeout bounds duration, not cores — it is not a cap.
	it("RED: blocks the 383-burn spinner under timeout", async () => {
		await expectBlocks(harness, {
			command:
				'timeout 300 bash -c \'while [ -e "$1" ]; do :; done\' _ /data/tmp/383-burn.flag',
		});
	});
	it("RED: blocks bash 383-burn.sh (body invisible to the bash rule)", async () => {
		await expectBlocks(harness, {
			command: "bash /data/tmp/383-burn.sh /data/tmp/383-burn.flag 24 300",
		});
	});

	// --- shell busy loops ---------------------------------------------------
	it("blocks while :; do :; done via bash -c", async () => {
		await expectBlocks(harness, {
			command: "bash -c 'while :; do :; done'",
		});
	});
	it("blocks while true; do :; done via sh -c", async () => {
		await expectBlocks(harness, {
			command: "sh -c 'while true; do :; done'",
		});
	});
	it("blocks a busy loop under timeout (a timeout is not a cap)", async () => {
		await expectBlocks(harness, {
			command: "timeout 600 bash -c 'while :; do :; done'",
		});
	});
	it("blocks a do true; done body", async () => {
		await expectBlocks(harness, {
			command: "bash -c 'while [ -e /f ]; do true; done'",
		});
	});
	it("blocks for((;;))", async () => {
		await expectBlocks(harness, {
			command: "bash -c 'for((;;)); do :; done'",
		});
	});

	// --- fork loops (pc-host #1340) ------------------------------------------
	// The 2026-11-18 specimen —
	// `( while :; do nc -l 127.0.0.1 $PORT -q 0 < /dev/null & sleep 60 & done ) >/dev/null 2>&1 &`
	// — ran for 1.9 h with 4302 live children: BOTH body commands are
	// backgrounded, so the loop never blocks and the body is never empty
	// (the #1273 patterns above only match an empty body). A `timeout`
	// does not help either: the probe rail reads it as a DURATION bound and
	// lets the fork storm through for its whole runtime, which is exactly
	// how the specimen lasted 1.9 h. Only the cgroup cap is a cap.
	it("RED: blocks a fork loop under a bare timeout (a timeout is not a cap)", async () => {
		await expectBlocks(
			harness,
			{ command: "timeout 60 bash -c 'while :; do nc -l 1 & done'" },
			{ rule: "no-uncapped-synthetic-load", reason: /#1340/ },
		);
	});
	it("blocks a while-true fork loop in a shell payload", async () => {
		await expectBlocks(harness, {
			command: "bash -c 'while true; do x & done'",
		});
	});
	it("blocks a for((;;)) fork loop in a shell payload", async () => {
		await expectBlocks(harness, {
			command: "bash -c 'for ((;;)); do x & done'",
		});
	});
	// KNOWN GAP (see synthetic-load-guard.ts header): the engine hands a
	// predicate ONE ref, never the raw tool-call text, and the walker
	// extracts NO ref that carries the loop for this paste — measured refs
	// are the nameless `PORT=18999` assignment, then `:`,
	// `nc -l 127.0.0.1 $PORT -q 0` and `sleep 60`. The `&` operator
	// and the `done` keyword belong to no ref, so no routed basename can
	// reach the shape and no regex over a ref can fire. The write/edit
	// content rules DO catch the same text (below), and the payload forms
	// are caught by the three cases above. Flip this to expectBlocks once
	// pi-steering exposes the raw command to a predicate — same engine gap
	// probe-scope-guard pins for `(while :; do :; done) &`.
	it("KNOWN GAP: allows the bare #1340 specimen pasted straight to bash", async () => {
		await expectAllows(harness, {
			command:
				"PORT=18999\n( while :; do nc -l 127.0.0.1 $PORT -q 0 < /dev/null & sleep 60 & done ) >/dev/null 2>&1 &",
		});
	});
	it("allows a constant-condition loop with a blocking body", async () => {
		await expectAllows(harness, { command: "while :; do work; done" });
	});
	it("allows a while-read loop that backgrounds each iteration", async () => {
		await expectAllows(harness, {
			command: 'while read -r l; do process "$l" & done < /data/tmp/list',
		});
	});
	it("allows a body joined with && (a separator, not a background job)", async () => {
		await expectAllows(harness, { command: "while :; do a && b; done" });
	});
	it("allows the fork loop inside the capped unit recipe", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --collect -p CPUQuota=200% -p RuntimeMaxSec=60 -p Nice=19 -- bash -c 'while :; do nc -l 1 & done'",
		});
	});

	// --- binary generators ---------------------------------------------------
	it("blocks stress", async () => {
		await expectBlocks(harness, { command: "stress -c 24" });
	});
	it("blocks stress-ng", async () => {
		await expectBlocks(harness, {
			command: "stress-ng --cpu 24 --timeout 60",
		});
	});
	it("blocks yes >/dev/null nested in a payload", async () => {
		await expectBlocks(harness, {
			command: "bash -c 'yes >/dev/null'",
		});
	});
	it("blocks yes > /dev/null under timeout", async () => {
		await expectBlocks(harness, {
			command: "timeout 60 bash -c 'yes > /dev/null'",
		});
	});
	// KNOWN GAP (see synthetic-load-guard.ts header): redirect targets
	// are not part of a ref — the engine exposes only `basename + args`.
	// A top-level `yes >/dev/null` yields a bare `yes` ref, identical
	// to the `yes` of `yes | head -3` (which must stay allowed), so no
	// predicate can split them. Flip to expectBlocks if pi-steering ever
	// exposes redirect targets.
	it("KNOWN GAP: allows a top-level yes >/dev/null", async () => {
		await expectAllows(harness, { command: "yes >/dev/null &" });
	});
	it("KNOWN GAP: allows a top-level yes > /dev/null", async () => {
		await expectAllows(harness, { command: "yes > /dev/null" });
	});

	// --- generator scripts by basename ----------------------------------------
	it("blocks a *hog*.sh script", async () => {
		await expectBlocks(harness, { command: "bash /data/tmp/cpu-hog.sh" });
	});
	it("blocks a *stress*.sh script", async () => {
		await expectBlocks(harness, { command: "sh run-stress.sh" });
	});

	// --- the escapes that are NOT caps ----------------------------------------
	it("blocks nice alone (nice is not a cap)", async () => {
		await expectBlocks(harness, { command: "nice -n 19 stress -c 8" });
	});
	it("blocks systemd-run with neither property", async () => {
		await expectBlocks(harness, {
			command: "systemd-run --user --collect -- bash -c 'while :; do :; done'",
		});
	});
	it("blocks systemd-run with CPUQuota but no RuntimeMaxSec", async () => {
		await expectBlocks(harness, {
			command:
				"systemd-run --user --collect -p CPUQuota=200% -p Nice=19 -- bash -c 'while :; do :; done'",
		});
	});
	it("blocks systemd-run with RuntimeMaxSec but no CPUQuota", async () => {
		await expectBlocks(harness, {
			command:
				"systemd-run --user --collect -p RuntimeMaxSec=300 -- stress -c 8",
		});
	});

	// --- write / edit content --------------------------------------------------
	it("blocks writing a burn script (no CPUQuota= in the body)", async () => {
		await expectBlocks(harness, {
			write: {
				path: "/data/tmp/383-burn.sh",
				content:
					"#!/bin/sh\nfor i in $(seq 24); do\n  timeout 300 bash -c 'while [ -e \"$1\" ]; do :; done' _ \"$1\" &\ndone\nwait\n",
			},
		});
	});
	it("blocks an edit whose newText adds a busy loop", async () => {
		await expectBlocks(harness, {
			edit: {
				path: "/data/tmp/spin.sh",
				edits: [{ oldText: "#!/bin/sh", newText: "#!/bin/sh\nwhile :; do :; done" }],
			},
		});
	});
	it("allows writing a capped script (CPUQuota= in the body)", async () => {
		await expectAllows(harness, {
			write: {
				path: "/data/tmp/load.sh",
				content:
					"#!/bin/sh\n# CPUQuota=200%\nsystemd-run --user --collect -p CPUQuota=200% -p RuntimeMaxSec=300 -p Nice=19 -- bash -c 'while :; do :; done'\n",
			},
		});
	});

	// --- the message names the cap and the shared lane -------------------------
	// A `*burn*.sh` launch is the shape only THIS guard refuses — a
	// bare `while :; do :; done` is also refused by the older
	// no-unbounded-probe rail, which fires first in rule order.
	it("deny message names the allowed unit form and the gate units", async () => {
		await expectBlocks(
			harness,
			{ command: "bash /data/tmp/383-burn.sh /data/tmp/383-burn.flag 24 300" },
			{
				rule: "no-uncapped-synthetic-load",
				reason:
					/pc-host #1273[\s\S]*systemd-run --user --collect -p CPUQuota=200% -p RuntimeMaxSec=300 -p Nice=19[\s\S]*pc-gate\/pc-land\/pc-testop\/pc-ci/,
			},
		);
	});

	// --- the capped form is allowed ---------------------------------------------
	it("allows the full capped systemd-run recipe", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --collect -p CPUQuota=200% -p RuntimeMaxSec=300 -p Nice=19 -- bash -c 'while :; do :; done'",
		});
	});
	it("allows the --property= forms", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --collect --property=CPUQuota=200% --property=RuntimeMaxSec=300 -- stress -c 4",
		});
	});

	// --- ordinary work stays allowed ---------------------------------------------
	it("allows an ordinary while read loop", async () => {
		await expectAllows(harness, {
			command:
				'bash -c \'while read -r l; do echo "$l"; done < /data/tmp/list\'',
		});
	});
	it("allows a bare while read loop", async () => {
		await expectAllows(harness, {
			command: 'while read -r l; do echo "$l"; done < /data/tmp/list',
		});
	});
	it("allows a bounded sleep loop", async () => {
		await expectAllows(harness, {
			command: "bash -c 'for i in 1 2 3; do sleep 1; done'",
		});
	});
	it("allows a while-read sleep loop", async () => {
		await expectAllows(harness, {
			command:
				"bash -c 'while read -r l; do sleep 0.1; done < /data/tmp/list'",
		});
	});
	it("allows yes | head -3", async () => {
		await expectAllows(harness, { command: "yes | head -3" });
	});
	it("allows writing a normal script", async () => {
		await expectAllows(harness, {
			write: {
				path: "/data/tmp/load.sh",
				content: "#!/bin/sh\nfor i in $(seq 4); do echo \"$i\"; done\n",
			},
		});
	});
	it("allows cat of the burn script (read-only is never routed)", async () => {
		await expectAllows(harness, {
			command: "cat /data/tmp/383-burn.sh",
		});
	});
	it("allows an ordinary timeout run", async () => {
		await expectAllows(harness, {
			command: "timeout 600 bash tools/ci.sh",
		});
	});
});

describe("synthetic-load-guard helpers", () => {
	it("reads the cap only when systemd-run carries BOTH properties", () => {
		if (!hasCgroupCap("systemd-run --user -p CPUQuota=200% -p RuntimeMaxSec=300 -- x"))
			throw new Error("both");
		if (hasCgroupCap("systemd-run --user -p CPUQuota=200% -- x"))
			throw new Error("CPUQuota alone");
		if (hasCgroupCap("systemd-run --user -p RuntimeMaxSec=300 -- x"))
			throw new Error("RuntimeMaxSec alone");
		if (hasCgroupCap("nice -n 19 stress -c 8"))
			throw new Error("nice is not a cap");
	});
	it("sees the shape, not bounded work", () => {
		if (isLoadGeneratorShape("bash tools/ci.sh"))
			throw new Error("ci.sh");
		if (isLoadGeneratorShape("yes | head -3"))
			throw new Error("yes | head");
		if (!isLoadGeneratorShape("bash /data/tmp/383-burn.sh"))
			throw new Error("burn.sh");
	});
	it("sees the fork shape, not a blocking body", () => {
		for (const fork of [
			"while :; do nc -l 1 & done",
			"while true; do x & done",
			"for ((;;)); do x & done",
			"bash -c while :; do nc -l 1 & done",
			"while :; do\n  worker &\ndone",
		]) {
			if (!FORK_LOOP.test(fork))
				throw new Error("fork loop missed: " + JSON.stringify(fork));
			if (!isLoadGeneratorShape(fork))
				throw new Error("fork loop not a shape: " + JSON.stringify(fork));
		}
		for (const blocking of [
			"while :; do work; done",
			"while :; do a && b; done",
			"while read l; do x & done",
			"while :; do\n  curl x &\n  wait\ndone",
			"while :; do for i in 1 2; do y; done; done",
		]) {
			if (FORK_LOOP.test(blocking))
				throw new Error("blocking loop flagged: " + JSON.stringify(blocking));
			if (isLoadGeneratorShape(blocking))
				throw new Error(
					"blocking loop is a shape: " + JSON.stringify(blocking),
				);
		}
	});
	it("only the generators and wrappers are routed", () => {
		for (const readOnly of ["cat", "grep", "pgrep", "ps", "ls"]) {
			if ((SYNTHETIC_LOAD_ROUTED as readonly string[]).includes(readOnly))
				throw new Error(
					readOnly + " is read-only inspection and must stay unrouted",
				);
		}
	});
	it("the decision is shape-without-cap", () => {
		if (
			isUncappedSyntheticLoad(
				"systemd-run",
				"systemd-run --user -p CPUQuota=200% -p RuntimeMaxSec=300 -- stress -c 4",
			)
		)
			throw new Error("capped unit flagged");
		if (
			!isUncappedSyntheticLoad(
				"timeout",
				'timeout 300 bash -c \'while [ -e "$1" ]; do :; done\' _ /f',
			)
		)
			throw new Error("timeout spinner not flagged");
	});
});
