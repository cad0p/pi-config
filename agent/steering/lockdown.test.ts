// SPDX-License-Identifier: MIT
// Global pi-steering config — locked-rail tests (red-team F1, 2026-11-03).
//
// The defect, reproduced by the lens: a project layer's `disabledRules` is
// UNIONED with the global layer's (`mergeStringUnion` in the pi-steering
// loader), so a repo whose `.pi/steering/index.ts` says
// `{ disabledRules: ["agents-do-not-merge-directly"] }` deleted the global
// merge guard with no collision, no prompt and no diagnostic — and
// `gh api -X PUT …/pulls/4242/merge` executed.
//
// This file drives the REAL loader with a real project layer on disk and
// the worktree's own global layer (PI_CODING_AGENT_DIR), then proves
// through loadHarness that:
//   - the guard is STILL ACTIVE (a private-repo merge is refused),
//   - the refusal is LOUD (a warning-class `locked-rule-violation`
//     diagnostic naming rule, refusing layer and lock owner),
//   - a legitimate project-layer disable of an UNLOCKED rule still works,
//   - the other four disarm paths (rule override, exemption, plugin
//     disable, failOnWarnings escalation) are refused the same way.
//
// Requires the patched @cad0p/pi-steering (branch
// feat/locked-rules-raw-command) until it ships: the installed 0.2.0
// silently ignores `lockedRules`, which is exactly the fail-open this
// test exists to catch. The package is symlinked into node_modules for
// the prototype; nothing here is activated in the live config.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadSteeringConfig } from "@cad0p/pi-steering";
import {
	createRecordingHost,
	loadHarness,
	mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

const MERGE_GUARD = "agents-do-not-merge-directly";
const PLANT_GUARD = "no-steering-config-write";
const MERGE_MESSAGE = /merge through tools\/merge-pr\.sh/;
const PRIVATE_REPO = "cad0p/pc-host";
const CWD = "/tmp/steering-lockdown";

const projectDirs: string[] = [];
let previousAgentDir: string | undefined;

before(() => {
	// Load THIS worktree's global layer, not the machine's live one: the
	// test must see the config the branch actually carries.
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = resolve(process.cwd(), "..");
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
});

/** Write a real project layer and load the merged config for it. */
async function loadWithProjectLayer(source: string): Promise<{
	config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"];
	diagnostics: Awaited<ReturnType<typeof loadSteeringConfig>>["diagnostics"];
}> {
	const dir = mkdtempSync(join(tmpdir(), "lockdown-"));
	projectDirs.push(dir);
	mkdirSync(join(dir, ".pi", "steering"), { recursive: true });
	writeFileSync(join(dir, ".pi", "steering", "index.ts"), source, "utf8");
	return loadSteeringConfig(dir);
}

/** Host stub: every repo resolves PRIVATE, so the guard's gate is on. */
function host() {
	const ok = (stdout: string): ExecResult => ({
		stdout,
		stderr: "",
		code: 0,
		killed: false,
	});
	const fail: ExecResult = { stdout: "", stderr: "", code: 1, killed: false };
	return createRecordingHost({
		exec: (cmd, args) => {
			if (cmd === "gh" && args[0] === "api") {
				const endpoint = /^repos\/([^/]+\/[^/]+)$/.exec(args[1] ?? "");
				if (endpoint !== null) return Promise.resolve(ok("true"));
				return Promise.resolve(fail);
			}
			if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
				return Promise.resolve(
					ok(JSON.stringify({ nameWithOwner: PRIVATE_REPO, isPrivate: true })),
				);
			}
			return Promise.resolve(fail);
		},
	});
}

interface Verdict {
	block: boolean;
	rule: string | null;
	reason: string;
}

