import { describe, it } from "node:test";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";
import {
	commandOperand,
	execStartRunsScratchScriptPredicate,
	expandPath,
	isReservedUnitName,
	isUnderScratchRoot,
	RESERVED_UNIT_REASON,
	RESERVED_UNIT_NAME,
	runsMergeToolVerb,
	SCRATCH_ROOTS,
	SCRIPT_EXECSTART_REASON,
	scriptOperand,
	unitNameOf,
} from "./unit-name-guard.ts";

const HOME = homedir();
const STATE = HOME + "/.local/state/h4-orchestration";
const BOUND = "-p RuntimeMaxSec=600";

describe("unit-name-guard — the pure helpers", () => {
	it("reads --unit=value, --unit value, -u value and -uVALUE", () => {
		assert.equal(unitNameOf(["--unit=pc-gate-a"]), "pc-gate-a");
		assert.equal(unitNameOf(["--unit", "pc-land-1"]), "pc-land-1");
		assert.equal(unitNameOf(["-u", "pc-q7"]), "pc-q7");
		assert.equal(unitNameOf(["-upc-q7"]), "pc-q7");
		assert.equal(unitNameOf(["--quiet"]), null);
	});

	it("stops at '--' (an ExecStart's argv is not unit-name space)", () => {
		assert.equal(unitNameOf(["--", "bash", "-c", "--unit=pc-gate-x"]), null);
	});

	it("treats a dynamically built unit name as unreadable", () => {
		assert.equal(unitNameOf(["--unit=$U"]), null);
		assert.equal(unitNameOf(["--unit=" + String.fromCharCode(36) + "(n)"]), null);
	});

	it("reserves exactly the four merge-unit stems", () => {
		for (const name of [
			"pc-gate-xbx1",
			"pc-gate-xbx1.service",
			"pc-gate",
			"pc-land-517",
			"pc-queue-3",
			"pc-q7",
			"pc-preflight-9",
		]) {
			assert.equal(isReservedUnitName(name), true, name);
		}
		for (const name of [
			"pc-ci-foo",
			"pc-mlux-ci-foo",
			"pc-testop-2",
			"pc-probe-r3",
			"pc-wt-host-1",
			"my-unit",
			"pc-gates",
			"",
			null,
		]) {
			assert.equal(isReservedUnitName(name), false, String(name));
		}
		assert.equal(
			RESERVED_UNIT_NAME.test("pc-gates"),
			false,
			"pc-gates is not pc-gate-*",
		);
	});

	it("reads a merge-tool verb, including merge-run.sh's '-- queue land'", () => {
		assert.equal(runsMergeToolVerb("bash merge-run.sh gate cad0p/pc-host 4 x"), true);
		assert.equal(
			runsMergeToolVerb(
				"merge-run.sh r1 note.md -- queue land cad0p/pc-tenant",
			),
			true,
		);
		assert.equal(runsMergeToolVerb("tools/merge-pr.sh preflight cad0p/pc-host"), true);
		assert.equal(runsMergeToolVerb("tools/merge-pr.sh absorb cad0p/pc-host 7"), true);
		assert.equal(runsMergeToolVerb("tools/merge-pr.sh train-gate cad0p/pc-tenant 598:aa 603:bb"), true);
		assert.equal(runsMergeToolVerb("tools/merge-pr.sh train cad0p/pc-tenant"), true);
		assert.equal(runsMergeToolVerb("tools/merge-pr.sh trainx cad0p/pc-tenant"), false);
		// no verb after the tool
		assert.equal(runsMergeToolVerb("merge-run.sh r1 note.md -- dispatch"), false);
		// no merge tool at all
		assert.equal(runsMergeToolVerb("pc-admit.sh run --container tools/ci.sh"), false);
		// the tool name alone is not a verb
		assert.equal(runsMergeToolVerb("cat merge-pr.sh"), false);
		// a unit name or a note path containing a verb word is not the verb
		assert.equal(
			runsMergeToolVerb(
				"systemd-run --unit=pc-gate-x merge-run.sh r1 gate-notes.md -- dispatch",
			),
			false,
		);
	});

	it("finds the command operand after '--' or the first non-flag word", () => {
		assert.deepEqual(
			commandOperand(["--user", "--unit=pc-ci-x", "--", "bash", "-c", "x"]),
			["bash", "-c", "x"],
		);
		assert.deepEqual(
			commandOperand(["--user", "-p", "RuntimeMaxSec=600", "bash", "x.sh"]),
			["bash", "x.sh"],
		);
		assert.deepEqual(commandOperand(["--user", "--collect"]), []);
	});

	it("names the script operand for the shell forms, null for inline", () => {
		assert.equal(scriptOperand(["bash", "-c", "echo hi"]), null);
		assert.equal(scriptOperand(["bash", "-c", "cat a.sh"]), null);
		assert.equal(scriptOperand(["bash", "/data/tmp/x/a.sh"]), "/data/tmp/x/a.sh");
		assert.equal(scriptOperand(["/usr/bin/bash", "/x/a.sh"]), "/x/a.sh");
		assert.equal(scriptOperand(["sh", "/x/a.sh", "arg"]), "/x/a.sh");
		assert.equal(scriptOperand(["env", "-u", "U", "bash", "/x/a.sh"]), "/x/a.sh");
		assert.equal(scriptOperand(["nice", "-n", "5", "bash", "/x/a.sh"]), "/x/a.sh");
		assert.equal(scriptOperand(["timeout", "60", "bash", "/x/a.sh"]), "/x/a.sh");
		assert.equal(scriptOperand(["/data/tmp/x/run.sh"]), "/data/tmp/x/run.sh");
		assert.equal(scriptOperand(["/usr/bin/python3", "x.py"]), null);
		assert.equal(scriptOperand(["bash", "$S"]), null);
	});

	it("expands ~ and $HOME, and tests the roots", () => {
		assert.equal(expandPath("~/.cache/a"), HOME + "/.cache/a");
		assert.equal(
			expandPath("$HOME/.local/state/h4-orchestration/a"),
			STATE + "/a",
		);
		assert.equal(isUnderScratchRoot("/data/tmp/x/a.sh"), true);
		assert.equal(isUnderScratchRoot("/data/tmp"), true);
		assert.equal(isUnderScratchRoot("/data/tmpfoo/a.sh"), false);
		assert.equal(isUnderScratchRoot(STATE + "/tmp-1319/a2-four.sh"), true);
		assert.equal(isUnderScratchRoot(HOME + "/.cache/x.sh"), true);
		assert.equal(
			isUnderScratchRoot(HOME + "/personal/github/pc-host/tools/ci.sh"),
			false,
		);
		assert.equal(SCRATCH_ROOTS.length, 3);
	});

	it("the reason texts teach: the namespace, the CI name, the inline form", () => {
		assert.match(RESERVED_UNIT_REASON, /pc-ci-<label>/);
		assert.match(RESERVED_UNIT_REASON, /merge-run\.sh/);
		assert.match(RESERVED_UNIT_REASON, /queue land cad0p\/pc-host/);
		assert.match(SCRIPT_EXECSTART_REASON, /bash -c/);
		assert.match(SCRIPT_EXECSTART_REASON, /a2-four\.service/);
		assert.match(SCRIPT_EXECSTART_REASON, /tools\/\*\.sh/);
	});
});

