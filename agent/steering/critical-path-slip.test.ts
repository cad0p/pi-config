// SPDX-License-Identifier: MIT
// Global pi-steering config — E4 critical-path slip tests.
//
// Owner rule: when the critical path slips past set_at + 1.5 x (eta -
// set_at), writing a brief whose pr: header matches a non-done item is
// refused until a replan entry (carrying told_owner_at) is appended.
// A missing / unparsable state file fails OPEN (it must not wedge every
// brief). PI_H4_STATE_DIR points every case at a fresh temp state root.

import assert from "node:assert/strict";
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
	return `pr: ${pr}\nround: 1\nkind: impl\nconsumers: none — pre-launch: no tenant slices run; no compatibility window is owed\n`;
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

// ---------------------------------------------------------------------
// Reset guard (pc-host #703, design note D8): a write that replaces
// critical-path.json may not drop an unfinished item unless it is
// done, its PR is parked / gone per a FRESH ledger, or the new content
// lists it under dropped with {id, why, told_owner_at}.
// ---------------------------------------------------------------------

const MINUTE = 60_000;
const PR611 = "cad0p/pc-host#611";

function cpFile(): string {
	return join(state, "critical-path.json");
}

function resetItems(): Array<Record<string, unknown>> {
	return [
		{ id: "mech-absorb", pr: "cad0p/pc-host#685", status: "merged", done_at: iso(-HOUR) },
		{ id: "queue-q1", pr: "cad0p/pc-host (Q1 queue core)", status: "after #699" },
		{ id: "base-rules", pr: PR611, status: "r2 trio" },
	];
}

/** A non-slipped state (so only the reset guard can fire). */
function resetState(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		goal: "go-live",
		set_at: iso(-HOUR),
		eta: iso(10 * HOUR),
		items: resetItems(),
		replans: [],
		...extra,
	};
}

function writeOld(): string {
	const text = JSON.stringify(resetState(), null, 2);
	writeFileSync(cpFile(), text);
	return text;
}

function without(...ids: string[]): Array<Record<string, unknown>> {
	return resetItems().filter((item) => !ids.includes(item.id as string));
}

function newContent(extra: Record<string, unknown> = {}): string {
	return JSON.stringify(resetState(extra), null, 2);
}

function writeLedger(open: unknown[], ageMs = 5 * MINUTE, ok = true): void {
	writeFileSync(
		join(state, "open-work.json"),
		JSON.stringify({
			schema: 1,
			armed: false,
			ok,
			error: ok ? null : "gh: 502",
			generated_at: iso(-ageMs),
			attempted_at: iso(-MINUTE),
			open,
			listed: [],
		}),
	);
}

function writeEvent(content: string) {
	return { write: { path: cpFile(), content }, cwd: "/tmp" };
}

