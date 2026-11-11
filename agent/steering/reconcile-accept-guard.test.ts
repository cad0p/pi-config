// SPDX-License-Identifier: MIT
// reconcile-accept-guard tests — an incident acceptance is an owner action.
//
// The ruling (2026-11-11, owner): "sudo-gated accept but I think a steering
// rule is enough honestly". tools/reconcile.sh accept takes any non-empty
// string as the quote, and an accepted unrecorded-merge incident is what lets
// the helper's provenance check treat an unrecorded main commit as recorded —
// the clean sweep then writes helper-trusted-sha, the code the gate runs on
// this host. Two owner --admin merges (#905, #916) opened incidents on
// 2026-11-11 and the agent accepted both with a quote the owner had typed in
// chat. No command is executed here: the harness only evaluates the verdict.
//
// KNOWN GAPS pinned at the end (see the module header): an interpreter outside
// the routed set (zsh, timeout, …), a script path held entirely in a variable,
// and a shell redirect or writer into the trust-state files.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const ACCEPT = "no-reconcile-accept";
const WRITE = "no-pc-merge-trust-state-write";
const EDIT = "no-pc-merge-trust-state-edit";

const STATE = "/home/pier/.local/state/pc-merge";
const TRUSTED_SHA = STATE + "/helper-trusted-sha";
const INCIDENTS_FLAT = STATE + "/incidents.json";
const INCIDENTS = STATE + "/incidents/cad0p--pc-host.json";
const CERT_ALERT = STATE + "/cert-alert.json";

