// SPDX-License-Identifier: MIT
// queue-land-nudge tests — a --mode local land of the repo's merge queue
// entry is refused; the queue's own turn is named instead. Everything else
// stays allowed, including the visible PC_MERGE_LOCAL_OK=1 escape and
// every unreadable state (fail open, the rail's stated policy).
//
// Fixtures: a state root under $TMPDIR (never the real one), written in
// merge-pr.sh's layout <root>/queue/<owner>--<repo>/entries/<pr>.json.
// No command is executed: the harness only evaluates the verdict.

import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const RULE = "queue-land-nudge";
const REPO = "cad0p/pc-host";
const OTHER_REPO = "cad0p/pc-tenant";
const PR = "912";
const OTHER_PR = "913";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** The fixture state root and its one queued entry. */
let root = "";
let bare = "";

/** The entry file of <repo>#<pr> under the fixture root. */
function entryPath(stateRoot: string, repo: string, pr: string): string {
	const key = repo.split("/").join("--").split(".").join("_");
	return join(stateRoot, "queue", key, "entries", `${pr}.json`);
}

/** Write one queue entry (merge-pr.sh's own field set, trimmed). */
function writeEntry(stateRoot: string, repo: string, pr: string): void {
	const path = entryPath(stateRoot, repo, pr);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			repo,
			pr: Number(pr),
			head: HEAD,
			live: { kind: "n/a", reason: "fixture" },
			critical: false,
			ready_seq: 1,
			session: "",
			updated_at: "2026-11-12T00:00:00Z",
		}),
	);
}

/** A merge-pr.sh ref whose helper would read the fixture state root. */
function ref(args: string, stateRoot = root): string {
	return `PC_MERGE_STATE_ROOT=${stateRoot} tools/merge-pr.sh ${args}`;
}

/** The landing shape the rail exists for. */
function local(args: string, stateRoot = root): string {
	return ref(`--mode local ${args}`, stateRoot);
}

