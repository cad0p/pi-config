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
 * guard's redirect coverage needs). This module turns an absent flag into
 * a loud failure: the layer import throws, the loader reports
 * `layer-import-failed` with this message, and `pi-steering list` shows
 * it. Failing loudly is the point — the alternative is a session that
 * believes it is guarded and is not.
 *
 * Read through a NAMESPACE import (`import * as piSteering`): a named
 * import of a symbol the old version does not export is itself a module
 * error, and its message would not say what to install.
 */

/** What the config needs from the framework, in one line for the error. */
export const LOCKED_RULES_REQUIREMENT =
	"@cad0p/pi-steering with lockedRules and PredicateContext.rawCommand";

/** Throws unless the loaded framework enforces locked rules. */
export function assertLockedRulesSupport(
	framework: Record<string, unknown>,
): void {
	if (framework["LOCKED_RULES_SUPPORTED"] === true) return;
	throw new Error(
		`[pi-config] refusing to load: this config declares lockedRules, but the loaded ${LOCKED_RULES_REQUIREMENT} is missing. ` +
			"On that version lockedRules is an unknown field — accepted, never enforced — so a project layer can still disable a locked rail silently. " +
			"Install the release that ships the lock before checking out this config, or check out the previous commit. " +
			"Checked with: process.env.PI_CODING_AGENT_DIR + the layer's own imports.",
	);
}
