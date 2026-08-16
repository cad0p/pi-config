// SPDX-License-Identifier: MIT
// Global pi-steering config (global layer — applies to every project).
//
// Loader (pi-steering 0.2.0+): exactly two fixed layers — project
// `<cwd>/.pi/steering/` + global `<agentDir>/steering/` (this dir).
// Defaults (DEFAULT_RULES: no-force-push, no-hard-reset, no-rm-rf-slash,
// no-long-running-commands) are layered on as the OUTERMOST position by
// buildConfig, so they still apply where this config doesn't carve out
// an exception.
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
// Layout: thin entry (this file) — all three plugins are shipped
// packages: git (pi-steering core), napkin (pi-napkin/steering),
// github (@cad0p/pi-steering-github: PR issue-link + vault body-file
// policy). Tests: ./integration.test.ts (loadHarness matrix against
// real vault fixtures).

import { defineConfig } from "@cad0p/pi-steering";
import type { PredicateShape } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import napkinSteeringPlugin from "@cad0p/pi-napkin/steering";
import githubPlugin from "@cad0p/pi-steering-github";
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
	plugins: [gitPlugin, napkinSteeringPlugin, githubPlugin, agentDirPlugin],
});