describe("unit-name-guard — rule A (reserved gate/land/queue names)", () => {
	const harness = loadHarness({ config });

	// --- RED: the two specimens from 2026-11-23 ---------------------------
	it("RED: blocks the xbx1 shape — a CI run named pc-gate-", async () => {
		await expectBlocks(
			harness,
			{
				command:
					"systemd-run --user --wait --collect --pipe --unit=pc-gate-xbx1 " +
					BOUND +
					" -- bash -c 'pc-admit.sh run --container tools/ci.sh --container'",
			},
			{ rule: "unit-name-gate-reserved", reason: /pc-ci-<label>/ },
		);
	});

	it("GREEN: allows the merge-run.sh gate recipe", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=pc-gate-517 " +
				BOUND +
				" --working-directory=" +
				HOME +
				"/.local/share/pc-merge/pc-host -- bash " +
				HOME +
				"/personal/github/Goldmine/Scripts/orchestration/merge-run.sh gate " +
				HOME +
				"/personal/github/Goldmine/personal/github/pc-host/notes/r1.md -- gate cad0p/pc-host 517 abc1234",
		});
	});

	it("GREEN: allows the queue land recipe (pc-land-)", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=pc-land-517 -p RuntimeMaxSec=3600 -- bash " +
				HOME +
				"/personal/github/Goldmine/Scripts/orchestration/merge-run.sh r1 note.md -- queue land cad0p/pc-tenant",
		});
	});

	it("GREEN: allows a preflight unit through merge-pr.sh", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=pc-preflight-42 " +
				BOUND +
				" -- bash -c 'tools/merge-pr.sh preflight cad0p/pc-host'",
		});
	});

	it("allows a CI run named pc-ci-<label> with tools/ci.sh", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --collect --unit=pc-ci-sitesfix3 " +
				BOUND +
				" --working-directory=" +
				HOME +
				"/personal/github/pc-host -- bash tools/ci.sh --container",
		});
	});

	it("allows a pc-mlux-ci-<label> run", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --collect --unit=pc-mlux-ci-r2 " +
				BOUND +
				" -- bash tools/ci.sh",
		});
	});

	it("allows a probe/testop/wt unit (not a merge name)", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --wait --unit=pc-probe-r3 " + BOUND + " -- bash v.sh",
		});
	});

	it("allows any unit without a merge name", async () => {
		await expectAllows(harness, {
			command: "systemd-run --user --unit=nightly-reap " + BOUND + " -- pc-wt reap",
		});
	});

	it("blocks the separate-value and short spellings too", async () => {
		await expectBlocks(harness, {
			command: "systemd-run --unit pc-gate-x " + BOUND + " -- pc-admit.sh run",
		});
		await expectBlocks(harness, {
			command: "systemd-run -u pc-q7 " + BOUND + " -- pc-admit.sh run",
		});
		await expectBlocks(harness, {
			command: "systemd-run -upc-land-9 " + BOUND + " -- pc-admit.sh run",
		});
	});

	it("blocks a .service suffix on a reserved stem", async () => {
		await expectBlocks(harness, {
			command: "systemd-run --user --unit=pc-queue-3.service " + BOUND + " -- pc-admit.sh run",
		});
	});

	it("blocks a reserved name whose merge tool has no verb", async () => {
		await expectBlocks(harness, {
			command:
				"systemd-run --user --unit=pc-gate-x " +
				BOUND +
				" -- bash -c 'merge-run.sh r1 note.md -- dispatch'",
		});
	});

	it("blocks the shape nested in bash -c (codemode's bash call)", async () => {
		await expectBlocks(harness, {
			command:
				"bash -c \"systemd-run --user --unit=pc-gate-xbx1 " +
				BOUND +
				" -- bash -c 'pc-admit.sh run tools/ci.sh'\"",
		});
	});

	it("allows the gate shape nested in bash -c", async () => {
		await expectAllows(harness, {
			command:
				"bash -c \"systemd-run --user --unit=pc-gate-9 " +
				BOUND +
				" -- bash -c 'tools/merge-pr.sh gate cad0p/pc-host 9 abc'\"",
		});
	});

	it("allows a dynamically named unit (unreadable — pinned gap)", async () => {
		await expectAllows(harness, {
			command: "systemd-run --user --unit=$U " + BOUND + " -- pc-admit.sh run",
		});
	});

	it("ignores text that merely mentions a reserved unit", async () => {
		await expectAllows(harness, {
			command: "grep -rn 'pc-gate-xbx1' /data/tmp/x/gate.log",
		});
	});
});

