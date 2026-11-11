import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import {
	hasRuntimeMaxSec,
	hasTimeoutBound,
	isEndlessSleep,
	isProbeShape,
	PROBE_LAUNCHERS,
	probeIsUnbounded,
	READ_ONLY_INSPECTION,
} from "./probe-scope-guard.ts";

describe("probe-scope-guard", () => {
	const harness = loadHarness({ config });

	// --- RED/GREEN PAIR: the incident -------------------------------------
	//
	// The literal 2026-11-11 line, with the 57-byte script body INLINED so
	// the loop text is in the command (the engine exposes one ref's
	// `basename + args` — never the `&` operator, never a script's
	// body; see the pin at the bottom of this file for the file form).
	it("RED: blocks the incident probe, loop inlined", async () => {
		await expectBlocks(harness, {
			command:
				"bash -c 'trap \"echo RAN > /tmp/probe/r3\" EXIT; while :; do :; done' & p=$!; sleep 0.5; kill -INT $p",
		});
	});
	it("GREEN: the same probe under a 900 s unit is allowed", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --wait --collect --pipe --unit=pc-probe-r3 --property=RuntimeMaxSec=900 -- bash -c 'trap \"echo RAN > /tmp/probe/r3\" EXIT; while :; do :; done' & p=$!; sleep 0.5; kill -INT $p",
		});
	});

	// --- unbounded busy waits ---------------------------------------------
	it("blocks a foreground while :; do loop", async () => {
		await expectBlocks(harness, { command: "bash -c 'while :; do :; done'" });
	});
	it("blocks while true; do via sh -c", async () => {
		await expectBlocks(harness, { command: "sh -c 'while true; do :; done'" });
	});
	it("blocks while [ 1 ]", async () => {
		await expectBlocks(harness, { command: "bash -c 'while [ 1 ]; do :; done'" });
	});
	it("blocks for((;;))", async () => {
		await expectBlocks(harness, { command: "bash -c 'for((;;)); do :; done'" });
	});
	it("blocks a sleep that outlives any turn", async () => {
		await expectBlocks(harness, { command: "sleep infinity" });
	});
	it("blocks a gigantic numeric sleep", async () => {
		await expectBlocks(harness, { command: "sleep 999999" });
	});

	// --- detached launches ------------------------------------------------
	it("blocks setsid", async () => {
		await expectBlocks(harness, { command: "setsid bash v.sh" });
	});
	it("blocks nohup with a background marker", async () => {
		await expectBlocks(harness, { command: "nohup bash v.sh >/dev/null 2>&1 &" });
	});
	it("blocks python start_new_session=True", async () => {
		await expectBlocks(harness, {
			command:
				"python3 -c 'import subprocess; subprocess.Popen([\"bash\", \"v.sh\"], start_new_session=True)'",
		});
	});
	it("blocks systemd-run without RuntimeMaxSec", async () => {
		await expectBlocks(harness, {
			command:
				"systemd-run --user --wait --collect --pipe --unit=pc-probe-a -- bash v.sh",
		});
	});

	// --- a fake bound is not a bound --------------------------------------
	it("blocks systemd-run with RuntimeMaxSec=0 (unlimited)", async () => {
		await expectBlocks(harness, {
			command:
				"systemd-run --user --unit=pc-probe-a --property=RuntimeMaxSec=0 -- bash -c 'while :; do :; done'",
		});
	});
	it("blocks timeout 0 (GNU coreutils: no limit)", async () => {
		await expectBlocks(harness, {
			command: "timeout 0 bash -c 'while :; do :; done'",
		});
	});
	it("blocks timeout infinity", async () => {
		await expectBlocks(harness, {
			command: "timeout infinity bash -c 'while :; do :; done'",
		});
	});

	// --- the bound shapes are allowed -------------------------------------
	it("allows timeout <n>", async () => {
		await expectAllows(harness, {
			command: "timeout 900 bash -c 'while :; do :; done'",
		});
	});
	it("allows timeout with an smhd suffix", async () => {
		await expectAllows(harness, {
			command: "timeout 30s bash -c 'while true; do :; done'",
		});
	});
	it("allows the systemd-run RuntimeMaxSec recipe", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --wait --collect --pipe --unit=pc-probe-a --property=RuntimeMaxSec=900 -- bash v.sh",
		});
	});
	it("allows a PC_PROBE_BOUNDED=1 prefix", async () => {
		await expectAllows(harness, {
			command: "PC_PROBE_BOUNDED=1 bash -c 'while :; do :; done'",
		});
	});
	it("allows an exported PC_PROBE_BOUNDED=1", async () => {
		await expectAllows(harness, {
			command: "export PC_PROBE_BOUNDED=1 && bash -c 'while true; do :; done'",
		});
	});

	// --- read-only inspection is never routed ------------------------------
	it("allows grep with the loop pattern as a quoted argument", async () => {
		await expectAllows(harness, { command: "grep -rn 'while :; do' docs/" });
	});
	it("allows ps | grep -i of the loop pattern", async () => {
		await expectAllows(harness, { command: "ps aux | grep -i 'while true; do'" });
	});
	it("allows pgrep -a", async () => {
		await expectAllows(harness, { command: "pgrep -a bash" });
	});
	it("allows cat of the probe script", async () => {
		await expectAllows(harness, { command: "cat /tmp/probe/v.sh" });
	});
	it("allows ls of the probe directory", async () => {
		await expectAllows(harness, { command: "ls -la /tmp/probe" });
	});

	// --- ordinary commands stay allowed ------------------------------------
	it("allows a short sleep", async () => {
		await expectAllows(harness, { command: "sleep 5" });
	});
	it("allows killing the probe it started", async () => {
		await expectAllows(harness, { command: "kill -INT $p" });
	});
	it("allows a repo script whose body is not read", async () => {
		await expectAllows(harness, { command: "bash tools/ci.sh" });
	});
	it("allows python without a new session", async () => {
		await expectAllows(harness, { command: "python3 -c 'print(1)'" });
	});

	// --- KNOWN GAP, pinned -------------------------------------------------
	//
	// The engine hands a predicate ONE command ref (`basename + args`),
	// never the raw tool-call text: the `&` operator belongs to no ref and
	// v.sh's body belongs to no ref either. The literal incident line is
	// therefore three innocuous refs, and this rule cannot see it. Reading
	// the named script is deliberately not done — pc-host's own
	// tools/merge-pr.sh, tools/converge.sh, tools/lib/pc-admission.sh carry
	// eight legitimate `while :; do` retry loops, so a body scan would
	// refuse real CI. Flip this to expectBlocks if the engine ever exposes
	// the raw command (or the `&` operator) to predicates.
	it("KNOWN GAP: allows the literal incident line (loop lives in v.sh)", async () => {
		await expectAllows(harness, {
			command: "bash v.sh & p=\$!; sleep 0.5; kill -INT \$p",
		});
	});
	it("KNOWN GAP: allows a subshell background job (no ref extracted)", async () => {
		await expectAllows(harness, { command: "(while :; do :; done) &" });
	});
});

