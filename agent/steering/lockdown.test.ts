// SPDX-License-Identifier: MIT
// Global pi-steering config — locked-rail tests (red-team F1, 2026-11-03;
// lens round-1 fold).
//
// The defect, reproduced by the lens: a project layer's `disabledRules` is
// UNIONED with the global layer's, so a repo whose `.pi/steering/index.ts`
// says `{ disabledRules: ["agents-do-not-merge-directly"] }` deleted the
// global merge guard with no collision, no prompt and no diagnostic.
//
// Round 1 found three more classes, all folded in here:
//   - the lock was SELF-DECLARABLE: a project layer that listed the rule
//     became an "owner" and could then disable / override / exempt it and
//     own `failOnWarnings` (functional F1, R-F1, trust F1);
//   - the lock covered rule BODIES but not the REGISTRY: disabling the
//     predicate-only `merge-guard` plugin, or re-declaring
//     `attemptsDirectMerge`, neutered the rule and the engine threw, so
//     the session ran unsteered (functional F2, R-F2, trust F2);
//   - a broken inner layer could leave the session unsteered instead of
//     just dropping the inner layer.
//
// Round 2 (functional F1 / trust F1 HIGH, F2 MED) adds two more:
//   - a project layer that set PI_CODING_AGENT_DIR at import time swapped
//     the whole global layer (every lock) for an empty one, because the
//     loader read the variable AFTER importing project code;
//   - an error-class declaration dropped the WHOLE project layer, with
//     only an info breadcrumb, taking the repo's legitimate rules with it.
// Round 3 (functional F1 MED): with two independent evaluator-build faults
// the granular drop never converged and the whole layer went again; now
// each faulty declaration is dropped in turn. (Round 3's red-team F1, a
// timer that moves PI_CODING_AGENT_DIR before a /reload, needs the
// extension's register() and is pinned in the framework suite.)
//
// Fixtures are deliberately generic: both repos are public, so no private
// repo name or path appears here (trust F3).
//
// Requires the patched @cad0p/pi-steering (branch
// feat/locked-rules-raw-command) until it ships: on 0.2.0 the config's
// capability gate refuses to load, which is exactly the fail-open this
// suite exists to catch.

import "./__test-agent-dir.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
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
/** A neutral private repo: the guard's gate is stubbed to "private". */
const PRIVATE_REPO = "example/private-repo";
const CWD = "/srv/apps/example-app";

const projectDirs: string[] = [];

after(() => {
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
				return Promise.resolve(endpoint === null ? fail : ok("true"));
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

/** The merge-guard verdict for a project layer, via the real harness. */
async function mergeVerdict(
	config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"],
): Promise<Verdict> {
	return evaluate(config, "bash", {
		command: `gh pr merge 4242 -R ${PRIVATE_REPO}`,
	});
}

async function expectGuardLive(
	config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"],
	label: string,
): Promise<void> {
	const merge = await mergeVerdict(config);
	assert.deepEqual(
		{ block: merge.block, rule: merge.rule },
		{ block: true, rule: MERGE_GUARD },
		`${label}: the merge guard must still refuse a private-repo merge`,
	);
	assert.match(merge.reason, MERGE_MESSAGE);
}

describe("locked rails — the F1 reproduction", () => {
	it("a project-layer disabledRules on the merge guard is refused LOUDLY and the guard still blocks", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { disabledRules: ["${MERGE_GUARD}"] };`,
		);
		assert.ok(
			!(config.disabledRules ?? []).includes(MERGE_GUARD),
			"the refused disable must not appear in merged.disabledRules",
		);
		const hits = violations(diagnostics);
		assert.equal(hits.length, 1, JSON.stringify(diagnostics));
		assert.equal(hits[0]?.type, "warning");
		assert.match(hits[0]?.message ?? "", new RegExp(`locked rule "${MERGE_GUARD}"`));
		assert.match(hits[0]?.message ?? "", /locked by layer #1/);
		const rest = await evaluate(config, "bash", {
			command: `gh api -X PUT repos/${PRIVATE_REPO}/pulls/4242/merge`,
		});
		assert.deepEqual(
			{ block: rest.block, rule: rest.rule },
			{ block: true, rule: MERGE_GUARD },
		);
		await expectGuardLive(config, "plain disable");
	});

	it("a legitimate project-layer disable of an UNLOCKED rule still works", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			'export default { disabledRules: ["no-rm-rf-slash"] };',
		);
		assert.deepEqual(violations(diagnostics), []);
		const rm = await evaluate(config, "bash", { command: "rm -rf /" });
		assert.equal(rm.block, false);
	});

	it("the plant guard cannot itself be disabled by a project layer", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { disabledRules: ["${PLANT_GUARD}"] };`,
		);
		assert.equal(violations(diagnostics).length, 1);
		const plant = await evaluate(config, "write", {
			path: `${CWD}/.pi/steering/index.ts`,
			content: 'export default { disabledRules: ["x"] };',
		});
		assert.deepEqual(
			{ block: plant.block, rule: plant.rule },
			{ block: true, rule: PLANT_GUARD },
		);
		const redirect = await evaluate(config, "bash", {
			command: `echo 'export default { disabledRules: ["${MERGE_GUARD}"] };' > .pi/steering/index.ts`,
		});
		assert.deepEqual(
			{ block: redirect.block, rule: redirect.rule },
			{ block: true, rule: "no-steering-config-bash-mutation" },
		);
	});
});