async function evaluate(
	config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"],
	toolName: "bash" | "write" | "edit",
	input: Record<string, unknown>,
): Promise<Verdict> {
	const h = host();
	const ctx = mockExtensionContext(CWD, h.entries);
	const harness = loadHarness({ config, host: h });
	const event = {
		type: "tool_call",
		toolCallId: "tc1",
		toolName,
		input,
	} as unknown as Parameters<typeof harness.evaluate>[0];
	const result = await harness.evaluate(event, ctx, 1);
	if (result === undefined || result === null || result.block !== true) {
		return { block: false, rule: null, reason: "" };
	}
	const raw = result.reason ?? "";
	const reason = typeof raw === "string" ? raw : String(raw);
	const match = reason.match(/(?:^|\n)\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
	return { block: true, rule: match ? match[1] : null, reason };
}

function violations(
	diagnostics: Awaited<ReturnType<typeof loadSteeringConfig>>["diagnostics"],
): Array<{ type: string; message: string }> {
	return diagnostics.filter((d) => d.kind === "locked-rule-violation");
}

describe("locked rails — the F1 reproduction", () => {
	it("a project-layer disabledRules on the merge guard is refused LOUDLY and the guard still blocks", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { disabledRules: ["${MERGE_GUARD}"] };`,
		);

		// The lock held: the rule is still in the merged config and the
		// refused disable did not survive the union.
		assert.ok(
			(config.rules ?? []).some((r) => r.name === MERGE_GUARD),
			"the locked merge guard must stay in the merged config",
		);
		assert.ok(
			!(config.disabledRules ?? []).includes(MERGE_GUARD),
			"the refused disable must not appear in merged.disabledRules",
		);

		// Loud: warning-class (error-class would abort the whole runtime and
		// hand a project layer a denial-of-steering kill switch).
		const hits = violations(diagnostics);
		assert.equal(hits.length, 1, JSON.stringify(diagnostics));
		assert.equal(hits[0]?.type, "warning");
		assert.match(hits[0]?.message ?? "", new RegExp(`locked rule "${MERGE_GUARD}"`));
		assert.match(hits[0]?.message ?? "", /locked by layer #1/);
		assert.match(hits[0]?.message ?? "", /stays active/);

		// Effective behaviour: the lens's REST merge route is refused.
		const rest = await evaluate(config, "bash", {
			command: `gh api -X PUT repos/${PRIVATE_REPO}/pulls/4242/merge`,
		});
		assert.deepEqual(
			{ block: rest.block, rule: rest.rule },
			{ block: true, rule: MERGE_GUARD },
			"the REST merge endpoint must still be refused by the live guard",
		);
		assert.match(rest.reason, MERGE_MESSAGE);

		const cli = await evaluate(config, "bash", {
			command: `gh pr merge 4242 -R ${PRIVATE_REPO}`,
		});
		assert.deepEqual(
			{ block: cli.block, rule: cli.rule },
			{ block: true, rule: MERGE_GUARD },
		);
	});

	it("a legitimate project-layer disable of an UNLOCKED rule still works", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { disabledRules: ["no-rm-rf-slash"] };`,
		);
		assert.deepEqual(violations(diagnostics), []);
		assert.ok(
			!(config.rules ?? []).some((r) => r.name === "no-rm-rf-slash"),
			"the unlocked shipped rule is filtered out of the merged config",
		);
		const rm = await evaluate(config, "bash", { command: "rm -rf /" });
		assert.equal(
			rm.block,
			false,
			"with the rule disabled the call is allowed (the documented customization path)",
		);
	});

	it("the plant guard cannot itself be disabled by a project layer", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { disabledRules: ["${PLANT_GUARD}"] };`,
		);
		assert.equal(violations(diagnostics).length, 1);
		const plant = await evaluate(config, "write", {
			path: "/data/work/pc-host/.pi/steering/index.ts",
			content: 'export default { disabledRules: ["agents-do-not-merge-directly"] };',
		});
		assert.deepEqual(
			{ block: plant.block, rule: plant.rule },
			{ block: true, rule: PLANT_GUARD },
			"a project layer that deletes the plant guard must not win",
		);
		// Bail wording: the file itself is unwritable through the bash route
		// too (redirect included), so the F1 payload cannot be planted.
		const redirect = await evaluate(config, "bash", {
			command: `echo 'export default { disabledRules: ["${MERGE_GUARD}"] };' > .pi/steering/index.ts`,
		});
		assert.deepEqual(
			{ block: redirect.block, rule: redirect.rule },
			{ block: true, rule: "no-steering-config-bash-mutation" },
		);
	});
});

describe("locked rails — the other disarm paths", () => {
	it("a project-layer rule OVERRIDE of the merge guard is refused; the locked definition wins", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { rules: [{ name: "${MERGE_GUARD}", tool: "bash", command: "gh", when: { condition: () => false }, reason: "project shadow (never fires)" }] };`,
		);
		const hits = violations(diagnostics);
		assert.equal(hits.length, 1, JSON.stringify(diagnostics));
		assert.match(hits[0]?.message ?? "", /override of locked rule/);
		const merge = await evaluate(config, "bash", {
			command: `gh pr merge 4242 -R ${PRIVATE_REPO}`,
		});
		assert.deepEqual(
			{ block: merge.block, rule: merge.rule },
			{ block: true, rule: MERGE_GUARD },
			"the locked body (not the project shadow) must decide the verdict",
		);
		assert.match(merge.reason, MERGE_MESSAGE);
	});

	it("a project-layer EXEMPTION targeting the merge guard is dropped", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { exemptions: [{ rule: "${MERGE_GUARD}", when: { condition: () => true } }] };`,
		);
		assert.equal(violations(diagnostics).length, 1, JSON.stringify(diagnostics));
		assert.equal(
			(config.exemptions ?? []).some((e) => e.rule === MERGE_GUARD),
			false,
			"the project carve-out must not reach the merged exemption registry",
		);
		const merge = await evaluate(config, "bash", {
			command: `gh pr merge 4242 -R ${PRIVATE_REPO}`,
		});
		assert.deepEqual(
			{ block: merge.block, rule: merge.rule },
			{ block: true, rule: MERGE_GUARD },
		);
	});

	it("a project-layer defaultNoOverride:false cannot make a locked rule overridable", async () => {
		// The override-comment path: with `defaultNoOverride: false` an agent
		// appends `# steering-override: <rule>` and the block is waived.
		const { config, diagnostics } = await loadWithProjectLayer(
			"export default { defaultNoOverride: false };",
		);
		assert.equal(
			config.defaultNoOverride,
			true,
			"the lock-declaring layer's defaultNoOverride=true governs",
		);
		assert.equal(violations(diagnostics).length, 1, JSON.stringify(diagnostics));
		const merge = await evaluate(config, "bash", {
			command: `gh pr merge 4242 -R ${PRIVATE_REPO} # steering-override: ${MERGE_GUARD}`,
		});
		assert.deepEqual(
			{ block: merge.block, rule: merge.rule },
			{ block: true, rule: MERGE_GUARD },
			"the override comment must be rejected, not honored",
		);
	});

	it("a project-layer failOnWarnings escalation cannot abort the rails", async () => {
		// failOnWarnings: true turns ANY warning (including the refusal
		// diagnostic) into a thrown abort that builds no runtime at all —
		// the kill switch that would make the lock cosmetic.
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { disabledRules: ["${MERGE_GUARD}"], failOnWarnings: true };`,
		);
		assert.equal(
			config.failOnWarnings,
			false,
			"the lock-declaring layer's failOnWarnings=false governs",
		);
		const hits = violations(diagnostics);
		assert.ok(
			hits.some((h) => /ignoring failOnWarnings=true/.test(h.message)),
			JSON.stringify(hits),
		);
		const merge = await evaluate(config, "bash", {
			command: `gh pr merge 4242 -R ${PRIVATE_REPO}`,
		});
		assert.deepEqual(
			{ block: merge.block, rule: merge.rule },
			{ block: true, rule: MERGE_GUARD },
		);
	});
});

describe("locked rails — unlocked configs are unchanged", () => {
	it("a project layer with no disables loads with zero violation diagnostics", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			"export default {};",
		);
		assert.deepEqual(violations(diagnostics), []);
		assert.ok(
			(config.lockedRules ?? []).includes(MERGE_GUARD),
			"the global layer still declares the lock",
		);
	});
});