describe("unit-name-guard — rule B (no scratch/state script ExecStart)", () => {
	const harness = loadHarness({ config });

	it("RED: blocks the a2-four shape (/usr/bin/bash + a state-dir script)", async () => {
		await expectBlocks(
			harness,
			{
				command:
					"systemd-run --user --unit=a2-four.service " +
					BOUND +
					" -- /usr/bin/bash " +
					STATE +
					"/tmp-1319/a2-four.sh",
			},
			{ rule: "systemd-run-no-script-execstart", reason: /bash -c/ },
		);
	});

	it("blocks bash + a /data/tmp script", async () => {
		await expectBlocks(harness, {
			command: "systemd-run --user --unit=lane-x " + BOUND + " -- bash /data/tmp/lane-x/run.sh",
		});
	});

	it("blocks sh + a ~/.cache script", async () => {
		await expectBlocks(harness, {
			command: "systemd-run --user --unit=lane-x " + BOUND + " -- sh ~/.cache/x/s.sh",
		});
	});

	it("blocks $HOME/.cache script", async () => {
		await expectBlocks(harness, {
			command:
				"systemd-run --user --unit=lane-x " + BOUND + " -- bash $HOME/.cache/x/s.sh",
		});
	});

	it("blocks the path itself as the command", async () => {
		await expectBlocks(harness, {
			command: "systemd-run --user --unit=lane-x " + BOUND + " -- /data/tmp/x/run.sh",
		});
	});

	it("blocks a relative script when the cwd is a scratch root", async () => {
		await expectBlocks(harness, {
			command: "systemd-run --user --unit=lane-x " + BOUND + " -- bash a2-four.sh",
			cwd: "/data/tmp/lane-x",
		});
	});

	it("allows the inline form — nothing to hide", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=pc-ci-foo " +
				BOUND +
				" -- bash -c 'git worktree add /data/tmp/x/wt main && tools/ci.sh --container'",
		});
	});

	it("allows a tracked repo tool via --working-directory", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=pc-ci-unit " +
				BOUND +
				" --working-directory=" +
				HOME +
				"/personal/github/pc-host -- bash tools/pc-ci-unit.sh",
		});
	});

	it("allows the vault's merge-run.sh script", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=pc-land-3 " +
				BOUND +
				" -- bash " +
				HOME +
				"/personal/github/Goldmine/Scripts/orchestration/merge-run.sh r1 note.md -- land cad0p/pc-host",
		});
	});

	it("allows a checkout's absolute tools/*.sh", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=pc-ci-x " +
				BOUND +
				" -- /usr/bin/bash " +
				HOME +
				"/personal/github/pc-host/tools/ci.sh --container",
		});
	});

	it("allows a relative script when the cwd is a checkout", async () => {
		await expectAllows(harness, {
			command: "systemd-run --user --unit=pc-ci-x " + BOUND + " -- bash tools/ci.sh",
			cwd: HOME + "/personal/github/pc-host",
		});
	});

	it("does not route a plain bash call outside systemd-run (pinned scope)", async () => {
		await expectAllows(harness, {
			command: "bash /data/tmp/lane-x/run.sh",
		});
	});

	it("allows a dynamically built script path (pinned gap)", async () => {
		await expectAllows(harness, {
			command: "systemd-run --user --unit=lane-x " + BOUND + " -- bash $S",
		});
	});

	it("does not route a non-shell script (python3) — pinned gap", async () => {
		await expectAllows(harness, {
			command: "systemd-run --user --unit=lane-x " + BOUND + " -- python3 /data/tmp/x/a.py",
		});
	});

	it("leaves a command-less unit alone", async () => {
		await expectAllows(harness, {
			command:
				"systemd-run --user --unit=reap-daily --on-active=60 -p RuntimeMaxSec=600",
		});
	});
});

describe("unit-name-guard — registration", () => {
	const harness = loadHarness({ config });

	it("loads with no error-class diagnostics", () => {
		const errors = harness.diagnostics.filter((d) => d.type === "error");
		assert.deepEqual(errors, []);
	});

	it("ships both rules and both predicates", () => {
		const names = (harness.config.rules ?? []).map((r) => r.name);
		assert.ok(names.includes("unit-name-gate-reserved"), names.join(","));
		assert.ok(names.includes("systemd-run-no-script-execstart"), names.join(","));
		assert.equal(typeof execStartRunsScratchScriptPredicate, "function");
	});
});