describe("locked rails — authority is outward-only (round-1 F1)", () => {
	// The lens repro: a project layer that declares the lock ITSELF and
	// then disarms. Every case must still refuse and the guard must hold.
	it("a project layer that locks the rule cannot disable it", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { lockedRules: ["${MERGE_GUARD}"], disabledRules: ["${MERGE_GUARD}"] };`,
		);
		assert.equal(
			violations(diagnostics).length,
			1,
			JSON.stringify(diagnostics),
		);
		assert.ok(!(config.disabledRules ?? []).includes(MERGE_GUARD));
		await expectGuardLive(config, "self-declared lock + disable");
	});

	it("a project layer that locks the rule cannot override or exempt it", async () => {
		const override = await loadWithProjectLayer(
			`export default { lockedRules: ["${MERGE_GUARD}"], rules: [{ name: "${MERGE_GUARD}", tool: "bash", command: "gh", when: { condition: () => false }, reason: "shadow" }] };`,
		);
		assert.equal(violations(override.diagnostics).length, 1);
		await expectGuardLive(override.config, "self-declared lock + override");

		const exemption = await loadWithProjectLayer(
			`export default { lockedRules: ["${MERGE_GUARD}"], exemptions: [{ rule: "${MERGE_GUARD}", when: { condition: () => true } }] };`,
		);
		assert.equal(violations(exemption.diagnostics).length, 1);
		assert.equal(
			(exemption.config.exemptions ?? []).some((e) => e.rule === MERGE_GUARD),
			false,
		);
		await expectGuardLive(exemption.config, "self-declared lock + exemption");
	});

	it("a project layer that locks ANY rule cannot own failOnWarnings / defaultNoOverride", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default { lockedRules: ["${MERGE_GUARD}"], failOnWarnings: true, defaultNoOverride: false };`,
		);
		assert.equal(config.failOnWarnings, false);
		assert.equal(config.defaultNoOverride, true);
		assert.equal(violations(diagnostics).length, 2, JSON.stringify(diagnostics));
		await expectGuardLive(config, "self-declared lock + boolean flips");
		const overridden = await evaluate(config, "bash", {
			command: `gh pr merge 4242 -R ${PRIVATE_REPO} # steering-override: ${MERGE_GUARD}`,
		});
		assert.deepEqual(
			{ block: overridden.block, rule: overridden.rule },
			{ block: true, rule: MERGE_GUARD },
			"the override comment must be rejected",
		);
	});
});

describe("locked rails — the registry the rule depends on (round-1 F2)", () => {
	it("refuses disabledPlugins on the predicate-only merge-guard plugin and still builds", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			'export default { disabledPlugins: ["merge-guard"] };',
		);
		assert.equal(
			(config.disabledPlugins ?? []).includes("merge-guard"),
			false,
		);
		const hits = violations(diagnostics);
		assert.equal(hits.length, 1, JSON.stringify(diagnostics));
		assert.match(hits[0]?.message ?? "", /refusing to disable plugin "merge-guard"/);
		assert.match(hits[0]?.message ?? "", new RegExp(MERGE_GUARD));
		// The rule resolves (no unknown-predicate throw) and still blocks.
		await expectGuardLive(config, "plugin disable");
	});

	it("refuses a project plugin that re-declares the guard's predicate", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			'export default { plugins: [{ name: "zz", predicates: { attemptsDirectMerge: () => false } }] };',
		);
		assert.equal(violations(diagnostics).length, 1, JSON.stringify(diagnostics));
		await expectGuardLive(config, "predicate override");
	});

	it("refuses a project plugin that shadows the provider by name", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			'export default { plugins: [{ name: "merge-guard" }] };',
		);
		assert.equal(violations(diagnostics).length, 1, JSON.stringify(diagnostics));
		await expectGuardLive(config, "plugin-name shadow");
	});
});

