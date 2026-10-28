// SPDX-License-Identifier: MIT
// Global pi-steering config (global layer — applies to every project).
//
// Loader (pi-steering 0.2.0+): exactly two fixed layers — project
// `<cwd>/.pi/steering/` + global `<agentDir>/steering/` (this dir).
// Since #72 (0.2.0-20260825.0) there are NO engine-injected default
// rules: every rail is opt-in via a declared domain plugin —
//   - git    → no-force-push, no-hard-reset, no-main-commit(-github)
//   - rm     → no-rm-rf-slash
// (async's no-long-running-commands died with core #117 — the plugin
// was deleted, not restored per pi-steering#120 wont-do; dev-server
// availability is unmanaged again.)
// This config declares git + rm so protection is explicit and fully
// type-checked (disabledRules typos surface at compile time).
//
// Vault carve-out via the NAPKIN STEERING PLUGIN (pi-napkin #73):
// `@cad0p/pi-napkin/steering` registers an `isNapkinVault` predicate
// (read-only `.napkin/` walk-up from the command's effective cwd) and
// two exemptions narrowing the SHIPPED `no-main-commit` /
// `no-main-commit-github` guards to napkin vaults (Goldmine + distill
// scratch worktrees), where the napkin distill + note-edit flow
// commits to `main` by design. No VAULT_DIRS, no regex anchoring, no
// disabledRules — vaults are detected dynamically.
//
// gitPlugin MUST stay listed alongside: the plugin's exemptions target
// the git plugin's rule names; a missing target surfaces
// `exemption-orphan` warnings (strict mode throws).
//
// Exemptions are STRICTLY fail-closed: `onUnknown` is forbidden in
// exemption clauses, and unknown walker cwd never exempts — the guard
// still fires (its own `onUnknown` policy decides).
//
// Layout: thin entry (this file) — all four plugins are shipped or
// inline: git + rm (pi-steering core), napkin
// (pi-napkin/steering), github (@cad0p/pi-steering-github: PR
// issue-link + vault body-file policy). Tests: ./integration.test.ts
// (loadHarness matrix against real vault fixtures).

import { defineConfig } from "@cad0p/pi-steering";
import type { PredicateShape } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";
import napkinSteeringPlugin from "@cad0p/pi-napkin/steering";
import githubPlugin from "@cad0p/pi-steering-github";
// NOTE: `flagsPlugin` is deliberately NOT listed. The github plugin
// re-adopts `infoOnly` + `requiresFlagValue` from @cad0p/pi-steering-flags
// (same function references) and registers them itself — listing flags
// alongside only produces duplicate-predicate warnings, which DISABLE
// steering in strict mode (observed live). Single registration wins.
import { homedir } from "node:os";
import { join, sep } from "node:path";

declare global {
	/**
	 * `when.isUnderAgentDir` — true when the effective cwd is inside
	 * the pi agent dir (`~/.pi`). Registered by the inline
	 * `agent-dir` plugin; usable by any config that lists it.
	 * Fail-closed: unknown cwd → `"unknown"` sentinel.
	 */
	interface PiSteeringPredicates {
		isUnderAgentDir: PredicateShape<boolean>;
	}
}

/**
 * Agent-dir carve-out (`~/.pi`) — mirrors the napkin-vault exemption
 * pattern: the pi config repo (`~/.pi/agent/steering`, github
 * cad0p/pi-config) is committed to `main` directly by design (no PR
 * flow on a personal config repo — the repo ruleset carries no
 * `pull_request` rule). Commits under `~/.pi` are configuration
 * management, not code — the guard would otherwise fire on every
 * config sync. Exemption is STRICTLY fail-closed: unknown cwd never
 * exempts, and anything outside the agent dir still hits
 * `no-main-commit` / `no-main-commit-github`.
 */
const AGENT_DIR = join(homedir(), ".pi");

const agentDirPlugin = {
	name: "agent-dir",
	predicates: {
		isUnderAgentDir: (args: unknown, ctx: { cwd: string }) => {
			if (args !== true) return false;
			const cwd = ctx.cwd;
			if (typeof cwd !== "string" || cwd === "unknown") return "unknown";
			return cwd === AGENT_DIR || cwd.startsWith(AGENT_DIR + sep);
		},
	},
	exemptions: [
		{ rule: "no-main-commit", when: { isUnderAgentDir: true } },
		{ rule: "no-main-commit-github", when: { isUnderAgentDir: true } },
	],
};

export default defineConfig({
	// Strict-at-test-time, resilient-at-runtime: `failOnWarnings: false`
	// keeps rails live when the merger reports KNOWN-benign diagnostics
	// (gh descriptor overload set — first-entry-wins, pinned exactly in
	// integration.test.ts, which fails on ANY new diagnostic). Runtime
	// strict would disable ALL steering on those warnings (fail-open
	// sessions — observed live). See core: same-table overload warnings
	// are a flat-namespace artifact; per-subcommand scoping is the fix.
	failOnWarnings: false,
	plugins: [
		gitPlugin,
		rmPlugin,
		napkinSteeringPlugin,
		githubPlugin,
		agentDirPlugin,
	],
});
