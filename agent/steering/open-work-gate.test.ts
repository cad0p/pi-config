// SPDX-License-Identifier: MIT
// Global pi-steering config - open-work gate tests (pc-host #703, D7).
//
// The gate is dormant until open-work.json says armed: true. Armed,
// a brief is refused while the ledger lists PRs the brief does not
// itself handle (scope all, or scope session for the brief's own
// session: header; no header = every session), or while the ledger is
// over 60 min old with no valid ack. PI_H4_STATE_DIR points every case
// at a fresh temp state root.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import { parseBriefHeader, sessionId8 } from "./brief-gates.ts";
import config from "./index.ts";
import {
	ACK_MAX_MS,
	MAX_SHOWN,
	ORPHAN_TAKEOVER_BY_ANY_SESSION,
	SESSION_MAY_ACK_STALE,
	STALE_MINUTES,
} from "./open-work-gate.ts";

const harness = loadHarness({ config });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const A = "aaaaaaaa";
const B = "bbbbbbbb";

let state: string;
let briefs: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "steering-open-work-"));
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

interface Entry {
	pr: string;
	why?: string;
	scope?: string;
	session?: string | null;
	detail?: string;
}

function entry(pr: string, extra: Partial<Entry> = {}): Entry {
	return {
		pr,
		why: "no-state",
		scope: "all",
		session: null,
		detail: "no board state; last activity 2026-11-05T21:02Z",
		...extra,
	};
}

function writeLedger(listed: unknown[], extra: Record<string, unknown> = {}): string {
	const generated = iso(-5 * MINUTE);
	writeFileSync(
		join(state, "open-work.json"),
		JSON.stringify({
			schema: 1,
			armed: true,
			ok: true,
			error: null,
			generated_at: generated,
			attempted_at: generated,
			open: [],
			listed,
			...extra,
		}),
	);
	return (extra.generated_at as string | undefined) ?? generated;
}

function writeAck(ack: Record<string, unknown>): void {
	writeFileSync(join(state, "open-work-ack.json"), JSON.stringify(ack));
}

function brief(
	pr: string,
	opts: { session?: string; splitOf?: string } = {},
): string {
	const lines = [`pr: ${pr}`, "round: 1", "kind: impl"];
	if (opts.splitOf !== undefined) lines.push(`split-of: ${opts.splitOf}`);
	if (opts.session !== undefined) lines.push(`session: ${opts.session}`);
	return `${lines.join("\n")}\n\nbody\n`;
}

function writeBrief(pr: string, opts: { session?: string; splitOf?: string } = {}) {
	return {
		write: { path: join(briefs, "b.md"), content: brief(pr, opts) },
		cwd: "/tmp",
	};
}

describe("parseBriefHeader - session:", () => {
	it("returns a lowercased id8", () => {
		const h = parseBriefHeader("pr: cad0p/pc-host#1\nround: 1\nkind: impl\nsession: 01A1B9C5\n");
		assert.equal(h.session, "01a1b9c5");
		assert.equal(h.sessionRaw, "01A1B9C5");
		assert.equal(h.complete, true);
	});
	it("is null when absent", () => {
		const h = parseBriefHeader("pr: cad0p/pc-host#1\nround: 1\nkind: impl\n");
		assert.equal(h.session, null);
		assert.equal(h.sessionRaw, null);
	});
	it("is null (every session) when malformed, raw kept", () => {
		const h = parseBriefHeader("pr: cad0p/pc-host#1\nround: 1\nkind: impl\nsession: h4-main\n");
		assert.equal(h.session, null);
		assert.equal(h.sessionRaw, "h4-main");
	});
	it("reduces a full PI_SESSION_ID to its last 8 hex, so UUIDv7 ids sharing the timestamp prefix differ (pc-host #706 R1)", () => {
		const one = "019a0000-ffff-7000-8000-000011111111";
		const two = "019a0000-ffff-7000-8000-000022222222";
		assert.equal(sessionId8(one), "11111111");
		assert.equal(sessionId8(two), "22222222");
		assert.equal(sessionId8("01A1B9E3-446D-77EF-AE96-992AB55C1BF4"), "b55c1bf4");
		assert.equal(sessionId8("h4-main"), null);
		assert.equal(sessionId8("abc"), null);
		const h = parseBriefHeader(`pr: cad0p/pc-host#1\nround: 1\nkind: impl\nsession: ${one}\n`);
		assert.equal(h.session, "11111111");
		assert.equal(h.sessionRaw, one);
	});
	it("reads YAML frontmatter too", () => {
		const h = parseBriefHeader("---\npr: cad0p/pc-host#1\nround: 1\nkind: impl\nsession: 'aaaaaaaa'\n---\n");
		assert.equal(h.session, A);
	});
});

