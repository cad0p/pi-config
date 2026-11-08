// SPDX-License-Identifier: MIT
// rm-relative-guard tests — a recursive `rm` on a relative path is
// refused unless the same command `&&`-chains an absolute `cd`.
//
// Incident 2026-11-07 (see rm-relative-guard.ts header): a cleanup's
// `cd` into a vanished worktree failed and a separate-statement
// `rm -rf .local` deleted pc-tenant/.local. The guard encodes the
// `&&` short-circuit property: the delete runs only if the cd ran.

import { describe, it } from "node:test";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const RULE = "no-recursive-rm-relative-path";
// The owner's verbatim message (brief steering-rm-relative), as a
// pattern — the engine prefixes a preamble + [steering:<rule>@<src>].
const REASON =
	/recursive rm on a relative path: use an absolute path, or chain it as cd \/abs\/dir && rm -r rel \(incident 2026-11-07 rm in wrong cwd\)/;

describe("rm-relative-guard", () => {
	const harness = loadHarness({ config });

	// ---- blocked: recursive rm on a relative path ----

	it("blocks rm -rf .local (the incident shape)", async () => {
		await expectBlocks(harness, { command: "rm -rf .local" }, { rule: RULE, reason: REASON });
	});
	it("blocks rm -r foo/bar", async () => {
		await expectBlocks(harness, { command: "rm -r foo/bar" }, { rule: RULE });
	});
	it("blocks rm -Rf rel (bundled uppercase recursive)", async () => {
		await expectBlocks(harness, { command: "rm -Rf rel" }, { rule: RULE });
	});
	it("blocks rm -fr rel (reversed bundle)", async () => {
		await expectBlocks(harness, { command: "rm -fr rel" }, { rule: RULE });
	});
	it("blocks rm --recursive rel (long flag)", async () => {
		await expectBlocks(harness, { command: "rm --recursive rel" }, { rule: RULE });
	});
	it("blocks rm -rf ./a /abs/b (one relative operand is enough)", async () => {
		await expectBlocks(harness, { command: "rm -rf ./a /abs/b" }, { rule: RULE });
	});
	it("blocks cd x; rm -rf y (relative cd + semicolon)", async () => {
		await expectBlocks(harness, { command: "cd x; rm -rf y" }, { rule: RULE });
	});
	it("blocks cd /abs ; rm -rf rel (semicolon does not short-circuit)", async () => {
		await expectBlocks(harness, { command: "cd /data/tmp/wt; rm -rf .local" }, { rule: RULE });
	});
	it("blocks cd /abs || rm -rf rel (|| does not short-circuit)", async () => {
		await expectBlocks(harness, { command: "cd /data/tmp/wt || rm -rf .local" }, { rule: RULE });
	});
	it("blocks cd rel && rm -rf rel (a relative cd licenses nothing)", async () => {
		await expectBlocks(harness, { command: "cd rel && rm -rf .local" }, { rule: RULE });
	});

	it("blocks rm -rf rel inside a bash -c payload", async () => {
		await expectBlocks(harness, { command: "bash -c 'rm -rf rel'" }, { rule: RULE });
	});
	it("blocks rm -rf / (shipped no-rm-rf-slash rail still owns the message)", async () => {
		await expectBlocks(harness, { command: "rm -rf /" }, { rule: "no-rm-rf-slash" });
	});

	// ---- allowed: anchored paths, non-recursive rm, git rm, &&-chained cd ----

	it("allows rm -rf /data/tmp/x (absolute)", async () => {
		await expectAllows(harness, { command: "rm -rf /data/tmp/x" });
	});
	it("allows rm -rf ~/x (tilde)", async () => {
		await expectAllows(harness, { command: "rm -rf ~/x" });
	});
	it("allows rm -rf $HOME/x (resolves to absolute)", async () => {
		await expectAllows(harness, { command: "rm -rf $HOME/x" });
	});
	it("allows cd /data/tmp/wt && rm -rf .local (the required shape)", async () => {
		await expectAllows(harness, { command: "cd /data/tmp/wt && rm -rf .local" });
	});
	it("allows cd /abs && echo x && rm -rf rel (any &&-reachable cd counts)", async () => {
		await expectAllows(harness, { command: "cd /data/tmp/wt && echo x && rm -rf rel" });
	});
	it("allows cd /abs && rm -rf ./a /abs/b (the &&-gated cd makes the relative operand's cwd explicit)", async () => {
		await expectAllows(harness, { command: "cd /data/tmp/wt && rm -rf ./a /abs/b" });
	});
	it("allows git rm -r foo (basename git, never routes)", async () => {
		await expectAllows(harness, { command: "git rm -r foo" });
	});
	it("allows rm file (no recursive flag)", async () => {
		await expectAllows(harness, { command: "rm file" });
	});
	it("allows rm -f rel (no recursive flag)", async () => {
		await expectAllows(harness, { command: "rm -f rel" });
	});

	// ---- known gaps (see rm-relative-guard.ts header) ----

	// KNOWN GAP: `find <rel> -delete` produces no rm ref at all; the
	// relative find root is invisible to steering. Out of scope per the
	// brief. Pin the current behaviour so a future fix flips this test.
	it("KNOWN GAP: allows find . -delete", async () => {
		await expectAllows(harness, { command: "find . -delete" });
	});
	// KNOWN GAP: `find <rel> -exec rm -r {} +` does expand to an rm ref,
	// but its operands are find placeholders (`{}`), not paths — the
	// relative find root is invisible here too.
	it("KNOWN GAP: allows find . -exec rm -r {} +", async () => {
		await expectAllows(harness, { command: "find . -exec rm -r {} +" });
	});
	// KNOWN GAP: the speculative `&&` pass treats the wrapper ref as a
	// chain break, so the inner cd never reaches the inner rm. Fail-
	// closed by design: use an absolute path.
	it("KNOWN GAP: blocks bash -c 'cd /abs && rm -rf rel' (wrapper breaks the chain)", async () => {
		await expectBlocks(harness, { command: "bash -c 'cd /data/tmp/wt && rm -rf rel'" }, { rule: RULE });
	});
});