describe("probe-scope-guard helpers", () => {
	it("reads a positive timeout, not timeout 0", () => {
		if (!hasTimeoutBound("timeout 900 bash -c x")) throw new Error("900");
		if (hasTimeoutBound("timeout 0 bash -c x")) throw new Error("0 is no limit");
	});
	it("reads a positive RuntimeMaxSec, not 0", () => {
		if (!hasRuntimeMaxSec("--property=RuntimeMaxSec=900")) throw new Error("900");
		if (hasRuntimeMaxSec("--property=RuntimeMaxSec=0")) throw new Error("0");
	});
	it("scales sleep suffixes", () => {
		if (!isEndlessSleep("sleep 999999")) throw new Error("999999");
		if (!isEndlessSleep("sleep 15m")) throw new Error("15m");
		if (isEndlessSleep("sleep 0.5")) throw new Error("0.5");
	});
	it("does not mistake a bounded ref for a probe", () => {
		if (isProbeShape("bash tools/ci.sh")) throw new Error("ci.sh");
		if (!isProbeShape("bash -c while :; do :; done")) throw new Error("loop");
	});
	it("never routes a read-only inspection tool", () => {
		for (const readOnly of READ_ONLY_INSPECTION) {
			if ((PROBE_LAUNCHERS as readonly string[]).includes(readOnly))
				throw new Error(
					`${readOnly} is read-only inspection and must stay unrouted`,
				);
		}
	});
	it("stays silent on a bounded systemd-run", () => {
		if (
			probeIsUnbounded(
				"systemd-run",
				"systemd-run --user --property=RuntimeMaxSec=900 -- bash v.sh",
				{},
			)
		)
			throw new Error("bounded unit flagged");
		if (
			!probeIsUnbounded(
				"systemd-run",
				"systemd-run --user --unit=x -- bash v.sh",
				{},
			)
		)
			throw new Error("unbounded unit not flagged");
	});
});
