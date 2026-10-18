#!/usr/bin/env node
// Fails when a tool the model would normally see is missing from the
// `codemode.mode: "only"` codemode description (pushed out by
// `codemode.inlineBudget`). See https://github.com/cad0p/pi-config/issues/11
//
// Two offline pi runs against the agent dir (default: this checkout's agent/):
//   1. project override `codemode.mode: "on"`  → the declared tool set
//   2. committed settings (`mode: "only"`)     → the tools inlined in codemode
// Payloads are captured by capture-payload.ts before any HTTP call.
//
// The expected tools come from pi itself, so a broken install can't pass on
// the built-in tools alone:
//   - extensions that fail to load make pi exit 1 → no payload → check fails
//   - configured packages that aren't installed are skipped silently by pi, so
//     `pi list` must show an install path under every configured package
// See https://github.com/cad0p/pi-config/issues/13
//
// Env: PI_BIN (default "pi"), PI_CODING_AGENT_DIR, CODEMODE_CHECK_MODEL.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(here, "../.."));
const piBin = process.env.PI_BIN ?? "pi";
const model = process.env.CODEMODE_CHECK_MODEL ?? "anthropic/claude-haiku-5-5";
// Tools that orchestrate the others, or placeholders, are never inlined.
const NOT_INLINABLE = new Set(["codemode", "tool_search"]);
const isPlaceholder = (name) => name.startsWith("__pi_");

const piEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
const budget = settings.codemode?.inlineBudget ?? 3000;

function capture(label, projectSettings) {
	const cwd = mkdtempSync(join(tmpdir(), `codemode-check-${label}-`));
	if (projectSettings) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify(projectSettings));
	}
	const dump = join(cwd, "payload.json");
	const args = ["--model", model, "--api-key", "dummy", "--thinking", "off", "--no-session",
		"-e", join(here, "capture-payload.ts"), "-p", "ok"];
	const res = spawnSync(piBin, args, {
		cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
		env: { ...piEnv, CODEMODE_CHECK_DUMP: dump },
	});
	if (!existsSync(dump)) {
		console.error(`✗ [${label}] pi produced no payload (exit ${res.status})\n${res.stderr}\n${res.stdout}`);
		process.exit(2);
	}
	return JSON.parse(readFileSync(dump, "utf8"));
}

// `pi list` prints each configured package as "  <source>", followed by
// "    <install path>" only when the package is installed.
function uninstalledPackages() {
	const res = spawnSync(piBin, ["list"], { encoding: "utf8", env: piEnv, timeout: 60_000 });
	if (res.status !== 0) {
		console.error(`✗ pi list failed (exit ${res.status})\n${res.stderr}`);
		process.exit(2);
	}
	const missing = [];
	let pending = null;
	for (const line of res.stdout.split("\n")) {
		if (/^ {2}\S/.test(line)) {
			if (pending) missing.push(pending);
			pending = line.trim().split(" ")[0];
		} else if (/^ {4}\S/.test(line)) {
			pending = null;
		} else if (pending && !line.startsWith(" ")) {
			missing.push(pending);
			pending = null;
		}
	}
	if (pending) missing.push(pending);
	return missing;
}

const toolNames = (payload) => (payload.tools ?? []).map((t) => t.name);
const norm = (name) => name.toLowerCase();

const onPayload = capture("on", { codemode: { mode: "on" } });
const onlyPayload = capture("only", null);

const expected = toolNames(onPayload).filter((n) => !NOT_INLINABLE.has(norm(n)) && !isPlaceholder(n));
const onlyDeclared = toolNames(onlyPayload);
const codemode = (onlyPayload.tools ?? []).find((t) => t.name === "codemode");

let failed = false;
const notInstalled = uninstalledPackages();
if (notInstalled.length) {
	console.error(`✗ configured packages not installed (their tools are missing): ${notInstalled.join(", ")}`);
	failed = true;
}
if (!codemode) {
	console.error("✗ codemode is not active with the committed settings (need defaultTools: [\"+codemode\"])");
	process.exit(1);
}
const stillDeclared = onlyDeclared.filter((n) => !NOT_INLINABLE.has(norm(n)) && !isPlaceholder(n));
if (stillDeclared.length) {
	console.error(`✗ codemode.mode is not "only": still declared to the model: ${stillDeclared.join(", ")}`);
	failed = true;
}

const desc = codemode.description;
const inlined = [...desc.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]);
const inlinedSet = new Set(inlined.map(norm));
const missing = expected.filter((n) => !inlinedSet.has(norm(n)));

const nestedAt = desc.indexOf("\nNested tools:");
const usedTokens = nestedAt === -1 ? 0 : Math.ceil((desc.length - nestedAt) / 4);
console.log(`inlineBudget ${budget} · inlined ${inlined.length}/${expected.length} tools · ~${usedTokens} tokens used, ~${budget - usedTokens} headroom`);

if (missing.length) {
	console.error(`✗ not inlined in the codemode description (raise codemode.inlineBudget in agent/settings.json): ${missing.join(", ")}`);
	failed = true;
} else {
	console.log("✓ every declared tool is inlined in codemode");
}
process.exit(failed ? 1 : 0);
