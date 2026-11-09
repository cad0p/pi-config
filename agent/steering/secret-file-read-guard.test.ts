// SPDX-License-Identifier: MIT
// secret-file-read-guard tests — a bash command that would print a
// known secret file is refused; hashes, silent compares, counts,
// masked reads and writes stay allowed.
//
// Fixtures are fake values under a temp dir: nothing here is a real
// secret, and no command is executed — the harness only evaluates the
// steering verdict.
//
// The headline case is the incident shape (a live npm token from
// cat ~/.npmrc). The read-tool half of the brief is NOT gateable
// with pi-steering 0.2.0 (rules are bash/write/edit only) and is
// pinned as a KNOWN GAP at the end.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const RULE = "no-secret-file-print";
const REASON = /masked view with the tool that reads it \(sed -E/;

let FIX = "";

describe("secret-file-read-guard", () => {
	const harness = loadHarness({ config });

	before(() => {
		FIX = mkdtempSync(join(tmpdir(), "steering-secret-fixture-"));
		for (const name of [
			".env",
			".env.local",
			"app.env",
			"server.key",
			"cert.pem",
			"other",
			"copy.txt",
			"notes.txt",
		]) {
			writeFileSync(join(FIX, name), "FAKE_TOKEN=fixture-value-never-printed\n");
		}
	});
	after(() => {
		rmSync(FIX, { recursive: true, force: true });
	});

	// ---- refused: printers on known secret files ----

	it("blocks cat ~/.npmrc (the incident shape)", async () => {
		await expectBlocks(harness, { command: "cat ~/.npmrc" }, { rule: RULE, reason: REASON });
	});
	it("blocks cat of a .env file", async () => {
		await expectBlocks(harness, { command: "cat " + FIX + "/.env" }, { rule: RULE });
	});
	it("blocks head of *.env", async () => {
		await expectBlocks(harness, { command: "head -3 " + FIX + "/app.env" }, { rule: RULE });
	});
	it("blocks tail of .env.local", async () => {
		await expectBlocks(harness, { command: "tail -n 20 " + FIX + "/.env.local" }, { rule: RULE });
	});
	it("blocks less ~/.netrc", async () => {
		await expectBlocks(harness, { command: "less ~/.netrc" }, { rule: RULE });
	});
	it("blocks more ~/.pypirc", async () => {
		await expectBlocks(harness, { command: "more ~/.pypirc" }, { rule: RULE });
	});
	it("blocks bat ~/.docker/config.json", async () => {
		await expectBlocks(harness, { command: "bat ~/.docker/config.json" }, { rule: RULE });
	});
	it("blocks xxd of a private key", async () => {
		await expectBlocks(harness, { command: "xxd " + FIX + "/server.key" }, { rule: RULE });
	});
	it("blocks base64 of a .pem", async () => {
		await expectBlocks(harness, { command: "base64 -w0 " + FIX + "/cert.pem" }, { rule: RULE });
	});
	it("blocks strings on ~/.aws/credentials", async () => {
		await expectBlocks(harness, { command: "strings ~/.aws/credentials" }, { rule: RULE });
	});
	it("blocks od on ~/.config/gh/hosts.yml", async () => {
		await expectBlocks(harness, { command: "od -c ~/.config/gh/hosts.yml" }, { rule: RULE });
	});
	it("blocks jq on ~/.docker/config.json", async () => {
		await expectBlocks(harness, { command: "jq . ~/.docker/config.json" }, { rule: RULE });
	});
	it("blocks diff against a secret file", async () => {
		await expectBlocks(harness, { command: "diff ~/.npmrc " + FIX + "/other" }, { rule: RULE });
	});
	it("blocks cmp without -s", async () => {
		await expectBlocks(harness, { command: "cmp ~/.npmrc " + FIX + "/other" }, { rule: RULE });
	});
	it("blocks sed -n p of a secret file", async () => {
		await expectBlocks(harness, { command: "sed -n 1p ~/.npmrc" }, { rule: RULE });
	});
	it("blocks sed with a non-masking substitution", async () => {
		await expectBlocks(harness, { command: "sed -E 's/x/y/' ~/.npmrc" }, { rule: RULE });
	});
	it("blocks awk that prints", async () => {
		await expectBlocks(harness, { command: "awk '{print $1}' ~/.npmrc" }, { rule: RULE });
	});
	it("blocks awk -v with a printing program", async () => {
		await expectBlocks(harness, { command: "awk -v x=1 'BEGIN{print x}' ~/.npmrc" }, { rule: RULE });
	});
	it("blocks grep printing matching lines", async () => {
		await expectBlocks(harness, { command: "grep authToken ~/.npmrc" }, { rule: RULE });
	});
	it("blocks grep -v (still prints lines)", async () => {
		await expectBlocks(harness, { command: "grep -v x ~/.git-credentials" }, { rule: RULE });
	});
	it("blocks rg printing matching lines", async () => {
		await expectBlocks(harness, { command: "rg -n token " + FIX + "/.env" }, { rule: RULE });
	});
	it("blocks cp of a secret to /dev/stdout", async () => {
		await expectBlocks(harness, { command: "cp ~/.npmrc /dev/stdout" }, { rule: RULE });
	});
	it("blocks dd if= of a secret file", async () => {
		await expectBlocks(harness, { command: "dd if=" + FIX + "/.env" }, { rule: RULE });
	});
	it("blocks cat of ~/.config/rclone/rclone.conf", async () => {
		await expectBlocks(harness, { command: "cat ~/.config/rclone/rclone.conf" }, { rule: RULE });
	});
	it("blocks cat of the restic password file", async () => {
		await expectBlocks(harness, { command: "cat ~/.config/restic/password" }, { rule: RULE });
	});
	it("blocks cat of an ssh private key", async () => {
		await expectBlocks(harness, { command: "cat ~/.ssh/id_ed25519" }, { rule: RULE });
	});
	it("blocks a printer nested in sh -c (codemode-nested bash shape)", async () => {
		await expectBlocks(harness, { command: "sh -c 'cat ~/.npmrc'" }, { rule: RULE });
	});
	it("blocks a printer under sudo", async () => {
		await expectBlocks(harness, { command: "sudo cat ~/.npmrc" }, { rule: RULE });
	});
	it("blocks a printer nested in bash -c with a .env", async () => {
		await expectBlocks(harness, { command: "bash -c 'grep token " + FIX + "/.env'" }, { rule: RULE });
	});
	it("KNOWN GAP: blocks the masked pipe form too (per-ref evaluation)", async () => {
		// Deliberate fail-closed deviation: pi-steering cannot see the
		// downstream masking sed from the cat ref. Use sed directly on FILE.
		await expectBlocks(harness, { command: "cat ~/.npmrc | sed -E 's/=.*/=<redacted>/'" }, { rule: RULE });
	});

	// ---- allowed: checks, hashes, counts, masked reads, writes ----

	it("allows test -f ~/.npmrc", async () => {
		await expectAllows(harness, { command: "test -f ~/.npmrc" });
	});
	it("allows stat of a .env", async () => {
		await expectAllows(harness, { command: "stat -c '%a %s' " + FIX + "/.env" });
	});
	it("allows ls -l ~/.npmrc", async () => {
		await expectAllows(harness, { command: "ls -l ~/.npmrc" });
	});
	it("allows sha256sum of a secret file", async () => {
		await expectAllows(harness, { command: "sha256sum ~/.npmrc" });
	});
	it("allows cmp -s (silent compare)", async () => {
		await expectAllows(harness, { command: "cmp -s ~/.npmrc " + FIX + "/other" });
	});
	it("allows grep -c", async () => {
		await expectAllows(harness, { command: "grep -c authToken ~/.npmrc" });
	});
	it("allows grep -q", async () => {
		await expectAllows(harness, { command: "grep -q token " + FIX + "/.env" });
	});
	it("allows grep -l", async () => {
		await expectAllows(harness, { command: "grep -l token " + FIX + "/.env" });
	});
	it("allows rg -c", async () => {
		await expectAllows(harness, { command: "rg -c token ~/.npmrc" });
	});
	it("allows a masked sed read (the sanctioned mask shape)", async () => {
		await expectAllows(harness, { command: "sed -E 's/(=|: ).*/\\1<redacted>/' ~/.npmrc" });
	});
	it("allows a masked sed read on a *.env", async () => {
		await expectAllows(harness, { command: "sed 's/=.*/=<redacted>/' " + FIX + "/app.env" });
	});
	it("allows sed -i (in-place write)", async () => {
		await expectAllows(harness, { command: "sed -i 's/a/b/' ~/.npmrc" });
	});
	it("allows source ~/.npmrc (into a shell)", async () => {
		await expectAllows(harness, { command: "source ~/.npmrc" });
	});
	it("allows . FILE (source)", async () => {
		await expectAllows(harness, { command: ". " + FIX + "/.env" });
	});
	it("allows cp of a secret to a real file", async () => {
		await expectAllows(harness, { command: "cp ~/.npmrc " + FIX + "/copy.txt" });
	});
	it("allows a write into a secret path", async () => {
		await expectAllows(harness, { command: "cp " + FIX + "/other ~/.npmrc" });
	});
	it("allows dd with a real of= target", async () => {
		await expectAllows(harness, { command: "dd if=" + FIX + "/.env of=" + FIX + "/copy" });
	});
	it("allows cat ~/.bw-session (not a secret-file class; guide recipe)", async () => {
		await expectAllows(harness, { command: "cat ~/.bw-session" });
	});
	it("allows cat of an ssh .pub key", async () => {
		await expectAllows(harness, { command: "cat ~/.ssh/id_ed25519.pub" });
	});
	it("allows cat ~/.ssh/known_hosts", async () => {
		await expectAllows(harness, { command: "cat ~/.ssh/known_hosts" });
	});
	it("allows a non-secret file read", async () => {
		await expectAllows(harness, { command: "cat " + FIX + "/notes.txt" });
	});
	it("allows wc -l on a secret file", async () => {
		await expectAllows(harness, { command: "wc -l ~/.npmrc" });
	});
	it("allows awk with a non-printing program", async () => {
		await expectAllows(harness, { command: "awk -v x=1 'BEGIN{exit 0}' ~/.npmrc" });
	});
	it("allows ls of the restic config dir", async () => {
		await expectAllows(harness, { command: "ls -la ~/.config/restic" });
	});
	it("allows grep -c nested in bash -c", async () => {
		await expectAllows(harness, { command: "bash -c 'grep -c token ~/.npmrc'" });
	});

	// ---- KNOWN GAP: the read tool (see the rule header) ----

	it("KNOWN GAP: allows the read tool on a secret path (pi-steering gates bash/write/edit only)", async () => {
		await expectAllows(harness, {
			type: "tool_call",
			toolName: "read",
			input: { path: "/home/pier/.npmrc" },
		} as never);
	});
});