describe("critical-path-reset — D8 cases", () => {
	it("1. allows dropping a done_at item", async () => {
		writeOld();
		await expectAllows(harness, writeEvent(newContent({ items: without("mech-absorb") })));
	});

	it("1b. allows dropping a status: done item", async () => {
		const items = resetItems().map((i) => (i.id === "queue-q1" ? { ...i, status: "done" } : i));
		writeFileSync(cpFile(), JSON.stringify(resetState({ items })));
		await expectAllows(harness, writeEvent(newContent({ items: without("queue-q1") })));
	});

	it("2. refuses dropping an unfinished non-PR item and names it", async () => {
		writeOld();
		const res = await expectBlocks(
			harness,
			writeEvent(newContent({ items: without("queue-q1") })),
			{ rule: "critical-path-reset", reason: /drops unfinished item\(s\): queue-q1 \("cad0p\/pc-host \(Q1 queue core\)"\)/ },
		);
		assert.match(String(res.reason), /add \{id, why, told_owner_at\} to a top-level "dropped" array/);
	});

	it("3. allows the same drop with a dropped entry", async () => {
		writeOld();
		await expectAllows(
			harness,
			writeEvent(
				newContent({
					items: without("queue-q1"),
					dropped: [{ id: "queue-q1", why: "moved to #704", told_owner_at: iso(-MINUTE) }],
				}),
			),
		);
	});

	it("4. refuses a dropped entry with an empty told_owner_at", async () => {
		writeOld();
		await expectBlocks(
			harness,
			writeEvent(
				newContent({
					items: without("queue-q1"),
					dropped: [{ id: "queue-q1", why: "moved", told_owner_at: "" }],
				}),
			),
			{ rule: "critical-path-reset", reason: /queue-q1/ },
		);
	});

	it("5. allows dropping a PR item the fresh ledger shows parked", async () => {
		writeOld();
		writeLedger([{ pr: PR611, state: "parked" }]);
		await expectAllows(harness, writeEvent(newContent({ items: without("base-rules") })));
	});

	it("5b. refuses the same PR when the fresh ledger shows it none", async () => {
		writeOld();
		writeLedger([{ pr: PR611, state: "none" }]);
		await expectBlocks(
			harness,
			writeEvent(newContent({ items: without("base-rules") })),
			{ rule: "critical-path-reset", reason: /base-rules \(cad0p\/pc-host#611, open, not Parked\)/ },
		);
	});

	it("6. allows dropping a PR item absent from the fresh ledger (merged)", async () => {
		writeOld();
		writeLedger([{ pr: "cad0p/pc-host#999", state: "none" }]);
		await expectAllows(harness, writeEvent(newContent({ items: without("base-rules") })));
	});

	it("6b. refuses the same drop with a 2 h-old ledger", async () => {
		writeOld();
		writeLedger([], 2 * HOUR);
		await expectBlocks(
			harness,
			writeEvent(newContent({ items: without("base-rules") })),
			{ rule: "critical-path-reset", reason: /base-rules \(cad0p\/pc-host#611, open-work ledger missing or stale\)/ },
		);
	});

	it("6c. refuses the same drop when the fresh ledger's last sweep failed (ok:false)", async () => {
		writeOld();
		writeLedger([], 5 * MINUTE, false);
		await expectBlocks(
			harness,
			writeEvent(newContent({ items: without("base-rules") })),
			{ rule: "critical-path-reset" },
		);
	});

	it("6d. refuses a PR item with no ledger at all; dropped still frees it", async () => {
		writeOld();
		await expectBlocks(
			harness,
			writeEvent(newContent({ items: without("base-rules") })),
			{ rule: "critical-path-reset", reason: /base-rules/ },
		);
		await expectAllows(
			harness,
			writeEvent(
				newContent({
					items: without("base-rules"),
					dropped: [{ id: "base-rules", why: "ledger down", told_owner_at: iso(0) }],
				}),
			),
		);
	});

	it("7. allows any write when there is no old file", async () => {
		await expectAllows(harness, writeEvent(newContent({ items: [] })));
	});

	it("7b. allows any write when the old file is unparsable", async () => {
		writeFileSync(cpFile(), "{not json");
		await expectAllows(harness, writeEvent(newContent({ items: [] })));
	});

	it("8. refuses removing an item through an edit patch", async () => {
		const old = writeOld();
		const next = newContent({ items: without("queue-q1") });
		await expectBlocks(
			harness,
			{ edit: { path: cpFile(), edits: [{ oldText: old, newText: next }] }, cwd: "/tmp" },
			{ rule: "critical-path-reset-edit", reason: /queue-q1/ },
		);
	});

	it("9. refuses an mv whose source drops an item; allows one that keeps them", async () => {
		writeOld();
		const tmp = join(state, "cp.tmp.json");
		writeFileSync(tmp, newContent({ items: without("queue-q1") }));
		await expectBlocks(
			harness,
			{ command: `mv ${tmp} ${cpFile()}`, cwd: "/tmp" },
			{ rule: "critical-path-reset-bash", reason: /queue-q1/ },
		);
		writeFileSync(tmp, newContent());
		await expectAllows(harness, { command: `mv ${tmp} ${cpFile()}`, cwd: "/tmp" });
	});

	it("9b. refuses a cp (relative source, cd'd cwd) that drops an item", async () => {
		writeOld();
		writeFileSync(join(state, "next.json"), newContent({ items: [] }));
		await expectBlocks(
			harness,
			{ command: "cp next.json critical-path.json", cwd: state },
			{ rule: "critical-path-reset-bash", reason: /queue-q1/ },
		);
	});

	it("9c. refuses an mv -t <state dir> whose source is named critical-path.json", async () => {
		writeOld();
		const dir = join(state, "staging");
		mkdirSync(dir);
		writeFileSync(join(dir, "critical-path.json"), newContent({ items: [] }));
		await expectBlocks(
			harness,
			{ command: `mv -t ${state} ${join(dir, "critical-path.json")}`, cwd: "/tmp" },
			{ rule: "critical-path-reset-bash" },
		);
	});

	it("10. refuses an mv whose source does not exist yet (unverifiable)", async () => {
		writeOld();
		await expectBlocks(
			harness,
			{ command: `mv ${join(state, "absent.json")} ${cpFile()}`, cwd: "/tmp" },
			{ rule: "critical-path-reset-bash", reason: /cannot verify the new .*critical-path\.json/ },
		);
	});

	it("10b. refuses a tee into critical-path.json (content hidden)", async () => {
		writeOld();
		await expectBlocks(
			harness,
			{ command: `tee ${cpFile()}`, cwd: "/tmp" },
			{ rule: "critical-path-reset-bash", reason: /cannot verify/ },
		);
	});

	it("10c. refuses new content that does not parse", async () => {
		writeOld();
		await expectBlocks(harness, writeEvent("{oops"), {
			rule: "critical-path-reset",
			reason: /would not parse/,
		});
	});

	it("10d. refuses a bash -c heredoc that drops an item", async () => {
		writeOld();
		const body = JSON.stringify(resetState({ items: without("queue-q1") }));
		await expectBlocks(
			harness,
			{ command: `bash -c "cat > ${cpFile()} <<'EOF'\n${body.replace(/"/g, '\\"')}\nEOF"`, cwd: "/tmp" },
			{ rule: "critical-path-reset-bash", reason: /queue-q1/ },
		);
	});

	it("11. allows a status-only edit (the everyday change)", async () => {
		writeOld();
		await expectAllows(harness, {
			edit: {
				path: cpFile(),
				edits: [{ oldText: '"status": "r2 trio"', newText: '"status": "r3 trio"' }],
			},
			cwd: "/tmp",
		});
	});

	it("12. allows adding items", async () => {
		writeOld();
		await expectAllows(
			harness,
			writeEvent(newContent({ items: [...resetItems(), { id: "new", pr: "cad0p/pc-host#704", status: "todo" }] })),
		);
	});

	it("allows an archive copy (target is not critical-path.json)", async () => {
		writeOld();
		await expectAllows(harness, {
			command: `cp ${cpFile()} ${join(state, "critical-path-2026-11-08-golive.json")}`,
			cwd: "/tmp",
		});
	});

	it("KNOWN GAP: moving the old file away first leaves nothing to compare", async () => {
		writeOld();
		await expectAllows(harness, {
			command: `mv ${cpFile()} ${join(state, "critical-path-old.json")}`,
			cwd: "/tmp",
		});
	});
});