describe("queue-land-nudge", () => {
	const harness = loadHarness({ config });

	before(() => {
		root = mkdtempSync(join(tmpdir(), "queue-land-nudge-"));
		bare = mkdtempSync(join(tmpdir(), "queue-land-nudge-bare-"));
		writeEntry(root, REPO, PR);
	});

	after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(bare, { recursive: true, force: true });
	});

	// ---- refused: the local-path land of the queue entry ----

	it("blocks --mode local on the queue entry", async () => {
		await expectBlocks(harness, {
			command: local(`${REPO} ${PR} ${HEAD}`),
		}, { rule: RULE });
	});
	it("blocks --mode=local (the glued form)", async () => {
		await expectBlocks(harness, {
			command: ref(`--mode=local ${REPO} ${PR} ${HEAD}`),
		}, { rule: RULE });
	});
	it("blocks an explicit merge subcommand with --mode local", async () => {
		await expectBlocks(harness, {
			command: local(`merge ${REPO} ${PR} ${HEAD}`),
		}, { rule: RULE });
	});
	it("blocks --mode local train when a piece is the queue entry", async () => {
		await expectBlocks(harness, {
			command: local(`train ${REPO} ${PR}:${HEAD} 914:${HEAD}`),
		}, { rule: RULE });
	});
	it("blocks the same land through bash tools/merge-pr.sh", async () => {
		await expectBlocks(harness, {
			command: `PC_MERGE_STATE_ROOT=${root} bash tools/merge-pr.sh --mode local ${REPO} ${PR} ${HEAD}`,
		}, { rule: RULE });
	});
	it("blocks the wrapper form with bundled shell options", async () => {
		await expectBlocks(harness, {
			command: `PC_MERGE_STATE_ROOT=${root} bash -euo pipefail tools/merge-pr.sh --mode local ${REPO} ${PR} ${HEAD}`,
		}, { rule: RULE });
	});
	it("allows a shell wrapper running another script", async () => {
		await expectAllows(harness, {
			command: `PC_MERGE_STATE_ROOT=${root} bash tools/ci.sh --mode local ${REPO} ${PR}`,
		});
	});
	it("names the queue land turn, not a <repo> <pr> form", async () => {
		await expectBlocks(
			harness,
			{ command: local(`${REPO} ${PR} ${HEAD}`) },
			{
				rule: RULE,
				reason: new RegExp(
					`${REPO}#${PR} is this repo's merge queue entry[\\s\\S]*queue land ${REPO}\`[\\s\\S]*PC_MERGE_LOCAL_OK=1`,
				),
			},
		);
	});

	// ---- allowed: the visible escape ----

	it("allows the PC_MERGE_LOCAL_OK=1 prefix", async () => {
		await expectAllows(harness, {
			command: `PC_MERGE_LOCAL_OK=1 ${local(`${REPO} ${PR} ${HEAD}`)}`,
		});
	});
	it("allows an exported PC_MERGE_LOCAL_OK=1", async () => {
		await expectAllows(harness, {
			command: `export PC_MERGE_LOCAL_OK=1 && ${local(`${REPO} ${PR} ${HEAD}`)}`,
		});
	});
	it("does not treat PC_MERGE_LOCAL_OK=0 as the escape", async () => {
		await expectBlocks(harness, {
			command: `PC_MERGE_LOCAL_OK=0 ${local(`${REPO} ${PR} ${HEAD}`)}`,
		}, { rule: RULE });
	});

	// ---- allowed: everything else in the helper ----

	it("allows gate on the queued PR", async () => {
		await expectAllows(harness, {
			command: ref(`gate ${REPO} ${PR} ${HEAD}`),
		});
	});
	it("allows absorb on the queued PR", async () => {
		await expectAllows(harness, {
			command: ref(`absorb ${REPO} ${PR}`),
		});
	});
	it("allows queue land on the queued PR", async () => {
		await expectAllows(harness, {
			command: ref(`queue land ${REPO}`),
		});
	});
	it("allows queue add, leave and status", async () => {
		await expectAllows(harness, {
			command: ref(
				`queue add ${REPO} ${PR} ${HEAD} --live n/a --reason fixture`,
			),
		});
		await expectAllows(harness, {
			command: ref(`queue leave ${REPO} ${PR}`),
		});
		await expectAllows(harness, { command: ref(`queue status ${REPO}`) });
	});
	it("allows train-gate and rounds on the queued PR", async () => {
		await expectAllows(harness, {
			command: ref(`train-gate ${REPO} ${PR}:${HEAD}`),
		});
		await expectAllows(harness, {
			command: ref(`rounds ${REPO} ${PR}`),
		});
	});
	it("allows --help", async () => {
		await expectAllows(harness, { command: ref("--help") });
	});
	it("allows --mode bootstrap on the queue entry", async () => {
		await expectAllows(harness, {
			command: ref(`--mode bootstrap ${REPO} ${PR} ${HEAD}`),
		});
	});
	it("allows train without --mode local", async () => {
		await expectAllows(harness, {
			command: ref(`train ${REPO} ${PR}:${HEAD}`),
		});
	});

	// ---- allowed: no turn to prefer ----

	it("allows --mode local on a PR that is not the queue entry", async () => {
		await expectAllows(harness, {
			command: local(`${REPO} ${OTHER_PR} ${HEAD}`),
		});
	});
	it("allows --mode local on the same PR number in another repo", async () => {
		await expectAllows(harness, {
			command: local(`${OTHER_REPO} ${PR} ${HEAD}`),
		});
	});

	// ---- allowed: unreadable state (fail open) ----

	it("allows when the entries directory is missing", async () => {
		await expectAllows(harness, {
			command: local(`${REPO} ${PR} ${HEAD}`, bare),
		});
	});
	it("allows when the state root does not exist", async () => {
		await expectAllows(harness, {
			command: local(
				`${REPO} ${PR} ${HEAD}`,
				join(bare, "no-such-root"),
			),
		});
	});
	it("allows when the entry file is unparsable", async () => {
		const broken = entryPath(bare, REPO, PR);
		mkdirSync(dirname(broken), { recursive: true });
		writeFileSync(broken, "{ this is not json");
		await expectAllows(harness, {
			command: local(`${REPO} ${PR} ${HEAD}`, bare),
		});
	});
	it("allows when the entry path is not a readable file (EISDIR)", async () => {
		const dirEntry = entryPath(bare, REPO, OTHER_PR);
		mkdirSync(dirEntry, { recursive: true });
		await expectAllows(harness, {
			command: local(`${REPO} ${OTHER_PR} ${HEAD}`, bare),
		});
	});
	it("allows when the entry names another PR (the file is not this one)", async () => {
		const wrong = entryPath(root, REPO, "915");
		mkdirSync(dirname(wrong), { recursive: true });
		writeFileSync(wrong, JSON.stringify({ repo: REPO, pr: 916 }));
		await expectAllows(harness, {
			command: local(`${REPO} 915 ${HEAD}`),
		});
	});

	// ---- KNOWN GAPS, pinned (the header names each one) ----

	// The helper defaults --mode to local, so this IS a local merge; the
	// rail keys on the explicit flag the brief names, so it is allowed.
	// Flip this to expectBlocks if the rail should follow the default.
	it("KNOWN GAP: allows the bare merge form (helper defaults to local)", async () => {
		await expectAllows(harness, {
			command: ref(`${REPO} ${PR} ${HEAD}`),
		});
	});
	// The documented REPO/PR/HEAD environment form names no PR in the ref.
	it("KNOWN GAP: allows the REPO/PR/HEAD env operands form", async () => {
		await expectAllows(harness, {
			command: `PC_MERGE_STATE_ROOT=${root} REPO=${REPO} PR=${PR} HEAD=${HEAD} tools/merge-pr.sh --mode local`,
		});
	});
	// A dynamic operand does not resolve to a PR shape here.
	it("KNOWN GAP: allows a variable PR operand", async () => {
		await expectAllows(harness, {
			command: local(`${REPO} "$PR" ${HEAD}`),
		});
	});
	// `env` is its own ref: neither its PC_MERGE_LOCAL_OK nor its
	// PC_MERGE_STATE_ROOT is modelled onto the inner merge-pr.sh ref (the
	// session env is the fallback). Pinned with the root on the session env,
	// so the entry IS visible and the invisible escape blocks: use a plain
	// prefix or an export.
	it("KNOWN GAP: an env-wrapper PC_MERGE_LOCAL_OK=1 does not escape", async () => {
		const saved = process.env.PC_MERGE_STATE_ROOT;
		process.env.PC_MERGE_STATE_ROOT = root;
		try {
			await expectBlocks(
				harness,
				{
					command: `env PC_MERGE_LOCAL_OK=1 tools/merge-pr.sh --mode local ${REPO} ${PR} ${HEAD}`,
				},
				{ rule: RULE },
			);
		} finally {
			if (saved === undefined) delete process.env.PC_MERGE_STATE_ROOT;
			else process.env.PC_MERGE_STATE_ROOT = saved;
		}
	});
});
