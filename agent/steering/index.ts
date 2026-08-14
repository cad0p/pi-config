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
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import napkinSteeringPlugin from "@cad0p/pi-napkin/steering";
import githubPlugin from "@cad0p/pi-steering-github";

export default defineConfig({
	plugins: [gitPlugin, napkinSteeringPlugin, githubPlugin],
});