describe("reconcile-accept-guard", () => {
	const harness = loadHarness({ config });

	it("registers without a predicate or descriptor collision", () => {
		assert.deepEqual(
			harness.diagnostics
				.filter((d) => /reconcile/i.test(d.message))
				.map((d) => d.message),
			[],
		);
	});

	// ---- refused: the acceptance itself, in every spelling ----

	it("blocks the incident shape (cd + bash tools/reconcile.sh accept)", async () => {
		await expectBlocks(
			harness,
			{
				command:
					"cd /home/pier/personal/github/pc-host && bash tools/reconcile.sh accept i20261111T230920Z-2106313 'do it'",
			},
			{ rule: ACCEPT },
		);
	});
	it("blocks a bare relative path invocation", async () => {
		await expectBlocks(
			harness,
			{ command: "tools/reconcile.sh accept i20261111T230920Z-2106313 'quote'" },
			{ rule: ACCEPT },
		);
	});
	it("blocks a ./ path invocation", async () => {
		await expectBlocks(
			harness,
			{ command: "./tools/reconcile.sh accept i1 'q'" },
			{ rule: ACCEPT },
		);
	});
	it("blocks an absolute path invocation", async () => {
		await expectBlocks(
			harness,
			{ command: "/home/pier/personal/github/pc-host/tools/reconcile.sh accept i1 'q'" },
			{ rule: ACCEPT },
		);
	});
	it("blocks an acceptance nested in sh -c", async () => {
		await expectBlocks(
			harness,
			{ command: "sh -c \"bash tools/reconcile.sh accept i1 'q'\"" },
			{ rule: ACCEPT },
		);
	});
	it("blocks an acceptance nested in bash -c after a cd", async () => {
		await expectBlocks(
			harness,
			{
				command:
					"bash -c 'cd /home/pier/personal/github/pc-host && tools/reconcile.sh accept i1 q'",
			},
			{ rule: ACCEPT },
		);
	});
	it("blocks a shell flag before the script", async () => {
		await expectBlocks(
			harness,
			{ command: "bash -e tools/reconcile.sh accept i1 q" },
			{ rule: ACCEPT },
		);
	});
	it("blocks a shell value-flag before the script (-o errexit)", async () => {
		await expectBlocks(
			harness,
			{ command: "bash -o errexit tools/reconcile.sh accept i1 q" },
			{ rule: ACCEPT },
		);
	});
	it("blocks under the sudo passthrough", async () => {
		await expectBlocks(
			harness,
			{ command: "sudo bash tools/reconcile.sh accept i1 q" },
			{ rule: ACCEPT },
		);
	});
	it("blocks under the env passthrough", async () => {
		await expectBlocks(
			harness,
			{ command: "env PC_MERGE_STATE_ROOT=/x bash tools/reconcile.sh accept i1 q" },
			{ rule: ACCEPT },
		);
	});
	it("blocks under the nice passthrough", async () => {
		await expectBlocks(
			harness,
			{ command: "nice -n 10 bash tools/reconcile.sh accept i1 q" },
			{ rule: ACCEPT },
		);
	});
	it("blocks a variable-held prefix with a literal last segment", async () => {
		await expectBlocks(
			harness,
			{ command: 'bash "$REPO/tools/reconcile.sh" accept i1 q' },
			{ rule: ACCEPT },
		);
	});
	it("blocks an acceptance with an empty quote (the tool still records it)", async () => {
		await expectBlocks(
			harness,
			{ command: "tools/reconcile.sh accept i1 ''" },
			{ rule: ACCEPT },
		);
	});
	it("refuses accept --help (fail-closed: the subcommand is accept)", async () => {
		await expectBlocks(
			harness,
			{ command: "tools/reconcile.sh accept --help" },
			{ rule: ACCEPT },
		);
	});

	// ---- allowed: every other subcommand ----

	it("allows sweep", async () => {
		await expectAllows(harness, { command: "bash tools/reconcile.sh sweep" });
	});
	it("allows sweep run as a script path", async () => {
		await expectAllows(harness, { command: "tools/reconcile.sh sweep" });
	});
	it("allows incident", async () => {
		await expectAllows(harness, {
			command: "tools/reconcile.sh incident cad0p/pc-host deadbeef setup-drift",
		});
	});
	it("allows --help through the shell", async () => {
		await expectAllows(harness, { command: "bash tools/reconcile.sh --help" });
	});
	it("allows --help on the script", async () => {
		await expectAllows(harness, { command: "tools/reconcile.sh --help" });
	});
	it("allows a bare invocation (usage, exit 2)", async () => {
		await expectAllows(harness, { command: "tools/reconcile.sh" });
	});
	it("allows a plain shell command (the bash/sh descriptor stays usable)", async () => {
		await expectAllows(harness, { command: "bash -c 'echo hi'" });
	});
	it("allows a plain shell command with flags", async () => {
		await expectAllows(harness, { command: "bash -euo pipefail -c 'echo hi'" });
	});

	// ---- refused: the trust state through the write / edit tools ----

	it("blocks write of helper-trusted-sha", async () => {
		await expectBlocks(
			harness,
			{ write: { path: TRUSTED_SHA, content: "28bdaa8d\n" } },
			{ rule: WRITE },
		);
	});
	it("blocks write of the flat incidents.json", async () => {
		await expectBlocks(
			harness,
			{ write: { path: INCIDENTS_FLAT, content: "[]" } },
			{ rule: WRITE },
		);
	});
	it("blocks write of a per-repo incidents file", async () => {
		await expectBlocks(
			harness,
			{ write: { path: INCIDENTS, content: "[]" } },
			{ rule: WRITE },
		);
	});
	it("blocks edit of helper-trusted-sha", async () => {
		await expectBlocks(
			harness,
			{
				edit: {
					path: TRUSTED_SHA,
					edits: [{ oldText: "28bdaa8d", newText: "deadbeef" }],
				},
			},
			{ rule: EDIT },
		);
	});
	it("blocks edit of the flat incidents.json", async () => {
		await expectBlocks(
			harness,
			{ edit: { path: INCIDENTS_FLAT, edits: [] } },
			{ rule: EDIT },
		);
	});
	it("blocks edit of a per-repo incidents file", async () => {
		await expectBlocks(
			harness,
			{
				edit: {
					path: INCIDENTS,
					edits: [{ oldText: '"status":"open"', newText: '"status":"accepted"' }],
				},
			},
			{ rule: EDIT },
		);
	});

	// ---- allowed: siblings in the same directory ----

	it("allows write of cert-alert.json", async () => {
		await expectAllows(harness, {
			write: { path: CERT_ALERT, content: "{}" },
		});
	});
	it("allows edit of cert-alert.json", async () => {
		await expectAllows(harness, { edit: { path: CERT_ALERT, edits: [] } });
	});
	it("allows write of last-clean-sweep.json", async () => {
		await expectAllows(harness, {
			write: { path: STATE + "/last-clean-sweep.json", content: "{}" },
		});
	});
	it("does not match a same-named file outside a pc-merge directory", async () => {
		await expectAllows(harness, {
			write: { path: "/data/tmp/notes/incidents.json", content: "[]" },
		});
	});

	// ---- KNOWN GAPS (module header): pinned, not papered over ----

	it("KNOWN GAP: an interpreter outside the routed set is not seen (zsh)", async () => {
		await expectAllows(harness, {
			command: "zsh tools/reconcile.sh accept i1 q",
		});
	});
	it("KNOWN GAP: a non-wrapper launcher is not seen (timeout)", async () => {
		await expectAllows(harness, {
			command: "timeout 30 bash tools/reconcile.sh accept i1 q",
		});
	});
	it("KNOWN GAP: a script path held entirely in a variable is not seen", async () => {
		await expectAllows(harness, { command: 'bash "$TOOL" accept i1 q' });
	});
	it("KNOWN GAP: a redirect into the trust state is not seen (targets unexposed)", async () => {
		await expectAllows(harness, {
			command: "printf '28bdaa8d\\n' > ~/.local/state/pc-merge/helper-trusted-sha",
		});
	});
	it("KNOWN GAP: a shell writer into the trust state is not seen (jq + mv)", async () => {
		await expectAllows(harness, {
			command:
				"jq '(0).status=\"accepted\"' ~/.local/state/pc-merge/incidents/cad0p--pc-host.json > /tmp/i.json && mv /tmp/i.json ~/.local/state/pc-merge/incidents/cad0p--pc-host.json",
		});
	});
});
