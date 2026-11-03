// SPDX-License-Identifier: MIT
/**
 * Framework capability gate — refuse to load this config on a framework
 * that would silently ignore its locks.
 *
 * `lockedRules` is an ADDITIVE field: a pi-steering release that does
 * not implement it accepts the property, logs nothing and enforces
 * nothing. Activating this config on 0.2.0 therefore looks healthy while
 * every locked rail is still disarmable by a project layer — the exact
 * fail-open the feature exists to close (functional F4, trust "inert on
 * 0.2.0").
 *
 * The framework exports `LOCKED_RULES_SUPPORTED = true` once it enforces
 * locks (and populates `PredicateContext.rawCommand`, which the write
 * guard's redirect coverage needs), and `agentDirSnapshot()`, the process
 * snapshot of the home directory the config's agent-dir exemption reads
 * (lens round 4). This module turns an absent flag or accessor into
 * a loud failure: the layer import throws, the loader reports
 * `layer-import-failed` with this message, and `pi-steering list` shows
 * it. Failing loudly is the point — the alternative is a session that
 * believes it is guarded and is not.
 *
 * Read through a NAMESPACE import (`import * as piSteering`): a named
 * import of a symbol the old version does not export is itself a module
 * error, and its message would not say what to install.
 */

import * as piSteering from "@cad0p/pi-steering";

/** What the config needs from the framework, in one line for the error. */
export const LOCKED_RULES_REQUIREMENT =
	"@cad0p/pi-steering with lockedRules, PredicateContext.rawCommand and agentDirSnapshot()";

/** Throws unless the loaded framework enforces locked rules. */
export function assertLockedRulesSupport(
	framework: Record<string, unknown>,
): void {
	// The agent-dir snapshot accessor ships with the same framework change
	// (lens round 4): the config reads its home directory from it.
	if (
		framework["LOCKED_RULES_SUPPORTED"] === true &&
		typeof framework["agentDirSnapshot"] === "function"
	)
		return;
	throw new Error(
		`[pi-config] refusing to load: this config declares lockedRules, but the loaded ${LOCKED_RULES_REQUIREMENT} is missing. ` +
			"On that version lockedRules is an unknown field — accepted, never enforced — so a project layer can still disable a locked rail silently. " +
			"Install the release that ships the lock before checking out this config, or check out the previous commit. " +
			"Checked with: the framework this layer imports (the one next to the agent dir the framework resolved).",
	);
}

/**
 * The home directory every rail in this layer derives a path from: the
 * framework's PROCESS snapshot, taken at the first steering read (lens
 * round 5). No module of this layer reads `homedir()`, `process.env.HOME`,
 * `USERPROFILE` or `PI_CODING_AGENT_DIR` itself; a source scan pins that
 * (`live-home-scan.test.ts`). The layer is re-evaluated on every load, so
 * a live read would follow whatever `HOME` a project layer left behind —
 * respelled through a symlink, empty or relative — and move the rails
 * with it. Runs the capability gate first, so an old framework fails with
 * the gate's message, not a TypeError.
 */
export function snapshotHomeDir(): string {
	const framework = piSteering as unknown as Record<string, unknown>;
	assertLockedRulesSupport(framework);
	return (framework["agentDirSnapshot"] as () => { homeDir: string })().homeDir;
}
