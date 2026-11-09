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
// tools/merge-pr.sh"), ./ref-write-guard.ts (no plumbing writes to
// main/master — update-ref, branch -f, checkout -B, switch -C,
// forced fetch refspecs; reset --hard and force-push stay on the
// shipped no-hard-reset / no-force-push rails), ./primary-checkout-guard.ts
// (the primary checkout of a pc-* repo stays on main — no branch, no
// commit, no edit there; work in a worktree), ./design-check-gate.ts
// (E1: a lens/fold brief at round >= 3 needs the latest design-check
// file, round >= 6 is refused (owner rule: split at round 5), and a
// check answering 'causing: yes' may not say 'verdict: continue'; every
// brief write needs the pr/round/kind header; pc-host #704 adds the one
// round definition, the split-piece shrink rule, the lens head binding,
// the absorb-of binding and the posted-verdicts fold rule — see
// ./base-rules.ts),
// ./critical-path-slip.ts (E4: a slipped critical path needs a replan
// entry before another brief for a non-done item; and a reset of
// critical-path.json may not drop an unfinished item, pc-host #703 D8),
// ./open-work-gate.ts (pc-host #703 D7: no new brief while the armed
// open-work ledger lists dropped PRs; dormant until open-work.json
// says armed: true) and
// ./threat-model-required.ts (E5: red-team/trust-model lens briefs
// need a 'Threat model:' line; issue/PR vault bodies need a
// 'threat-model:' frontmatter key) and
// ./rm-relative-guard.ts (a recursive rm on a relative path is
// refused unless the same command &&-chains an absolute cd —
// incident 2026-11-07 rm in the wrong cwd deleted pc-tenant/.local) and
// ./tsh-guard.ts (no agent may change the shared Teleport client state
// ~/.tsh: no login/logout without an isolated TELEPORT_HOME, no
// write/edit/cp/mv/rm/tee/sed -i into it, and tsh ssh/scp/ls/status/
// proxy/db/kube need --proxy= or TELEPORT_PROXY= on the shared home —
// owner ruling 2026-11-08) and
// ./critical-path-label-guard.ts (agents never apply or remove the
// owner's critical-path label on a cad0p/pc-* repo: the merge queue's
// actor check binds the flag to account 14107574, which agent sessions
// share — pc-host #714 r1 red-team F2) and
// ./prelaunch-compat-guard.ts (every brief carries 'consumers:' —
// either the pre-launch default 'none — pre-launch: no tenant slices
// run; no compatibility window is owed' or a concrete running consumer
// plus 'evidence: <path:line or URL>'; with the default, a brief whose
// body demands compatibility work — backwards compatibility,
// already-signed releases that must stay verifiable, dual readers,
// compatibility/migration/deprecation windows — is refused, and a
// design check whose rationale assumes the obligation is refused too;
// the rule lived only in prose and #148 item D and pc-tenant #228 both
// paid for it) and
// ./pnpm-lockfile-guard.ts (where a repo carries a pnpm-lock.yaml,
// an npm install verb — install/i/ci/add — is refused: "this repo uses
// pnpm: run pnpm install --frozen-lockfile (one global store)"; the
// effective directory comes from the walker's cwd plus npm --prefix,
// owner call 11 / pc-website #80) and
// ./secret-file-read-guard.ts (a bash command that would print a known
// secret file — ~/.npmrc, *.env/.env*, *.pem/*.key, ~/.ssh/id_*, gh/
// aws/docker/rclone/restic credential files — into the transcript is
// refused: the printing consumers only, so hashes, silent compares,
// counts/queries, masked `sed` and writes stay allowed; the READ tool
// is not gateable, pi-steering 0.2.0 rules are bash/write/edit) and
// ./bw-cli-guard.ts (no bw/bwbio command may print a vault secret or
// rotate the cached session: `bw get password|totp|notes|item|attachment`,
// `bw list items`, `bw export`, `bw unlock/login`, echo/printf of
// BW_SESSION, and bare `bwbio <cmd>` without BW_SESSION are refused —
// guide personal/guides/2026-10-07-bitwarden-cli-session-scoping).
// Tests: ./integration.test.ts
// (loadHarness matrix against real vault fixtures), ./merge-guard.test.ts
// (the merge guard's positive/negative matrix) and
// ./ref-write-guard.test.ts (the argv matcher's block/allow matrix) and
// ./rm-relative-guard.test.ts (the relative-path block/allow matrix) and
// ./tsh-guard.test.ts (the shared-Teleport-home block/allow matrix) and
// ./secret-file-read-guard.test.ts (the secret-print block/allow matrix,
// incl. the read-tool gap) and ./bw-cli-guard.test.ts (the bw/bwbio
// block/allow matrix, incl. the capture/pipe gap) and
// ./pnpm-lockfile-guard.test.ts (the npm-in-a-pnpm-repo block/allow
// matrix over real lockfile fixtures) and
// ./prelaunch-compat-guard.test.ts (the consumers-header and
// compatibility-demand block/allow matrix, incl. the #228 design
// brief).

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
import { devShmGuardPlugin, devShmRules } from "./dev-shm-guard.ts";
import { refWriteGuardPlugin, refWriteGuardRules } from "./ref-write-guard.ts";
import { gitIdentityGuardPlugin, gitIdentityRules } from "./git-identity-guard.ts";
import { mergeGuardPlugin, mergeGuardRules } from "./merge-guard.ts";
import {
	primaryCheckoutGuardPlugin,
	primaryCheckoutRules,
} from "./primary-checkout-guard.ts";
import {
	worktreeGuardPlugin,
	worktreeGuardRules,
} from "./worktree-guard.ts";
import {
	designCheckGatePlugin,
	designCheckRules,
} from "./design-check-gate.ts";
import {
	criticalPathSlipPlugin,
	criticalPathSlipRules,
} from "./critical-path-slip.ts";
import { openWorkGatePlugin, openWorkGateRules } from "./open-work-gate.ts";
import {
	threatModelRequiredPlugin,
	threatModelRules,
} from "./threat-model-required.ts";
import {
	rmRelativeGuardPlugin,
	rmRelativeGuardRules,
} from "./rm-relative-guard.ts";
import { tshGuardPlugin, tshGuardRules } from "./tsh-guard.ts";
import {
	criticalPathLabelGuardPlugin,
	criticalPathLabelRules,
} from "./critical-path-label-guard.ts";
import {
	secretFileReadGuardPlugin,
	secretFileReadGuardRules,
} from "./secret-file-read-guard.ts";
import { bwCliGuardPlugin, bwCliGuardRules } from "./bw-cli-guard.ts";
import {
	pnpmLockfilePlugin,
	pnpmLockfileRules,
} from "./pnpm-lockfile-guard.ts";
import {
	prelaunchCompatPlugin,
	prelaunchCompatRules,
} from "./prelaunch-compat-guard.ts";
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
	plugins: [
		gitPlugin,
		rmPlugin,
		napkinSteeringPlugin,
		githubPlugin,
		agentDirPlugin,
		agentConfigGuardPlugin,
		devShmGuardPlugin,
		refWriteGuardPlugin,
		gitIdentityGuardPlugin,
		mergeGuardPlugin,
		primaryCheckoutGuardPlugin,
		worktreeGuardPlugin,
		designCheckGatePlugin,
		criticalPathSlipPlugin,
		openWorkGatePlugin,
		threatModelRequiredPlugin,
		rmRelativeGuardPlugin,
		tshGuardPlugin,
		criticalPathLabelGuardPlugin,
		secretFileReadGuardPlugin,
		bwCliGuardPlugin,
		pnpmLockfilePlugin,
		prelaunchCompatPlugin,
	],
	rules: [
		...mergeGuardRules,
		// The primary-checkout guard owns the most specific message ("edit
		// in a worktree") for the verbs the shipped no-main-commit /
		// no-main-ref-write rails also refuse. Both are user rules, so
		// both precede every plugin rule.
		...primaryCheckoutRules,
		// pc-host #764: worktrees are created by pc-wt and removed by the reap.
		...worktreeGuardRules,
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
		...refWriteGuardRules,
		...gitIdentityRules,
		...designCheckRules,
		// The consumers header and the pre-launch compatibility rule: a
		// brief may not assume an obligation nobody has (pc-tenant #228).
		...prelaunchCompatRules,
		...criticalPathSlipRules,
		...openWorkGateRules,
		...threatModelRules,
		...rmRelativeGuardRules,
		...tshGuardRules,
		...criticalPathLabelRules,
		...secretFileReadGuardRules,
		...bwCliGuardRules,
		...pnpmLockfileRules,
	],
});