describe("open-work-gate - owner-call constants default to the note's recommendations", () => {
	it("O1 any session may take over an orphan, O3 a session may ack, 60 min / 2 h / 15", () => {
		assert.equal(ORPHAN_TAKEOVER_BY_ANY_SESSION, true);
		assert.equal(SESSION_MAY_ACK_STALE, true);
		assert.equal(STALE_MINUTES, 60);
		assert.equal(ACK_MAX_MS, 2 * HOUR);
		assert.equal(MAX_SHOWN, 15);
	});
});

describe("open-work-gate - D7 cases", () => {
	it("1. allows with no ledger file (dormant)", async () => {
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
	});

	it("2. allows with a malformed ledger", async () => {
		writeFileSync(join(state, "open-work.json"), "{not json");
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
	});

	it("3. allows armed:false even with entries (and a stale ledger)", async () => {
		writeLedger([entry("cad0p/pc-host#611")], { armed: false, generated_at: iso(-5 * HOUR) });
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
	});

	it("3b. allows when armed is missing or not literally true", async () => {
		writeLedger([entry("cad0p/pc-host#611")], { armed: "yes" });
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
	});

	it("4. allows armed with an empty listed", async () => {
		writeLedger([]);
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
	});

	it("5. a scope:all no-state entry blocks a brief for another PR, naming the PR and the three ways out", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-host#611 +no-state/,
		});
		const why = String(res.reason);
		assert.match(why, /open-work ledger \(swept \d\d:\d\dZ, 1 PR need a state before a new brief\)/);
		assert.match(why, /resume: tools\/open-work\.sh resume/);
		assert.match(why, /park: +tools\/open-work\.sh park .*--until YYYY-MM-DD/);
		assert.match(why, /close: +tools\/open-work\.sh close/);
	});

	it("5b. a brief with session: is blocked by scope:all entries too", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700", { session: A }), {
			rule: "open-work-gate",
		});
	});

	it("6. allows the brief for that PR itself (resuming it)", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		await expectAllows(harness, writeBrief("cad0p/pc-host#611"));
	});

	it("6b. matches the PR case-insensitively", async () => {
		writeLedger([entry("cad0p/PC-host#611")]);
		await expectAllows(harness, writeBrief("cad0p/pc-host#611"));
	});

	it("7. allows a split-of brief for that PR", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		await expectAllows(
			harness,
			writeBrief("cad0p/pc-host#720", { splitOf: "cad0p/pc-host#611" }),
		);
	});

	it("8. a scope:session idle entry blocks its own session and a brief with no session:, not another session", async () => {
		writeLedger([
			entry("cad0p/pc-control#371", { why: "idle", scope: "session", session: A, detail: "Active, idle 7h" }),
		]);
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700", { session: A }), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-control#371 +idle/,
		});
		assert.match(String(res.reason), /\(you\)/);
		await expectAllows(harness, writeBrief("cad0p/pc-host#700", { session: B }));
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), { rule: "open-work-gate" });
	});

	it("8b. a malformed session: line counts as every session", async () => {
		writeLedger([entry("cad0p/pc-control#371", { why: "idle", scope: "session", session: A })]);
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700", { session: "h4-main" }), {
			rule: "open-work-gate",
		});
	});

	it("8d. two sessions sharing the UUIDv7 timestamp prefix are distinct (id8 = the last 8 hex, pc-host #706 R1)", async () => {
		const mine = "019a0000-ffff-7000-8000-0000aaaaaaaa";
		const theirs = "019a0000-ffff-7000-8000-0000bbbbbbbb";
		writeLedger([entry("cad0p/pc-control#371", { why: "idle", scope: "session", session: A })]);
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700", { session: mine }), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-control#371 +idle.*\(you\)/,
		});
		await expectAllows(harness, writeBrief("cad0p/pc-host#700", { session: theirs }));
		await expectAllows(harness, writeBrief("cad0p/pc-control#371", { session: mine }));
	});

	it("8c. the owner session's brief for its own idle PR resumes it", async () => {
		writeLedger([entry("cad0p/pc-control#371", { why: "idle", scope: "session", session: A })]);
		await expectAllows(harness, writeBrief("cad0p/pc-control#371", { session: A }));
	});

	it("9. another session's brief for a session-scoped PR does not handle it", async () => {
		writeLedger([
			entry("cad0p/pc-host#611", { why: "idle", scope: "session", session: A }),
			entry("cad0p/pc-host#612"),
		]);
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#611", { session: B }), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-host#612/,
		});
		assert.doesNotMatch(String(res.reason), /#611/);
		// No session: sees A's item and cannot claim it.
		await expectBlocks(harness, writeBrief("cad0p/pc-host#611"), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-host#611 +idle/,
		});
		// A's own brief handles #611; only #612 is left.
		const own = await expectBlocks(harness, writeBrief("cad0p/pc-host#611", { session: A }), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-host#612/,
		});
		assert.doesNotMatch(String(own.reason), /#611/);
	});

	it("9b. O1: any session's brief for an orphaned PR takes it over", async () => {
		writeLedger([entry("cad0p/pc-host#611", { why: "orphaned", scope: "all", session: A })]);
		await expectAllows(harness, writeBrief("cad0p/pc-host#611", { session: B }));
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700", { session: B }), {
			rule: "open-work-gate",
			reason: /orphaned/,
		});
	});

	it("10. a ledger swept 61 min ago blocks with ledger-stale and the systemctl/ack text", async () => {
		writeLedger([], { generated_at: iso(-61 * MINUTE), attempted_at: iso(-MINUTE) });
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /open-work ledger is stale \(last good sweep/,
		});
		const why = String(res.reason);
		assert.match(why, /systemctl --user status pc-open-work\.service/);
		assert.match(why, /tools\/open-work\.sh ack-stale --reason/);
		assert.doesNotMatch(why, /need a state/);
	});

	it("10b. a failed sweep shows its error in the stale text", async () => {
		writeLedger([], { ok: false, error: "gh: HTTP 502", generated_at: iso(-90 * MINUTE) });
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /last attempt failed: gh: HTTP 502/,
		});
	});

	it("10c. at 59 min the ledger is not stale", async () => {
		writeLedger([], { generated_at: iso(-59 * MINUTE) });
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
	});

	it("10d. a missing generated_at counts as stale", async () => {
		writeLedger([], { generated_at: null });
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /is stale/,
		});
	});

	it("10e. stale plus entries shows both", async () => {
		writeLedger([entry("cad0p/pc-host#611")], { generated_at: iso(-2 * HOUR) });
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-host#611/,
		});
		assert.match(String(res.reason), /is stale/);
	});

	it("11. a valid ack lifts ledger-stale; an expired ack does not", async () => {
		const generated = writeLedger([], { generated_at: iso(-90 * MINUTE) });
		writeAck({ at: iso(-10 * MINUTE), until: iso(HOUR), reason: "GitHub down", session: A, generated_at: generated });
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
		writeAck({ at: iso(-3 * HOUR), until: iso(-MINUTE), reason: "GitHub down", session: A, generated_at: generated });
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /is stale/,
		});
	});

	it("11b. the lift is one 2 h window from the ack's at, whatever until says", async () => {
		const generated = writeLedger([], { generated_at: iso(-5 * HOUR) });
		writeAck({ at: iso(-119 * MINUTE), until: iso(10 * HOUR), reason: "x", session: A, generated_at: generated });
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
		writeAck({ at: iso(-121 * MINUTE), until: iso(10 * HOUR), reason: "x", session: A, generated_at: generated });
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /is stale/,
		});
	});

	it("11c. an ack for another ledger generation (outage), with no reason, or dated in the future does not lift", async () => {
		const generated = writeLedger([], { generated_at: iso(-90 * MINUTE) });
		writeAck({ at: iso(-MINUTE), until: iso(HOUR), reason: "x", session: A, generated_at: iso(-10 * HOUR) });
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), { rule: "open-work-gate" });
		writeAck({ at: iso(-MINUTE), until: iso(HOUR), reason: "", session: A, generated_at: generated });
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), { rule: "open-work-gate" });
		writeAck({ at: iso(10 * MINUTE), until: iso(HOUR), reason: "x", session: A, generated_at: generated });
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), { rule: "open-work-gate" });
	});

	it("11d. an ack lifts only ledger-stale, never listed entries", async () => {
		const generated = writeLedger([entry("cad0p/pc-host#611")], { generated_at: iso(-90 * MINUTE) });
		writeAck({ at: iso(-MINUTE), until: iso(HOUR), reason: "x", session: A, generated_at: generated });
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-host#611/,
		});
		assert.doesNotMatch(String(res.reason), /is stale/);
	});

	it("12. ok:false under 60 min enforces the kept entry (no fail-open)", async () => {
		writeLedger([entry("cad0p/pc-mint#14", { why: "park-expired" })], {
			ok: false,
			error: "gh: 502",
			generated_at: iso(-20 * MINUTE),
		});
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /cad0p\/pc-mint#14 +park-expired/,
		});
		assert.doesNotMatch(String(res.reason), /is stale/);
	});

	it("13. the edit surface blocks case 5", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		const path = join(briefs, "edit.md");
		writeFileSync(path, brief("cad0p/pc-host#700"));
		await expectBlocks(
			harness,
			{ edit: { path, edits: [{ oldText: "body", newText: "body v2" }] }, cwd: "/tmp" },
			{ rule: "open-work-gate-edit", reason: /cad0p\/pc-host#611/ },
		);
	});

	it("13b. the bash -c heredoc surface blocks case 5", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		const path = join(briefs, "wrapper.md");
		const command = `bash -c "cat > ${path} <<'EOF'\n${brief("cad0p/pc-host#700")}EOF"`;
		await expectBlocks(harness, { command, cwd: "/tmp" }, {
			rule: "open-work-gate-bash",
			reason: /cad0p\/pc-host#611/,
		});
	});

	it("14. allows a write outside briefs/", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		await expectAllows(harness, {
			write: { path: join(state, "notes.md"), content: brief("cad0p/pc-host#700") },
			cwd: "/tmp",
		});
	});

	it("15. a brief with no header is refused by design-check-gate first", async () => {
		writeLedger([entry("cad0p/pc-host#611")]);
		await expectBlocks(
			harness,
			{ write: { path: join(briefs, "nohdr.md"), content: "just a body\n" }, cwd: "/tmp" },
			{ rule: "design-check-gate", reason: /briefs need a header/ },
		);
	});

	it("16. more than 15 entries truncate with '... and N more'", async () => {
		const listed = Array.from({ length: 20 }, (_, i) => entry(`cad0p/pc-host#${800 + i}`));
		writeLedger(listed);
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /\.\.\. and 5 more: tools\/open-work\.sh list/,
		});
		const why = String(res.reason);
		assert.match(why, /20 PRs need a state/);
		assert.equal((why.match(/cad0p\/pc-host#8\d\d/g) ?? []).length, 15);
	});

	it("entries with an unparsable pr are dropped and counted", async () => {
		writeLedger([{ pr: "cad0p/pc-host (Q1)", why: "no-state", scope: "all" }, entry("cad0p/pc-host#611")]);
		await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), {
			rule: "open-work-gate",
			reason: /1 listed entry with an unparsable pr ignored/,
		});
		writeLedger([{ pr: "garbage", why: "no-state", scope: "all" }]);
		await expectAllows(harness, writeBrief("cad0p/pc-host#700"));
	});

	it("the refusal sorts by why", async () => {
		writeLedger([
			entry("cad0p/pc-host#1", { why: "park-invalid" }),
			entry("cad0p/pc-host#2", { why: "idle", scope: "session", session: A }),
			entry("cad0p/pc-host#3", { why: "no-state" }),
		]);
		const res = await expectBlocks(harness, writeBrief("cad0p/pc-host#700"), { rule: "open-work-gate" });
		const why = String(res.reason);
		assert.ok(why.indexOf("#2 ") < why.indexOf("#3 ") && why.indexOf("#3 ") < why.indexOf("#1 "));
	});
});
