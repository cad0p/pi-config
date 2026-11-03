// SPDX-License-Identifier: MIT
// Global pi-steering config — config-write-guard tests.
//
// Red-team F1 (2026-11-03): a project layer's disabledRules is UNIONED
// with the global layer's, so a repo whose .pi/steering/index.ts says
// { disabledRules: ["agents-do-not-merge-directly"] } silently deleted
// the global merge guard, and nothing stopped an agent from writing that
// file with the write tool. Round 1 (R-F3) added three one-character
// bypasses of the first cut: .pi//steering, .pi/./steering, and a
// redirect written with no space after >. This file pins the canonical
// coverage AND the declared gaps.
//
// The guard's own claim is a TABLE, not "everything": every row below is
// either blocked or explicitly allowed as a documented gap.

import "./__test-agent-dir.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
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

const CWD = "/srv/apps/example-app";
const REPO = `${CWD}`;
/** A pi-config worktree: the sanctioned place to author config. */
const WORKTREE = "/srv/work/pi-config-branch/agent/steering/index.ts";

let config: Awaited<ReturnType<typeof loadSteeringConfig>>["config"];

before(async () => {
	const { config: merged, diagnostics } = await loadSteeringConfig(
		process.cwd(),
	);
	const errors = diagnostics.filter((d) => d.type === "error");
	assert.deepEqual(
		errors.map((d) => d.message),
		[],
		"the global config must load without error diagnostics",
	);
	config = merged;
});

