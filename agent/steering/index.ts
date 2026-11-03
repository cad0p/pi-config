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
// issue-link + vault body-file policy). Local guards: agent-config
// (inline below), ./dev-shm-guard.ts, ./git-identity-guard.ts,
// ./merge-guard.ts (agents do not merge directly — the design's
// P1-W1 step 1: one rule, one message, "merge through
// tools/merge-pr.sh"), ./config-write-guard.ts (agents do not write
// `.pi/steering/**` — a TRIPWIRE for honest mistakes, not a boundary:
// its header lists what it does not catch; the lock below is what refuses
// a project layer's disarm, and neither stops this agent's uid from
// rewriting this file — design note owner question 1, "Where the agent
// trust boundary lives").
// Tests: ./integration.test.ts
// (loadHarness matrix against real vault fixtures),
// ./merge-guard.test.ts (the merge guard's positive/negative matrix),
// ./config-write-guard.test.ts (what the tripwire catches AND the gaps it
// declares, both pinned) and ./lockdown.test.ts (project-layer disables
// of a locked rail, the agent-dir hijack, granular drops).

// Namespace import on purpose: the capability gate below must survive a
// framework that lacks the flag (a NAMED import of `LOCKED_RULES_SUPPORTED`
// would be a module error whose message does not say what to install).
import * as piSteering from "@cad0p/pi-steering";
import { defineConfig } from "@cad0p/pi-steering";
import type { PredicateShape } from "@cad0p/pi-steering";
import { assertLockedRulesSupport, snapshotHomeDir } from "./framework-support.ts";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";
import napkinSteeringPlugin from "@cad0p/pi-napkin/steering";
import githubPlugin from "@cad0p/pi-steering-github";
// NOTE: `flagsPlugin` is deliberately NOT listed. The github plugin
// re-adopts `infoOnly` + `requiresFlagValue` from @cad0p/pi-steering-flags
// (same function references) and registers them itself — listing flags
// alongside only produces duplicate-predicate warnings, which DISABLE
// steering in strict mode (observed live). Single registration wins.
import { devShmGuardPlugin, devShmRules } from "./dev-shm-guard.ts";
import { gitIdentityGuardPlugin, gitIdentityRules } from "./git-identity-guard.ts";
import { mergeGuardPlugin, mergeGuardRules } from "./merge-guard.ts";
import {
	configWriteGuardPlugin,
	configWriteGuardRules,
} from "./config-write-guard.ts";
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
		touchesAgentConfig: PredicateShape<boolean>;
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
 *
 * The home directory is the framework's PROCESS snapshot (taken at the
 * first steering read), never a live home read: this module is
 * re-evaluated on every load, so a fresh read followed whatever `HOME`
 * a project layer's timer left behind and moved the exemption with it
 * (lens round 4, red-team F1). Read after the capability gate below,
 * which also requires the snapshot accessor.
 */
// Capability gate (functional F4): a lockedRules config is SILENTLY INERT
// on a framework that does not enforce it, so refuse to load instead of
// pretending. Throwing here surfaces as `layer-import-failed` with this
// message in `pi-steering list` and the session log.
assertLockedRulesSupport(piSteering as unknown as Record<string, unknown>);

const AGENT_DIR = join(snapshotHomeDir(), ".pi");

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

/**
 * Agent-config guard — prevents the coding agent from mutating its own
 * model-selection / guardrail config. Root cause of the 2026-10-28
 * incident: an agent `sed`-ed general-purpose.md to
 * `opencode-go-3/deepseek-v4-pro` for "stronger" review lenses and never
 * restored the backup, burning the Go quota. Config changes go through
 * the user, not through tool calls. Fail-closed: unknown cwd /
 * unresolvable command → block.
 */
const PROTECTED_AGENT_CONFIG = /\.pi\/agent\/(agents(\/|$)|settings\.json)/;

