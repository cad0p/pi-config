import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import {
	hasCgroupCap,
	isLoadGeneratorShape,
	isUncappedSyntheticLoad,
	SYNTHETIC_LOAD_ROUTED,
} from "./synthetic-load-guard.ts";

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
