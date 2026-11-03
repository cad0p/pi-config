// SPDX-License-Identifier: MIT
// Lens round 5 (mechanism change): no module of the global layer or its
// guards reads the live home directory or agent-dir variables; every rail
// takes the framework's process snapshot through `snapshotHomeDir()`
// (framework-support.ts). This scan pins it: any pattern below in a
// shipped source of this layer fails. Comments are stripped first.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: readonly RegExp[] = [
	/\bhomedir\s*\(/,
	/process\.env\.(?:HOME|USERPROFILE|PI_CODING_AGENT_DIR)\b/,
	/process\.env\[\s*["'`](?:HOME|USERPROFILE|PI_CODING_AGENT_DIR)["'`]\s*\]/,
	/\bos\.userInfo\b/,
	/\buserInfo\s*\(/,
];

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => (/^\s*\/\//.test(line) ? "" : line.replace(/\s\/\/\s.*$/, "")))
		.join("\n");
}

/** The layer's own sources: top-level .ts, not tests, not test fixtures. */
function layerSources(): string[] {
	return readdirSync(DIR).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("__test-"),
	);
}

describe("global layer: no live HOME / agent-dir read (lens round 5)", () => {
	it("index.ts and every guard read the snapshot only", () => {
		const files = layerSources();
		for (const expected of ["index.ts", "git-identity-guard.ts", "config-write-guard.ts", "framework-support.ts"])
			assert.ok(files.includes(expected), `scan covers ${expected}`);
		const hits: string[] = [];
		for (const file of files) {
			const code = stripComments(readFileSync(join(DIR, file), "utf8"));
			for (const [i, line] of code.split("\n").entries())
				for (const re of FORBIDDEN) if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
		}
		assert.deepEqual(hits, []);
	});

	it("the scan catches each pattern (not vacuous)", () => {
		for (const sample of [
			"const H = homedir();",
			"const H = process.env.HOME;",
			"const H = process.env.USERPROFILE;",
			"const D = process.env.PI_CODING_AGENT_DIR;",
			'const H = process.env["HOME"];',
			"const H = os.userInfo().homedir;",
		])
			assert.ok(FORBIDDEN.some((re) => re.test(stripComments(sample))), sample);
	});
});
