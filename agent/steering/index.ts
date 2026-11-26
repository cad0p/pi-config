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
// write/edit/cp/mv/rm/tee/sed -i into it, tsh ssh/scp/proxy/db/kube need
// --proxy= or TELEPORT_PROXY= on the shared home — owner ruling
// 2026-11-08 — and, since the 2026-11-22 discovery incident, a
// shared-home bare 'tsh ls' (no --all/-R) is refused: list every cluster
// with the native 'tsh ls --all' instead (status is read-only and always
// passes), and a tsh ssh/scp naming a known node of the other cluster is
// refused with the right proxy) and
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
// ./probe-scope-guard.ts (an ad-hoc probe may not run unbounded: an
// unbounded busy wait, setsid/nohup/start_new_session, an endless sleep,
// or a systemd-run without a positive RuntimeMaxSec is refused unless the
// same command carries a bound — timeout <n>, --property=RuntimeMaxSec=<n>
// or PC_PROBE_BOUNDED=1; incident 2026-11-11, a backgrounded `while :; do`
// probe survived its turn because a background job in this harness ignores
// SIGINT, so kill -INT is a no-op, and burned one core for 11.5 h) and
// ./unit-name-guard.ts (2026-11-23, measured in one hour: lane H4
// named a full CI run pc-gate-xbx1 — every lane reads pc-gate-* as "a gate
// is running" (owner rule r) and held its CI queue for the whole run — and
// unit a2-four.service ran an untracked
// ~/.local/state/h4-orchestration/tmp-1319/a2-four.sh whose body did a
// 'git worktree add' outside pc-wt, invisible to every guard. R1
// unit-name-gate-reserved refuses a systemd-run unit named pc-gate-/pc-land-
// /pc-q*/pc-preflight- unless the same command runs merge-run.sh or
// merge-pr.sh with gate|queue|land|preflight|absorb; R2
// systemd-run-no-script-execstart refuses a systemd-run whose command is
// 'bash <path>' / 'sh <path>' / the path itself for a script under
// /data/tmp, ~/.local/state/h4-orchestration or ~/.cache — write the
// command inline (bash -c '...') so the guards see it; tracked tools
// (tools/*.sh, Goldmine Scripts/orchestration/*) stay allowed. Tests:
// ./unit-name-guard.test.ts.) and
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
// guide personal/guides/2026-10-07-bitwarden-cli-session-scoping) and
// ./queue-land-nudge.ts (a `--mode local` merge of a PR that is this
// repo's merge queue entry is refused: the queue's own turn —
// `queue land <repo>` — gates the rebuilt main+PR candidate and lands it,
// so a main move no longer costs an absorb and a re-gate; PC_MERGE_LOCAL_OK=1
// is the visible escape, and every unreadable state ALLOWS — a nudge, the
// opposite policy from merge-guard's fail-closed refusal; pc-host #836 has
// shipped the turn since 2026-11-10 and the gate-plus-pair is still what
// sessions type) and
// ./no-bare-citation.ts (owner rule R4, approved 2026-11-15: a PR/issue
// body or comment may not cite code by a bare path:NN -- line numbers
// move. Cite a permalink pinned to a 40-hex commit, or name the symbol;
// a body whose first non-blank line names the head (Lens: ... @ <40hex>)
// is bound to one commit and passes, and a note whose frontmatter date is
// before ACTIVATION_DATE is exempt while in-flight PRs refresh) and
// ./vision-review.ts (pc-host #983: a vision review cannot be answered
// with a bare "FIT". A 'kind: lens' brief must carry a '## VISION REVIEW'
// section naming the candidate invariant ids from the canonical list
// (the repo's docs/invariants.md when it has one, else the piercloud
// product invariants V1-V17), the answer shape per invariant (id, one
// verdict word, the evidence: a file:line, a measured number, or an
// artifact), the out-of-scope question, and the token set
// FIT | MOSTLY-FIT | UNFIT - UNFIT, never MISFIT; a posted 'Vision:' line
// must name at least one canonical id and carry a reason ('Vision: FIT'
// and 'Vision: FIT - reviewed' are refused, and so is an invented id);
// and a brief, note or PR/issue body that proposes a host-to-guest
// execution path ('incus exec', 'a guest agent', 'exec into the guest')
// must cite V4 and how the design satisfies it - a statement of fact
// ('incus exec does not work') is not a proposal).
// ./goldmine-shared-guard.ts (the vault
// /home/pier/personal/github/Goldmine is ONE checkout shared by many
// concurrent sessions: a `git pull --autostash` sweeps another session's
// in-progress edit into a stash and a pathspec-less `git commit` sweeps
// its staged work into a foreign commit — measured 2026-11-22. R1
// goldmine-no-autostash refuses autostash pulls/rebases, a bare stash and
// a pathspec-less `stash push`; R2 goldmine-commit-needs-pathspec refuses
// a commit with no `--` paths (and `--only` without paths), `commit -a`,
// `add -A/--all`, `add .`; both teach the scoped form, both read the
// walker's cwd and `git -C`, and both re-read a `sh -c` payload; the
// vault's gm-commit.sh helper stays allowed (it uses commit-tree and
// never pulls, stashes or stages). Tests:
// ./goldmine-shared-guard.test.ts.)
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
// brief) and ./probe-scope-guard.test.ts (the unbounded-probe
// block/allow matrix, the incident red/green pair, the fake-bound
// cases and the pinned raw-command gap) and ./unit-name-guard.test.ts
// (the reserved-unit-name and script-ExecStart block/allow matrices, the
// two 2026-11-23 specimens, and the pinned textual gaps) and
// ./queue-land-nudge.test.ts
// (the --mode local of the queue entry block/allow matrix, the
// PC_MERGE_LOCAL_OK=1 escape, the fail-open states and the pinned gaps).

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
import { sharedTmpGuardPlugin, sharedTmpRules } from "./shared-tmp-guard.ts";
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
	goldmineSharedGuardPlugin,
	goldmineSharedGuardRules,
} from "./goldmine-shared-guard.ts";
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
	reconcileAcceptPlugin,
	reconcileAcceptRules,
} from "./reconcile-accept-guard.ts";
import {
	queueLandNudgePlugin,
	queueLandNudgeRules,
} from "./queue-land-nudge.ts";
import {
	pnpmLockfilePlugin,
	pnpmLockfileRules,
} from "./pnpm-lockfile-guard.ts";
import {
	prelaunchCompatPlugin,
	prelaunchCompatRules,
} from "./prelaunch-compat-guard.ts";
import {
	probeScopeGuardPlugin,
	probeScopeGuardRules,
} from "./probe-scope-guard.ts";
import {
	unitNameGuardPlugin,
	unitNameGuardRules,
} from "./unit-name-guard.ts";
import {
	visionReviewPlugin,
	visionReviewRules,
} from "./vision-review.ts";
import {
	syntheticLoadGuardPlugin,
	syntheticLoadGuardRules,
} from "./synthetic-load-guard.ts";
import {
	noBareCitationPlugin,
	noBareCitationRules,
} from "./no-bare-citation.ts";
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
		sharedTmpGuardPlugin,
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
		goldmineSharedGuardPlugin,
		criticalPathLabelGuardPlugin,
		secretFileReadGuardPlugin,
		bwCliGuardPlugin,
		reconcileAcceptPlugin,
		pnpmLockfilePlugin,
		prelaunchCompatPlugin,
		probeScopeGuardPlugin,
		// The reserved gate/land/queue unit names, and no script ExecStart
		// (2026-11-23: pc-gate-xbx1 held every lane's CI queue; a2-four.sh
		// hid a worktree add from the guards).
		unitNameGuardPlugin,
		syntheticLoadGuardPlugin,
		queueLandNudgePlugin,
		visionReviewPlugin,
		noBareCitationPlugin,
	],
	rules: [
		...mergeGuardRules,
		// pc-host #836's turn is the cheap path; the gate-plus-pair it
		// replaces is what sessions still type (./queue-land-nudge.ts).
		...queueLandNudgeRules,
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
		...sharedTmpRules,
		...refWriteGuardRules,
		...gitIdentityRules,
		...designCheckRules,
		// The consumers header and the pre-launch compatibility rule: a
		// brief may not assume an obligation nobody has (pc-tenant #228).
		...prelaunchCompatRules,
		// An ad-hoc probe may not outlive its turn (incident 2026-11-11).
		...probeScopeGuardRules,
		// pc-gate-/pc-land-/pc-q*/pc-preflight- names are the merge tools'
		// (owner rule r), and a systemd-run ExecStart may not hide its work
		// in a /data/tmp or state-dir script (2026-11-23).
		...unitNameGuardRules,
		// pc-host #1273: synthetic CPU load on the shared lane fails the
		// gates; only a cgroup-capped systemd-run unit is allowed.
		...syntheticLoadGuardRules,
		...criticalPathSlipRules,
		...openWorkGateRules,
		...threatModelRules,
		...rmRelativeGuardRules,
		// The vault is a shared checkout: scoped commit, no autostash.
		...goldmineSharedGuardRules,
		...tshGuardRules,
		...criticalPathLabelRules,
		...secretFileReadGuardRules,
		...bwCliGuardRules,
		...reconcileAcceptRules,
		...pnpmLockfileRules,
		// pc-host #983: the vision review is graded, not just present.
		...visionReviewRules,
		// Owner rule R4: a PR/issue body cites code by a commit-pinned
		// permalink or by symbol, never a bare path:NN.
		...noBareCitationRules,
	],
});
