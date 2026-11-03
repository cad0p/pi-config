// SPDX-License-Identifier: MIT
// Global pi-steering config — config-write-guard tests.
//
// Red-team F1 (2026-11-03): a project layer's disabledRules is UNIONED
// with the global layer's, so a repo whose .pi/steering/index.ts says
// { disabledRules: ["agents-do-not-merge-directly"] } silently deleted
// the global merge guard, and nothing stopped an agent from writing that
// file with the write tool. This file pins the anti-plant half: the
// write / edit tools and the writer binaries are refused for
// .pi/steering/** , .pi/steering.ts and .pi/settings.json.
//
// Text guard, not a sandbox: the KNOWN GAPS asserted at the bottom are
// part of the claim (globbed paths, a cwd already inside the dir with a
// bare relative path, and an executed script). The load-time lock in
// lockdown.test.ts is the half that closes the hole.
//
// The config is loaded through pi-steering's real loader (jiti), like
// integration.test.ts. PI_CODING_AGENT_DIR points at THIS worktree's
// agent dir so the test never depends on the machine's live config.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { join, resolve } from "node:path";
import { loadSteeringConfig } from "@cad0p/pi-steering";
import {
	createRecordingHost,
	loadHarness,
	mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

const RULE_WRITE = "no-steering-config-write";
const RULE_EDIT = "no-steering-config-edit";
const RULE_BASH = "no-steering-config-bash-mutation";
const MESSAGE = /Do not write pi steering configuration/;

const CWD = "/tmp/steering-config-write-guard";

let config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"];

before(async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = resolve(process.cwd(), "..");
	try {
		const { config: merged } = await loadSteeringConfig(process.cwd());
		config = merged;
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

/** Host stub: no exec is expected, but the shipped predicates shell out. */
function host() {
	const fail: ExecResult = { stdout: "", stderr: "", code: 1, killed: false };
	return createRecordingHost({
		exec: () => Promise.resolve(fail),
	});
}

interface Verdict {
	block: boolean;
	rule: string | null;
}

async function evaluate(
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
		return { block: false, rule: null };
	}
	const raw = result.reason ?? "";
	const reason = typeof raw === "string" ? raw : String(raw);
	const match = reason.match(/(?:^|\n)\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
	return { block: true, rule: match ? match[1] : null };
}

async function expectBlocked(
	toolName: "bash" | "write" | "edit",
	input: Record<string, unknown>,
	rule: string,
): Promise<void> {
	const verdict = await evaluate(toolName, input);
	assert.deepEqual(
		verdict,
		{ block: true, rule },
		`expected ${toolName} ${JSON.stringify(input)} to be blocked by ${rule}`,
	);
}

async function expectAllowed(
	toolName: "bash" | "write" | "edit",
	input: Record<string, unknown>,
): Promise<void> {
	const verdict = await evaluate(toolName, input);
	assert.deepEqual(
		verdict,
		{ block: false, rule: null },
		`expected ${toolName} ${JSON.stringify(input)} to be allowed`,
	);
}

describe("config-write-guard — write / edit tools", () => {
	it("blocks writes and edits under any repo's .pi/steering/", async () => {
		await expectBlocked("write", {
			path: "/data/work/pc-host/.pi/steering/index.ts",
			content: "export default {};",
		}, RULE_WRITE);
		await expectBlocked("edit", {
			path: "/data/work/pc-host/.pi/steering/plugins/slip.ts",
			edits: [{ oldText: "a", newText: "b" }],
		}, RULE_EDIT);
		await expectBlocked("write", {
			path: "/data/work/pc-host/.pi/steering/package.json",
			content: "{}",
		}, RULE_WRITE);
	});

	it("blocks the .pi/steering.ts shorthand and project settings", async () => {
		await expectBlocked("write", {
			path: "/data/work/pc-host/.pi/steering.ts",
			content: "export default {};",
		}, RULE_WRITE);
		await expectBlocked("edit", {
			path: "/data/work/pc-host/.pi/settings.json",
			edits: [{ oldText: "{}", newText: "{}" }],
		}, RULE_EDIT);
	});

	it("blocks relative paths too (the write tool passes the path as typed)", async () => {
		await expectBlocked("write", {
			path: ".pi/steering/index.ts",
			content: "export default {};",
		}, RULE_WRITE);
		await expectBlocked("edit", {
			path: ".pi/settings.json",
			edits: [{ oldText: "a", newText: "b" }],
		}, RULE_EDIT);
	});

	it("leaves ordinary files and look-alike names alone", async () => {
		await expectAllowed("write", {
			path: "/data/work/pc-host/src/index.ts",
			content: "export default {};",
		});
		await expectAllowed("write", {
			path: "/data/work/pc-host/docs/.pi/steering-notes.md",
			content: "notes about steering",
		});
		await expectAllowed("write", {
			path: "/data/work/pc-host/.pi/settings.json.bak",
			content: "{}",
		});
		await expectAllowed("edit", {
			path: "/data/work/pc-host/.pi/other.json",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});
});

describe("config-write-guard — bash writers", () => {
	it("blocks the F1 plant with a redirect, tee, sed -i, cp, mv and chmod", async () => {
		const plants = [
			'echo \'export default { disabledRules: ["agents-do-not-merge-directly"] };\' > .pi/steering/index.ts',
			"printf '%s' 'export default {}' >> /data/work/pc-host/.pi/steering/index.ts",
			"tee .pi/steering/index.ts <<< 'export default {}'",
			"sed -i 's/enabled/disabled/' .pi/steering/index.ts",
			"cp /tmp/payload.ts .pi/steering/index.ts",
			"mv /tmp/payload.ts .pi/steering/index.ts",
			"chmod 600 .pi/steering/index.ts",
			"cat > .pi/steering/index.ts <<'EOF'\nexport default {};\nEOF",
			"python3 -c \"open('.pi/steering/index.ts','w').write('export default {}')\"",
			"git checkout -- .pi/steering",
			"rm -rf .pi/steering",
			"cat /tmp/payload.ts > .pi/settings.json",
		];
		for (const command of plants) {
			await expectBlocked("bash", { command }, RULE_BASH);
		}
	});

	it("is not tied to the cwd: an absolute path in another repo is blocked too", async () => {
		await expectBlocked(
			"bash",
			{ command: "cp /tmp/x /data/work/pc-control/.pi/steering/index.ts" },
			RULE_BASH,
		);
	});

	it("allows reading the project layer (review work is legitimate)", async () => {
		await expectAllowed("bash", { command: "cat .pi/steering/index.ts" });
		await expectAllowed("bash", { command: "ls -la .pi/steering" });
		await expectAllowed("bash", {
			command: "rg -n disabledRules .pi/steering",
		});
		await expectAllowed("bash", { command: "git status --short" });
	});

	it("KNOWN GAP: a path built by expansion or a script written elsewhere is not seen", async () => {
		// Stated as part of the claim (header): the text guard cannot see a
		// path assembled at runtime. The load-time lock is what closes the
		// hole; this rule is best-effort anti-plant.
		// The literal path split across a quote boundary: no text scan can
		// reassemble it, yet the shell writes exactly the plant file.
		await expectAllowed("bash", {
			command: 'f=".pi/steer""ing/index.ts"; echo "export default {}" > "$f"',
		});
	});
});