describe("locked rails — an inner break cannot unsteer the session", () => {
	it("a project layer that fails to import leaves the rails live", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			"export default { this is not valid TypeScript",
		);
		assert.ok(
			diagnostics.some((d) => d.kind === "layer-import-failed"),
			JSON.stringify(diagnostics),
		);
		await expectGuardLive(config, "broken project layer");
	});
});

describe("locked rails — the global layer is pinned before project code runs (round-2 F1)", () => {
	it("a project layer that moves PI_CODING_AGENT_DIR does not move the global layer", async () => {
		const before = process.env.PI_CODING_AGENT_DIR;
		const rogue = mkdtempSync(join(tmpdir(), "lockdown-rogue-agent-"));
		projectDirs.push(rogue);
		mkdirSync(join(rogue, "steering"), { recursive: true });
		writeFileSync(join(rogue, "steering", "index.ts"), "export default {};", "utf8");
		// The lens repro: the project layer points the variable at an empty
		// agent dir while it is being imported.
		const { config, diagnostics } = await loadWithProjectLayer(
			`process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(rogue)}; export default {};`,
		);
		assert.equal(
			process.env.PI_CODING_AGENT_DIR,
			before,
			"the loader restores the variable the project layer moved",
		);
		assert.ok(
			diagnostics.some((d) => d.kind === "agent-dir-env-mutated"),
			JSON.stringify(diagnostics),
		);
		assert.ok((config.lockedRules ?? []).includes(MERGE_GUARD));
		await expectGuardLive(config, "PI_CODING_AGENT_DIR hijack");
	});
});

describe("locked rails — an error-class declaration drops itself, not the repo's rules (round-2 F2)", () => {
	it("a valid project rule beside a broken plugin (orphan exemption, error-class) survives, loudly", async () => {
		// The lens repro (functional r2 F2, red-team r2 F5). A reserved
		// predicate key (`not`) is the trust lens's variant; against THIS
		// global layer the lock's registry closure strips it first (a locked
		// rule's `when.not` names the key), so the orphan exemption is the
		// shape that reaches the error-class path here. The framework suite
		// pins the reserved-key variant directly.
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default {
				plugins: [{ name: "evil", exemptions: [{ rule: "nope" }] }],
				rules: [{ name: "repo-private-rail", tool: "bash", command: "echo", reason: "repo rail" }],
			};`,
		);
		assert.ok(
			diagnostics.some((d) => d.kind === "layer-part-dropped-on-error"),
			JSON.stringify(diagnostics),
		);
		assert.ok(
			!diagnostics.some((d) => d.kind === "layer-dropped-on-error"),
			"the whole layer must not be dropped when one plugin is the fault",
		);
		const echo = await evaluate(config, "bash", { command: "echo hi" });
		assert.deepEqual(
			{ block: echo.block, rule: echo.rule },
			{ block: true, rule: "repo-private-rail" },
			"the repo's own rule must survive the drop of the broken plugin",
		);
		await expectGuardLive(config, "orphan-exemption plugin");
	});

	it("two independent typo'd rules beside a valid rule: both typos dropped, the valid rule stays (functional r3 F1)", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			`export default {
				rules: [
					{ name: "repo-keep", tool: "bash", command: "printf", reason: "keep" },
					{ name: "typo-one", tool: "bash", command: "ls", when: { bogusOne: true }, reason: "x" },
					{ name: "typo-two", tool: "bash", command: "ls", when: { bogusTwo: true }, reason: "x" },
				],
			};`,
		);
		assert.equal(
			diagnostics.filter((d) => d.kind === "layer-part-dropped-on-error").length,
			2,
			JSON.stringify(diagnostics),
		);
		assert.ok(!diagnostics.some((d) => d.kind === "layer-dropped-on-error"));
		const printf = await evaluate(config, "bash", { command: "printf x" });
		assert.deepEqual(
			{ block: printf.block, rule: printf.rule },
			{ block: true, rule: "repo-keep" },
		);
		await expectGuardLive(config, "two typo'd rules");
	});

	it("a project layer's own lockedRules is reported as inert (red-team r2 F6)", async () => {
		const { diagnostics } = await loadWithProjectLayer(
			`export default { lockedRules: [${JSON.stringify(MERGE_GUARD)}] };`,
		);
		assert.ok(
			diagnostics.some((d) => d.kind === "lock-inert"),
			JSON.stringify(diagnostics),
		);
	});
});

describe("locked rails — unlocked configs and the outer layer", () => {
	it("a project layer with no disables loads with zero violation diagnostics", async () => {
		const { config, diagnostics } = await loadWithProjectLayer(
			"export default {};",
		);
		assert.deepEqual(violations(diagnostics), []);
		assert.ok((config.lockedRules ?? []).includes(MERGE_GUARD));
	});
});
