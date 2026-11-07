// SPDX-License-Identifier: MIT
// Global pi-steering config — E4 critical-path slip tests.
//
// Owner rule: when the critical path slips past set_at + 1.5 x (eta -
// set_at), writing a brief whose pr: header matches a non-done item is
// refused until a replan entry (carrying told_owner_at) is appended.
// A missing / unparsable state file fails OPEN (it must not wedge every
// brief). PI_H4_STATE_DIR points every case at a fresh temp state root.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const harness = loadHarness({ config });
const HOUR = 3_600_000;
const PR = "cad0p/pc-host#650";

let state: string;
let briefs: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-critical-path-"));
	briefs = join(state, "briefs");
	mkdirSync(briefs, { recursive: true });
	process.env.PI_H4_STATE_DIR = state;
});

afterEach(() => {
	delete process.env.PI_H4_STATE_DIR;
	rmSync(state, { recursive: true, force: true });
});

function iso(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

function writeState(value: unknown): void {
	writeFileSync(join(state, "critical-path.json"), JSON.stringify(value));
}

function briefContent(pr = PR): string {
	return `pr: ${pr}\nround: 1\nkind: impl\n`;
}

function briefPath(name: string): string {
	return join(briefs, name);
}

/** A state whose 1.5x deadline is already in the past. */
function slippedState(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		goal: "demo counters live",
		set_at: iso(-10 * HOUR),
		eta: iso(-9 * HOUR),
		items: [{ id: "P1", pr: PR, status: "review" }],
		replans: [],
		...extra,
	};
}

describe("critical-path-slip — write tool", () => {
	it("blocks a brief for a non-done item once the path slipped", async () => {
		writeState(slippedState());
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1.md"), content: briefContent() },
				cwd: "/tmp",
			},
			{ rule: "critical-path-slip", reason: /append a replan entry/ },
		);
	});

	it("allows the same brief before the 1.5x deadline", async () => {
		writeState({
			goal: "x",
			set_at: iso(-1 * HOUR),
			eta: iso(1 * HOUR),
			items: [{ id: "P1", pr: PR, status: "review" }],
			replans: [],
		});
		await expectAllows(harness, {
			write: { path: briefPath("p1.md"), content: briefContent() },
			cwd: "/tmp",
		});
	});

	it("allows a brief for a done item even when slipped", async () => {
		writeState(
			slippedState({
				items: [{ id: "P1", pr: PR, status: "done" }],
			}),
		);
		await expectAllows(harness, {
			write: { path: briefPath("p1.md"), content: briefContent() },
			cwd: "/tmp",
		});
	});

	it("allows a brief for a PR outside the critical path", async () => {
		writeState(slippedState());
		await expectAllows(harness, {
			write: {
				path: briefPath("other.md"),
				content: briefContent("cad0p/pc-host#999"),
			},
			cwd: "/tmp",
		});
	});

	it("fails open when the state file is missing", async () => {
		await expectAllows(harness, {
			write: { path: briefPath("p1.md"), content: briefContent() },
			cwd: "/tmp",
		});
	});

	it("fails open when the state file is malformed JSON", async () => {
		writeFileSync(join(state, "critical-path.json"), "{not json");
		await expectAllows(harness, {
			write: { path: briefPath("p1.md"), content: briefContent() },
			cwd: "/tmp",
		});
	});

	it("fails open when the dates are unparsable", async () => {
		writeState({
			goal: "x",
			set_at: "yesterday",
			eta: "tomorrow",
			items: [{ id: "P1", pr: PR, status: "review" }],
			replans: [],
		});
		await expectAllows(harness, {
			write: { path: briefPath("p1.md"), content: briefContent() },
			cwd: "/tmp",
		});
	});

	it("allows after a replan resets the clock", async () => {
		writeState(
			slippedState({
				replans: [
					{
						at: iso(-1 * HOUR),
						slipped: "rootless CI",
						why: "gate broken",
						new_eta: iso(1 * HOUR),
						told_owner_at: iso(-1 * HOUR),
					},
				],
			}),
		);
		await expectAllows(harness, {
			write: { path: briefPath("p1.md"), content: briefContent() },
			cwd: "/tmp",
		});
	});

	it("blocks when the latest replan has itself slipped", async () => {
		writeState(
			slippedState({
				replans: [
					{
						at: iso(-10 * HOUR),
						slipped: "a",
						why: "b",
						new_eta: iso(-9 * HOUR),
						told_owner_at: iso(-10 * HOUR),
					},
				],
			}),
		);
		await expectBlocks(
			harness,
			{
				write: { path: briefPath("p1.md"), content: briefContent() },
				cwd: "/tmp",
			},
			{ rule: "critical-path-slip" },
		);
	});
});

describe("critical-path-slip — edit and bash surfaces", () => {
	it("blocks an edit of a brief for a non-done item once slipped", async () => {
		writeState(slippedState());
		const path = briefPath("p1-edit.md");
		writeFileSync(path, briefContent());
		await expectBlocks(
			harness,
			{
				edit: {
					path,
					edits: [{ oldText: "kind: impl", newText: "kind: impl\nnote: x" }],
				},
				cwd: "/tmp",
			},
			{ rule: "critical-path-slip-edit" },
		);
	});

	it("blocks a bash -c heredoc brief for a non-done item once slipped", async () => {
		writeState(slippedState());
		const path = briefPath("p1-wrapper.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${briefContent()}EOF"`;
		await expectBlocks(
			harness,
			{ command, cwd: "/tmp" },
			{ rule: "critical-path-slip-bash" },
		);
	});
});
