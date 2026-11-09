// SPDX-License-Identifier: MIT
// bw-cli-guard tests — printing a Bitwarden vault secret, minting a
// session key, echoing BW_SESSION, or a bare bwbio (implicit key
// rotation) is refused; read-free shapes stay allowed.
//
// Source: Goldmine personal/guides/2026-10-07-bitwarden-cli-session-scoping.md.
// No command is executed: the harness only evaluates the verdict.
//
// KNOWN GAP pinned at the end: pi-steering evaluates each command ref on
// its own, so a capture ($(...)) or a pipe consumer is invisible; those
// non-printing shapes are refused too (fail-closed).

import { describe, it } from "node:test";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const MINT = "no-bw-session-mint";
const PRINT = "no-bw-secret-print";
const ROT = "no-bwbio-implicit-rotation";
const ECHO = "no-bw-session-echo";

const D = String.fromCharCode(36);
const SESSION = "BW_SESSION=\"$(cat ~/.bw-session)\"";

describe("bw-cli-guard", () => {
	const harness = loadHarness({ config });

	// ---- refused: printing a vault secret ----

	it("blocks bw get password", async () => {
		await expectBlocks(harness, { command: "bw get password npm-token" }, { rule: PRINT });
	});
	it("blocks bw get totp", async () => {
		await expectBlocks(harness, { command: "bw get totp item-id" }, { rule: PRINT });
	});
	it("blocks bw get notes", async () => {
		await expectBlocks(harness, { command: "bw get notes item-id" }, { rule: PRINT });
	});
	it("blocks bw get item (full JSON)", async () => {
		await expectBlocks(harness, { command: "bw get item item-id" }, { rule: PRINT });
	});
	it("blocks bw get attachment", async () => {
		await expectBlocks(harness, { command: "bw get attachment att-id --itemid item-id" }, { rule: PRINT });
	});
	it("blocks bw get password --raw", async () => {
		await expectBlocks(harness, { command: "bw get password npm-token --raw" }, { rule: PRINT });
	});
	it("blocks bw get --raw password (flag before the class)", async () => {
		await expectBlocks(harness, { command: "bw get --raw password X" }, { rule: PRINT });
	});
	it("blocks bw --session KEY get password (value-taking flag before the subcommand)", async () => {
		await expectBlocks(harness, { command: "bw --session abc get password X" }, { rule: PRINT });
	});
	it("blocks bw list items", async () => {
		await expectBlocks(harness, { command: "bw list items" }, { rule: PRINT });
	});
	it("blocks bw list items with a search filter", async () => {
		await expectBlocks(harness, { command: "bw list items --search npm" }, { rule: PRINT });
	});
	it("blocks bw export", async () => {
		await expectBlocks(harness, { command: "bw export" }, { rule: PRINT });
	});
	it("blocks bw export --format json", async () => {
		await expectBlocks(harness, { command: "bw export --format json --output /data/tmp/x" }, { rule: PRINT });
	});
	it("blocks a bw get nested in sh -c (codemode-nested bash shape)", async () => {
		await expectBlocks(harness, { command: "sh -c 'bw get password X'" }, { rule: PRINT });
	});
	it("blocks a bw get under sudo", async () => {
		await expectBlocks(harness, { command: "sudo bw get password X" }, { rule: PRINT });
	});
	it("blocks a bw get with an env wrapper", async () => {
		await expectBlocks(harness, { command: "env FOO=1 bw get password X" }, { rule: PRINT });
	});
	it("blocks bwbio get item with a session (pure passthrough, still prints)", async () => {
		await expectBlocks(harness, { command: SESSION + " bwbio get item foo" }, { rule: PRINT });
	});

	// ---- refused: minting a session key (guide L25, L30, L55) ----

	it("blocks bw unlock --raw", async () => {
		await expectBlocks(harness, { command: "bw unlock --raw" }, { rule: MINT });
	});
	it("blocks plain bw unlock", async () => {
		await expectBlocks(harness, { command: "bw unlock" }, { rule: MINT });
	});
	it("blocks quiet bw unlock --raw", async () => {
		await expectBlocks(harness, { command: "bw unlock --raw --quiet" }, { rule: MINT });
	});
	it("blocks bw unlock --raw with the truncating redirect (guide L25 footgun)", async () => {
		await expectBlocks(harness, { command: "bw unlock --raw > ~/.bw-session" }, { rule: MINT });
	});
	it("blocks bw login --raw", async () => {
		await expectBlocks(harness, { command: "bw login user@example.com --raw" }, { rule: MINT });
	});
	it("blocks plain bw login", async () => {
		await expectBlocks(harness, { command: "bw login" }, { rule: MINT });
	});

	// ---- refused: implicit bwbio rotation (guide L19, L42, L46) ----

	it("blocks the incident shape bwbio get item without a session", async () => {
		await expectBlocks(harness, { command: "bwbio get item 'piercloud.net (pc-control/vapid)'" }, { rule: ROT });
	});
	it("blocks bwbio get password without a session", async () => {
		await expectBlocks(harness, { command: "bwbio get password X" }, { rule: ROT });
	});
	it("blocks bwbio list items without a session", async () => {
		await expectBlocks(harness, { command: "bwbio list items" }, { rule: ROT });
	});
	it("blocks bwbio unlock --raw without a session", async () => {
		await expectBlocks(harness, { command: "bwbio unlock --raw" }, { rule: MINT });
	});
	it("blocks bwbio --nointeraction get password (no-interaction is not a help flag)", async () => {
		await expectBlocks(harness, { command: "bwbio --nointeraction get password X" }, { rule: PRINT });
	});

	// ---- refused: echoing BW_SESSION (guide L73) ----

	it("blocks echo of the session variable", async () => {
		await expectBlocks(harness, { command: "echo " + D + "BW_SESSION" }, { rule: ECHO });
	});
	it("blocks echo of the braced session variable", async () => {
		await expectBlocks(harness, { command: "echo " + D + "{BW_SESSION}" }, { rule: ECHO });
	});
	it("blocks printf %s of the session variable", async () => {
		await expectBlocks(harness, { command: "printf '%s\\n' " + D + "BW_SESSION" }, { rule: ECHO });
	});
	it("blocks echo of the session variable in a label", async () => {
		await expectBlocks(harness, { command: "echo \"BW_SESSION=" + D + "BW_SESSION\"" }, { rule: ECHO });
	});
	it("blocks echo of an exported session in a chain", async () => {
		await expectBlocks(harness, { command: "export BW_SESSION=abc && echo " + D + "BW_SESSION" }, { rule: ECHO });
	});

	// ---- allowed: non-printing / non-secret forms ----

	it("allows bw status", async () => {
		await expectAllows(harness, { command: "bw status" });
	});
	it("allows bw sync", async () => {
		await expectAllows(harness, { command: "bw sync" });
	});
	it("allows bw list folders", async () => {
		await expectAllows(harness, { command: "bw list folders" });
	});
	it("allows bw list collections", async () => {
		await expectAllows(harness, { command: "bw list collections" });
	});
	it("allows bw list organizations", async () => {
		await expectAllows(harness, { command: "bw list organizations" });
	});
	it("allows bw get username", async () => {
		await expectAllows(harness, { command: "bw get username item-id" });
	});
	it("allows bw get uri", async () => {
		await expectAllows(harness, { command: "bw get uri item-id" });
	});
	it("allows bw --version", async () => {
		await expectAllows(harness, { command: "bw --version" });
	});
	it("allows bw help", async () => {
		await expectAllows(harness, { command: "bw help" });
	});
	it("allows bw get password --help (help output only)", async () => {
		await expectAllows(harness, { command: "bw get password --help" });
	});
	it("allows bw list items --help", async () => {
		await expectAllows(harness, { command: "bw list items --help" });
	});
	it("allows bw export --help", async () => {
		await expectAllows(harness, { command: "bw export --help" });
	});
	it("allows bw unlock --help", async () => {
		await expectAllows(harness, { command: "bw unlock --help" });
	});
	it("allows bw lock", async () => {
		await expectAllows(harness, { command: "bw lock" });
	});
	it("allows bw logout", async () => {
		await expectAllows(harness, { command: "bw logout" });
	});
	it("allows bw config server", async () => {
		await expectAllows(harness, { command: "bw config server https://vault.example" });
	});
	it("allows bw generate (a new secret, not an existing one)", async () => {
		await expectAllows(harness, { command: "bw generate --length 24" });
	});
	it("allows bw encode", async () => {
		await expectAllows(harness, { command: "bw encode hello" });
	});
	it("allows bare bwbio (usage, no rotation — guide L56)", async () => {
		await expectAllows(harness, { command: "bwbio" });
	});
	it("allows bwbio --bwbio-version", async () => {
		await expectAllows(harness, { command: "bwbio --bwbio-version" });
	});
	it("allows bwbio status without a session (passthrough allowlist)", async () => {
		await expectAllows(harness, { command: "bwbio status" });
	});
	it("allows bwbio lock without a session", async () => {
		await expectAllows(harness, { command: "bwbio lock" });
	});
	it("allows a prefixed session on bwbio status (passthrough)", async () => {
		await expectAllows(harness, { command: SESSION + " bwbio status" });
	});
	it("allows BW_NOINTERACTION=true bwbio status (guide L56)", async () => {
		await expectAllows(harness, { command: "BW_NOINTERACTION=true bwbio status" });
	});
	it("allows bwbio --nointeraction status", async () => {
		await expectAllows(harness, { command: "bwbio --nointeraction status" });
	});
	it("allows the guide recipe export session && bw status", async () => {
		await expectAllows(harness, { command: "export " + SESSION + " && bw status" });
	});
	it("allows cat ~/.bw-session (the recipe's read)", async () => {
		await expectAllows(harness, { command: "cat ~/.bw-session" });
	});
	it("allows echo hello", async () => {
		await expectAllows(harness, { command: "echo hello" });
	});
	it("allows plain printf", async () => {
		await expectAllows(harness, { command: "printf 'x\\n'" });
	});
	it("allows the guide's env grep verification (0 matches)", async () => {
		await expectAllows(harness, { command: "env | grep '^BW_SESSION='" });
	});

	// ---- KNOWN GAP: capture / pipe wrappers are invisible per ref ----

	it("KNOWN GAP: blocks a captured bw get (capture wrapper not visible)", async () => {
		await expectBlocks(harness, { command: "VAR=" + D + "(bw get password X)" }, { rule: PRINT });
	});
	it("KNOWN GAP: blocks a piped bw get", async () => {
		await expectBlocks(harness, { command: "bw get password X | some-cmd --password-stdin" }, { rule: PRINT });
	});
	it("KNOWN GAP: blocks a projected bw list items", async () => {
		await expectBlocks(harness, { command: "bw list items | jq '.[] | {id,name}'" }, { rule: PRINT });
	});
	it("KNOWN GAP: blocks a redirected bw get (redirect not visible)", async () => {
		await expectBlocks(harness, { command: "bw get password X > /data/tmp/x" }, { rule: PRINT });
	});
});