const agentConfigGuardPlugin = {
	name: "agent-config-guard",
	cliDescriptors: {
		sed: {},
		cp: {},
		tee: {},
		mv: {},
		chmod: {},
		chattr: {},
		python: {},
		python3: {},
		perl: {},
		awk: {},
		node: {},
		bash: {},
		sh: {},
	},
	predicates: {
		touchesAgentConfig: (
			args: unknown,
			ctx: { input?: { command?: string }; walkerState?: { cwd?: unknown } },
		) => {
			if (args !== true) return false;
			const cmd =
				typeof ctx?.input?.command === "string" ? ctx.input.command : "";
			if (PROTECTED_AGENT_CONFIG.test(cmd)) return true;
			const cwd = ctx?.walkerState?.cwd;
			if (typeof cwd === "string" && /\/\.pi\/agent\/agents(\/|$)/.test(cwd))
				return true;
			return false;
		},
	},
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
	// Explicit so the lock has an owner value to freeze: while a
	// lockedRules declaration is present, a project layer cannot flip this
	// to `false` to make every rule overridable with a
	// `# steering-override: <rule>` comment (see the LOCKS comment below).
	defaultNoOverride: true,
	// LOCKS (pi-steering `lockedRules`). Precedence across layers is
	// inner-wins for rule bodies and a UNION for disabledRules /
	// disabledPlugins / exemptions — so without locks any project layer
	// could delete a global rail by name, ship a do-nothing rule under
	// the same name, add an exemption, disable the shipping plugin, or
	// escalate `failOnWarnings` until the refusal diagnostic itself
	// aborts the session. Red-team F1 (2026-11-03) proved exactly that
	// for agents-do-not-merge-directly.
	//
	// A lock binds OUTWARD ONLY (round-1 fold, functional F1 / R-F1 /
	// trust F1): this layer is the outermost, so its locks bind against
	// every project layer, and a project layer that declares lockedRules
	// itself gains nothing — it can neither exempt itself nor own the
	// booleans. No self-exemption: a rail is retired by removing the lock
	// and the rule, not by disabling around it.
	//
	// The lock also covers the REGISTRY the rule depends on (R-F2): the
	// predicate keys it names, its observers, its CLI descriptors and the
	// plugins that provide them — a project plugin that re-declares
	// `attemptsDirectMerge` would otherwise neuter the rule while its
	// text stayed intact. An error-class declaration in an inner layer is
	// dropped on its own (`layer-part-dropped-on-error`: the plugin, rule,
	// observer or exemption at fault, one at a time, so several
	// independent faults are each dropped and the rest of the repo's layer
	// stays), and the whole inner layer only when no removal clears an
	// error (`layer-dropped-on-error`). Drops and import failures are
	// printed and raised in chat as one summary per load.
	// The framework resolves this layer's directory ONCE per pi process,
	// before any project code runs, and reuses it on every /reload, so a
	// project layer cannot point PI_CODING_AGENT_DIR (or HOME) elsewhere
	// to swap this layer out — not at import time and not later from a
	// timer. Every rail here that derives a path from the home directory
	// (the agent-dir exemption, the git-identity rail, the tripwire's `~`)
	// reads the framework's process snapshot, never a live HOME, so a
	// respelled, empty or relative HOME moves none of them; the framework's
	// env check on top only restores the variable and warns (advisory).
	//
	// What the lock does NOT do: it binds what a project layer DECLARES.
	// It does not stop the agent's own uid from editing this file or its
	// imports, and a project layer is still code executed in the pi
	// process (it could patch the loader in memory). See the design
	// note's residuals.
	//
	// Locked here: every rule THIS layer declares — its own content, the
	// merge guard first among them. Shipped git / rm / github rails stay
	// project-customizable for now (that is the documented override
	// path); extending the lock to them is owner question 2 ("Lock
	// scope") in the design
	// note Goldmine personal/github/pi-config/plans/2026-11-03-lock-global-rails.md.
	lockedRules: [
		"agents-do-not-merge-directly",
		"no-agent-config-edit",
		"no-agent-config-write",
		"no-agent-config-bash-mutation",
		"no-dev-shm-write",
		"no-dev-shm-edit",
		"no-dev-shm-bash",
		"no-global-git-identity",
		"no-global-git-config-write",
		"no-global-git-config-edit",
		"no-global-git-config-bash-mutation",
		"no-steering-config-edit",
		"no-steering-config-write",
		"no-steering-config-bash-mutation",
	],
	plugins: [
		gitPlugin,
		rmPlugin,
		napkinSteeringPlugin,
		githubPlugin,
		agentDirPlugin,
		agentConfigGuardPlugin,
		devShmGuardPlugin,
		gitIdentityGuardPlugin,
		mergeGuardPlugin,
		configWriteGuardPlugin,
	],
	rules: [
		...mergeGuardRules,
		{
			name: "no-agent-config-edit",
			tool: "edit",
			field: "path",
			pattern: /\.pi\/agent\/(agents\/|settings\.json)/,
			reason:
				"Do not edit agent definitions or settings.json — they control model selection and guardrails. Make the change manually or ask the user.",
		},
		{
			name: "no-agent-config-write",
			tool: "write",
			field: "path",
			pattern: /\.pi\/agent\/(agents\/|settings\.json)/,
			reason:
				"Do not overwrite agent definitions or settings.json — they control model selection and guardrails. Make the change manually or ask the user.",
		},
		{
			name: "no-agent-config-bash-mutation",
			tool: "bash",
			command: [
				"sed",
				"cp",
				"tee",
				"mv",
				"chmod",
				"chattr",
				"python",
				"python3",
				"perl",
				"awk",
				"node",
				"bash",
				"sh",
			],
			when: { touchesAgentConfig: true },
			reason:
				"Do not mutate agent definitions or settings.json via shell — they control model selection and guardrails. Make the change manually or ask the user.",
		},
		...devShmRules,
		...gitIdentityRules,
		...configWriteGuardRules,
	],
});