/** Host stub: no exec is expected, but the shipped predicates shell out. */
function host() {
	const fail: ExecResult = { stdout: "", stderr: "", code: 1, killed: false };
	return createRecordingHost({ exec: () => Promise.resolve(fail) });
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
		await expectBlocked(
			"write",
			{ path: `${REPO}/.pi/steering/index.ts`, content: "export default {};" },
			RULE_WRITE,
		);
		await expectBlocked(
			"edit",
			{
				path: `${REPO}/.pi/steering/plugins/slip.ts`,
				edits: [{ oldText: "a", newText: "b" }],
			},
			RULE_EDIT,
		);
		await expectBlocked(
			"write",
			{ path: `${REPO}/.pi/steering/package.json`, content: "{}" },
			RULE_WRITE,
		);
	});

	it("blocks the .pi/steering.ts shorthand and project settings", async () => {
		await expectBlocked(
			"write",
			{ path: `${REPO}/.pi/steering.ts`, content: "export default {};" },
			RULE_WRITE,
		);
		await expectBlocked(
			"edit",
			{
				path: `${REPO}/.pi/settings.json`,
				edits: [{ oldText: "{}", newText: "{}" }],
			},
			RULE_EDIT,
		);
	});

	it("blocks relative paths too (the write tool passes the path as typed)", async () => {
		await expectBlocked(
			"write",
			{ path: ".pi/steering/index.ts", content: "export default {};" },
			RULE_WRITE,
		);
		await expectBlocked(
			"edit",
			{ path: ".pi/settings.json", edits: [{ oldText: "a", newText: "b" }] },
			RULE_EDIT,
		);
	});

	it("normalises // and ./ and .. spellings (R-F3)", async () => {
		for (const path of [
			".pi//steering/index.ts",
			".pi/./steering/index.ts",
			".pi/plugins/../steering/index.ts",
			`${REPO}//.pi//steering//index.ts`,
		]) {
			await expectBlocked(
				"write",
				{ path, content: "export default {};" },
				RULE_WRITE,
			);
		}
	});

	it("resolves a symlinked .pi directory before matching", async () => {
		const dir = mkdtempSync(join(tmpdir(), "writeguard-"));
		try {
			mkdirSync(join(dir, "real", ".pi", "steering"), { recursive: true });
			writeFileSync(join(dir, "real", ".pi", "steering", "index.ts"), "export default {};");
			symlinkSync(join(dir, "real", ".pi"), join(dir, "link"));
			await expectBlocked(
				"write",
				{ path: join(dir, "link", "steering", "index.ts"), content: "x" },
				RULE_WRITE,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("blocks the GLOBAL layer and the installed framework source (R-F4)", async () => {
		await expectBlocked(
			"write",
			{ path: "/root/.pi/agent/steering/index.ts", content: "export default {};" },
			RULE_WRITE,
		);
		await expectBlocked(
			"edit",
			{
				path: "/root/.pi/agent/steering/merge-guard.ts",
				edits: [{ oldText: "a", newText: "b" }],
			},
			RULE_EDIT,
		);
		await expectBlocked(
			"write",
			{
				path: "/root/.pi/agent/npm/node_modules/.pnpm/@cad0p+pi-steering@0.2.0/node_modules/@cad0p/pi-steering/src/loader.ts",
				content: "// neutered lock",
			},
			RULE_WRITE,
		);
	});

	it("leaves ordinary files, look-alike names and the config WORKTREE alone", async () => {
		await expectAllowed("write", {
			path: `${REPO}/src/index.ts`,
			content: "export default {};",
		});
		await expectAllowed("write", {
			path: `${REPO}/docs/.pi/steering-notes.md`,
			content: "notes about steering",
		});
		await expectAllowed("write", {
			path: `${REPO}/.pi/settings.json.bak`,
			content: "{}",
		});
		await expectAllowed("edit", {
			path: `${REPO}/.pi/other.json`,
			edits: [{ oldText: "a", newText: "b" }],
		});
		await expectAllowed("write", { path: WORKTREE, content: "export default {};" });
	});
});

describe("config-write-guard — bash writers", () => {
	it("blocks the F1 plant with a redirect, tee, sed -i, cp, mv, chmod, heredoc and an interpreter", async () => {
		const plant = 'export default { disabledRules: ["agents-do-not-merge-directly"] };';
		const plants = [
			`echo '${plant}' > .pi/steering/index.ts`,
			// R-F3: no space after the redirect.
			`echo x >.pi/steering/index.ts`,
			// R-F3: doubled separator on the tee target.
			`echo x | tee .pi//steering/index.ts`,
			"printf '%s' 'export default {}' >> .pi/steering/index.ts",
			"tee .pi/steering/index.ts <<< 'export default {}'",
			"sed -i 's/enabled/disabled/' .pi/steering/index.ts",
			"cp /tmp/payload.ts .pi/steering/index.ts",
			"mv /tmp/payload.ts .pi/steering/index.ts",
			"chmod 600 .pi/steering/index.ts",
			"cat > .pi/steering/index.ts <<'EOF'\nexport default {};\nEOF",
			`python3 -c "open('.pi/steering/index.ts','w').write('export default {}')"`,
			"git checkout -- .pi/steering",
			"rm -rf .pi/steering",
			"cat /tmp/payload.ts > .pi/settings.json",
			"cp /tmp/x /srv/apps/example-app/.pi//settings.json",
		];
		for (const command of plants) {
			await expectBlocked("bash", { command }, RULE_BASH);
		}
	});

	it("blocks the global layer and the installed framework source through bash too", async () => {
		await expectBlocked(
			"bash",
			{ command: "echo 'export default {};' > /root/.pi/agent/steering/index.ts" },
			RULE_BASH,
		);
		await expectBlocked(
			"bash",
			{
				command:
					"sed -i 's/lockedRules/lockedRulez/' /root/.pi/agent/npm/node_modules/.pnpm/@cad0p+pi-steering@0.2.0/node_modules/@cad0p/pi-steering/src/loader.ts",
			},
			RULE_BASH,
		);
	});

	it("is not tied to the cwd: an absolute path in another repo is blocked too", async () => {
		await expectBlocked(
			"bash",
			{ command: "cp /tmp/x /srv/apps/other-repo/.pi/steering/index.ts" },
			RULE_BASH,
		);
	});

	it("allows reading the project layer (review work is legitimate)", async () => {
		await expectAllowed("bash", { command: "cat .pi/steering/index.ts" });
		await expectAllowed("bash", { command: "ls -la .pi/steering" });
		await expectAllowed("bash", { command: "rg -n disabledRules .pi/steering" });
		await expectAllowed("bash", { command: "git status --short" });
		await expectAllowed("bash", { command: "sed -n '1,20p' agent/steering/index.ts" });
	});

	it("covers <agentDir>/settings.json and the pi-steering-<x> packages (the table says so)", async () => {
		// Red-team r2 F7: the round-1 header listed these as NOT covered.
		await expectBlocked(
			"bash",
			{ command: "echo '{}' > /root/.pi/agent/settings.json" },
			RULE_BASH,
		);
		await expectBlocked(
			"write",
			{
				path: "/root/.pi/agent/npm/node_modules/@cad0p/pi-steering-github/dist/index.js",
				content: "x",
			},
			RULE_WRITE,
		);
	});
});

// ---------------------------------------------------------------------------
// TRIPWIRE GAPS. The guard is a tripwire for honest mistakes, not a
// boundary (header). Every row below is a writer or path shape it does
// NOT see, pinned as ALLOWED so the header's "does not catch" table and
// the code cannot drift apart. A row turning BLOCKED is fine only with
// the header updated in the same commit; do not grow the writer list or
// the path list to chase these one by one (three lens rounds showed the
// space is open).
// ---------------------------------------------------------------------------

describe("config-write-guard — declared tripwire gaps (pinned ALLOWED)", () => {
	const GLOBAL = "/root/.pi/agent";

	it("a path built at runtime or split across a quote boundary", async () => {
		await expectAllowed("bash", {
			command: 'f=".pi/steer""ing/index.ts"; echo "export default {}" > "$f"',
		});
	});

	it("r2 F1: a redirect from an unlisted program, or from no program", async () => {
		for (const command of [
			`> ${GLOBAL}/steering/index.ts`,
			`: > ${GLOBAL}/steering/index.ts`,
			`jq -rn '"export default {}"' > ${GLOBAL}/steering/index.ts`,
			`yes x | head -1 > ${GLOBAL}/steering/index.ts`,
		]) {
			await expectAllowed("bash", { command });
		}
	});

	it("r2 F2: a relative target whose own token has no .pi segment", async () => {
		await expectAllowed("bash", {
			command: `cd ${GLOBAL} && echo x > steering/index.ts`,
		});
	});

	it("r2 F2 (false positive, not coverage): a cd into .pi/steering trips the rule whatever the target", async () => {
		// The verdict comes from the cd ARGUMENT token, so a harmless
		// write elsewhere in the same line is refused. Pinned so nobody
		// reads the block as "the walker resolves cd chains".
		await expectBlocked(
			"bash",
			{ command: "cd .pi && cd steering && printf x > /tmp/harmless.txt" },
			RULE_BASH,
		);
	});

	it("r2 F3: the flat global form, a glob, and removing or moving a parent", async () => {
		await expectAllowed("write", {
			path: `${GLOBAL}/steering.ts`,
			content: "export default {};",
		});
		for (const command of [
			`rm -rf ${GLOBAL}/steer*`,
			`rm -rf ${GLOBAL}`,
			`mv ${GLOBAL} /tmp/x`,
		]) {
			await expectAllowed("bash", { command });
		}
	});

	it("r2 F4: other packages of the global layer's import graph, and pi itself", async () => {
		await expectAllowed("bash", {
			command: `sed -i '1s/a/b/' ${GLOBAL}/npm/node_modules/@cad0p/pi-napkin/dist/steering.js`,
		});
		await expectAllowed("bash", {
			command: `sed -i 's/a/b/' ${GLOBAL}/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`,
		});
	});

	it("git tree operations with no protected path in the text (trust r2 F5)", async () => {
		// Another rail may still refuse one of these (`no-hard-reset`
		// does); the pin is that THIS guard does not see them.
		for (const command of [
			"git -C /root/.pi reset --hard deadbeef",
			"git -C /root/.pi checkout deadbeef",
			"git -C /root/.pi apply /tmp/global.patch",
		]) {
			const verdict = await evaluate("bash", { command });
			assert.ok(
				![RULE_BASH, RULE_WRITE, RULE_EDIT].includes(verdict.rule ?? ""),
				`expected the write guard not to see ${command}, got ${JSON.stringify(verdict)}`,
			);
		}
	});
});
