// SPDX-License-Identifier: MIT
// pnpm-lockfile guard tests — an npm install verb is refused where the
// repo carries a pnpm-lock.yaml (owner call 11, cad0p/pc-website#80:
// "yes, move to pnpm, one global store, the steering rule").
//
// The guard reads the REAL filesystem (the lockfile walk-up), so every
// scenario runs against real fixture dirs — the same convention
// integration.test.ts uses for the vault predicates.

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const RULE = "no-npm-install-in-pnpm-repo";
// The owner's message, verbatim (brief pnpm-steering-build), as a
// pattern — the engine prefixes a preamble + [steering:<rule>@<src>].
const REASON =
	/this repo uses pnpm: run pnpm install --frozen-lockfile \(one global store\)/;

/** Fixture dirs created per test, cleaned up after. */
const fixtures: string[] = [];

function makeFixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "steering-pnpm-"));
	fixtures.push(dir);
	return dir;
}

function makeDir(base: string, ...parts: string[]): string {
	const dir = join(base, ...parts);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** A pnpm repo: the lockfile that keys the guard, plus package.json. */
function makePnpmRepo(): string {
	const dir = makeFixtureDir();
	writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	writeFileSync(join(dir, "package.json"), "{}\n");
	return dir;
}

/** An npm repo: package.json + package-lock.json, no pnpm lockfile. */
function makeNpmRepo(): string {
	const dir = makeFixtureDir();
	writeFileSync(join(dir, "package.json"), "{}\n");
	writeFileSync(join(dir, "package-lock.json"), "{}\n");
	return dir;
}

afterEach(() => {
	for (const dir of fixtures.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("pnpm-lockfile guard", () => {
	const harness = loadHarness({ config });

	// ---- blocked: an npm install verb in a pnpm repo ----

	it("blocks npm install at a pnpm repo root", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: "npm install", cwd: repo }, { rule: RULE, reason: REASON });
	});
	it("blocks npm i (the install alias)", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: "npm i", cwd: repo }, { rule: RULE });
	});
	it("blocks npm ci", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: "npm ci", cwd: repo }, { rule: RULE });
	});
	it("blocks npm add lodash", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: "npm add lodash", cwd: repo }, { rule: RULE });
	});
	it("blocks npm install in a workspace member (walk-up past its own package.json)", async () => {
		// The pnpm workspace keeps ONE lockfile at the root: stopping at
		// the nearest package.json would open exactly this bypass.
		const repo = makePnpmRepo();
		const app = makeDir(repo, "packages", "app");
		writeFileSync(join(app, "package.json"), "{}\n");
		await expectBlocks(harness, { command: "npm install", cwd: app }, { rule: RULE });
	});
	it("blocks npm install in a deep subdirectory with no package.json", async () => {
		const repo = makePnpmRepo();
		const deep = makeDir(repo, "src", "lib", "deep");
		await expectBlocks(harness, { command: "npm install", cwd: deep }, { rule: RULE });
	});
	it("blocks cd <pnpm repo> && npm install (the walker resolves the cd prefix)", async () => {
		const repo = makePnpmRepo();
		const elsewhere = makeFixtureDir();
		await expectBlocks(
			harness,
			{ command: `cd ${repo} && npm install`, cwd: elsewhere },
			{ rule: RULE },
		);
	});
	it("blocks npm --prefix <pnpm repo> install (separate value)", async () => {
		const repo = makePnpmRepo();
		const elsewhere = makeFixtureDir();
		await expectBlocks(
			harness,
			{ command: `npm --prefix ${repo} install`, cwd: elsewhere },
			{ rule: RULE },
		);
	});
	it("blocks npm --prefix=<pnpm repo> ci (attached value)", async () => {
		const repo = makePnpmRepo();
		const elsewhere = makeFixtureDir();
		await expectBlocks(
			harness,
			{ command: `npm --prefix=${repo} ci`, cwd: elsewhere },
			{ rule: RULE },
		);
	});
	it("blocks --prefix after the verb (npm install --prefix <pnpm repo>)", async () => {
		const repo = makePnpmRepo();
		const elsewhere = makeFixtureDir();
		await expectBlocks(
			harness,
			{ command: `npm install --prefix ${repo}`, cwd: elsewhere },
			{ rule: RULE },
		);
	});
	it("blocks npm -g install x (global installs too — one global store)", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: "npm -g install x", cwd: repo }, { rule: RULE });
	});
	it("blocks a declared value-taking flag before the verb (npm --registry … install)", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(
			harness,
			{ command: "npm --registry https://example.test install", cwd: repo },
			{ rule: RULE },
		);
	});
	it("blocks the wrapper shape bash -c 'npm install' (the inner ref keeps the cwd)", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: "bash -c 'npm install'", cwd: repo }, { rule: RULE });
	});
	it("blocks the codemode-nested bash shape (sh -c 'npm ci')", async () => {
		// codemode's `await tools.bash({ command })` reaches steering as a
		// plain bash tool call; the wrapper form is the nested shape.
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: "sh -c 'npm ci'", cwd: repo }, { rule: RULE });
	});

	// ---- blocked: the directory cannot be placed (fail-closed) ----

	it("blocks cd \"$X\" && npm install (walker-unknown cwd)", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: 'cd "$X" && npm install', cwd: repo }, { rule: RULE });
	});
	it("blocks npm --prefix \"$X\" install (unresolvable prefix)", async () => {
		const repo = makePnpmRepo();
		await expectBlocks(harness, { command: 'npm --prefix "$X" install', cwd: repo }, { rule: RULE });
	});

	// ---- allowed: npm verbs that do not install ----

	it("allows npm view (a read)", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "npm view react version", cwd: repo });
	});
	it("allows npm --version", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "npm --version", cwd: repo });
	});
	it("allows npm run build", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "npm run build", cwd: repo });
	});
	it("allows npm test", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "npm test", cwd: repo });
	});
	it("allows npm ls", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "npm ls", cwd: repo });
	});
	it("allows npx (a different basename)", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "npx cowsay hi", cwd: repo });
	});

	// ---- allowed: pnpm itself ----

	it("allows pnpm install", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "pnpm install", cwd: repo });
	});
	it("allows pnpm install --frozen-lockfile (the message's own command)", async () => {
		const repo = makePnpmRepo();
		await expectAllows(harness, { command: "pnpm install --frozen-lockfile", cwd: repo });
	});

	// ---- allowed: repos without a pnpm-lock.yaml ----

	it("allows npm install in an npm repo (package-lock.json, no pnpm lockfile)", async () => {
		const repo = makeNpmRepo();
		await expectAllows(harness, { command: "npm install", cwd: repo });
	});
	it("allows npm ci in an npm repo", async () => {
		const repo = makeNpmRepo();
		await expectAllows(harness, { command: "npm ci", cwd: repo });
	});
	it("allows npm install in a subdirectory of an npm repo", async () => {
		const repo = makeNpmRepo();
		const sub = makeDir(repo, "packages", "lib");
		await expectAllows(harness, { command: "npm install", cwd: sub });
	});
	it("allows npm install in a plain directory (no package.json, no lockfile)", async () => {
		const dir = makeFixtureDir();
		await expectAllows(harness, { command: "npm install", cwd: dir });
	});
	it("allows cd <npm repo> && npm install", async () => {
		const repo = makeNpmRepo();
		const elsewhere = makeFixtureDir();
		await expectAllows(harness, { command: `cd ${repo} && npm install`, cwd: elsewhere });
	});
	it("allows npm --prefix <npm repo> install from a pnpm repo (prefix wins over the cwd)", async () => {
		const pnpmRepo = makePnpmRepo();
		const npmRepo = makeNpmRepo();
		await expectAllows(harness, {
			command: `cd ${pnpmRepo} && npm --prefix ${npmRepo} install`,
			cwd: pnpmRepo,
		});
	});
	it("allows npm install in a repo bounded by .git under a pnpm parent", async () => {
		// The walk-up stops at the repo boundary (checked after the
		// lockfile): a lockfile above another checkout's root is not
		// this repo's.
		const parent = makePnpmRepo();
		const bounded = makeDir(parent, "vendor", "bounded");
		mkdirSync(join(bounded, ".git"));
		writeFileSync(join(bounded, "package.json"), "{}\n");
		await expectAllows(harness, { command: "npm install", cwd: bounded });
	});

	// ---- known gaps (see pnpm-lockfile-guard.ts header) ----

	// KNOWN GAP: the walker starts a wrapper payload's refs from the
	// OUTER cwd (a subshell cd is not threaded), so a payload that cds
	// into the pnpm repo first is placed elsewhere. Pin the current
	// behaviour so a future fix flips this test.
	it("KNOWN GAP: allows bash -c 'cd <pnpm repo> && npm install' from elsewhere", async () => {
		const repo = makePnpmRepo();
		const elsewhere = makeFixtureDir();
		await expectAllows(harness, {
			command: `bash -c 'cd ${repo} && npm install'`,
			cwd: elsewhere,
		});
	});
});
