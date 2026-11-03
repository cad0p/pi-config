// SPDX-License-Identifier: MIT
/**
 * Config-write guard — agents do not write steering configuration.
 *
 * WHY (2026-11-03, red-team F1 on the per-repo steering design). A
 * project layer's `disabledRules` is UNIONED with the global layer's, so
 * a repo whose `.pi/steering/index.ts` says
 * `{ disabledRules: ["agents-do-not-merge-directly"] }` deleted the
 * global merge guard with no collision, no prompt and no diagnostic
 * (the lens proved `gh api -X PUT …/pulls/4242/merge` ALLOWED). Writes to
 * `.pi/steering/**` were unguarded — the inline agent-config guard only
 * covers `~/.pi/agent/agents/**` and `~/.pi/agent/settings.json` — so an
 * agent could plant that file with the `write` tool, and README
 * "Security" says the project layer is "arbitrary TypeScript executed at
 * the first `session_start`".
 *
 * WHAT THIS COVERS: the `write` / `edit` tools and the writer binaries
 * aimed at
 *   - any `<repo>/.pi/steering/**` (including the `.pi/steering.ts`
 *     shorthand) — the plant path that disables a global rail;
 *   - any `<repo>/.pi/settings.json` — project settings can declare
 *     packages / extensions, i.e. code that rides the same trust gate.
 *
 * WHAT IT DOES NOT COVER (stated as part of the claim):
 *   - the GLOBAL layer, `<agentDir>/steering/**`. Deliberately out of
 *     scope here: agents maintain it under owner direction, and a guard
 *     on it would stop that workflow. It stays an open exposure (see the
 *     design note, owner question 2).
 *   - writers this text guard cannot see: commands built by expansion /
 *     `eval` / aliases, a script written elsewhere and then executed,
 *     `cd .pi && cd steering && printf … > index.ts`, a `write` whose cwd
 *     is already inside a steering directory (the tool sees only the
 *     relative path), a relocated `PI_CODING_AGENT_DIR`, and any non-pi
 *     harness.
 *   - the OWNER: this binds agent tool calls only.
 * It is the anti-plant half. The load-time half (`lockedRules` in the
 * global layer, refusing a project-layer disable of a locked rule) is
 * what closes the hole; this rule must never be the only defense.
 */

import type { PredicateShape } from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		touchesSteeringConfig: PredicateShape<boolean>;
	}
}

/**
 * A steering-config path, anywhere in a path string:
 *   - `<repo>/.pi/steering` and everything under it,
 *   - `<repo>/.pi/steering.ts` (the file-form shorthand),
 *   - `<repo>/.pi/settings.json`.
 *
 * Anchored to a path boundary — start, `/`, or a shell delimiter
 * (whitespace, quote, `=`, `(`, `,`, `[`) — so a relative plant
 * (`> .pi/steering/index.ts`) matches while a name that merely ENDS in
 * those words (`notes/.pi/steering-old.md`, `.pi/settings.json.bak`)
 * does not.
 * The agent-dir form (`~/.pi/agent/steering`) intentionally does not
 * match — see the header.
 */
const STEERING_CONFIG_PATH =
	/(?:^|[\s"'\`=:(,\[\/\\])\.pi[\/](?:steering(?:[\/]|$)|steering\.ts$|settings\.json$)/;

/**
 * Binaries that can create or mutate a file: shell interpreters, text
 * writers, redirect producers, copies, patch tools and version control.
 * Routing on the basename is the rule's first filter; the path-shaped
 * `touchesSteeringConfig` predicate decides the verdict.
 */
export const STEERING_CONFIG_WRITERS = [
	"bash",
	"sh",
	"zsh",
	"dash",
	"fish",
	"env",
	"xargs",
	"find",
	"sed",
	"awk",
	"perl",
	"python",
	"python3",
	"node",
	"ruby",
	"php",
	"tee",
	"cp",
	"mv",
	"ln",
	"install",
	"dd",
	"truncate",
	"touch",
	"rm",
	"mkdir",
	"rmdir",
	"chmod",
	"chown",
	"rsync",
	"patch",
	"tar",
	"unzip",
	"curl",
	"wget",
	"echo",
	"printf",
	"cat",
	"npx",
	"npm",
	"pnpm",
	"git",
	"go",
	"make",
	"cargo",
	"docker",
] as const;

/**
 * Basenames whose `cliDescriptors` another plugin in this config
 * already declares (the inline agent-config guard and dev-shm-guard).
 * Re-declaring one produces a descriptor-collision warning, and with
 * `failOnWarnings: false` it only spams the log — but the roster must
 * stay collision-free, so the rest are declared here.
 */
const DECLARED_ELSEWHERE = new Set([
	// rm plugin (pi-steering core) — `rm` is declared there
	"rm",
	// inline agent-config-guard (index.ts)
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
	// dev-shm-guard
	"mkdir",
	"rsync",
	"git",
	"tar",
	"touch",
	"install",
	"ln",
	"dd",
	"truncate",
	"fallocate",
	"mktemp",
	"unzip",
	"curl",
	"wget",
	"go",
	"make",
	"cargo",
	"npm",
	"pnpm",
	"docker",
	"env",
]);

export const configWriteGuardPlugin = {
	name: "config-write-guard",
	cliDescriptors: Object.fromEntries(
		STEERING_CONFIG_WRITERS.filter((b) => !DECLARED_ELSEWHERE.has(b)).map(
			(b) => [b, {}],
		),
	),
	predicates: {
		/**
		 * Does this bash command text mention a steering-config path?
		 * Text-based on purpose: the path SHAPE is what matters, so a
		 * command whose cwd the walker cannot resolve still matches, and a
		 * blocked command whose text has the path is blocked either way.
		 */
		touchesSteeringConfig: (
			args: unknown,
			ctx: {
				input?: { command?: string; basename?: string };
				rawCommand?: string;
			},
		) => {
			if (args !== true) return false;
			// TWO views on purpose. `input.command` is the per-ref argv view;
			// `rawCommand` is the full tool_call text, so it carries the parts
			// that are not refs at all — a redirect target (`echo x > f`), a
			// heredoc body, and the segments around `&&` / `;`. Without the
			// raw view the commonest plant (a redirect) is invisible: the
			// `echo` ref's own text stops before the `>`.
			const raw = typeof ctx?.rawCommand === "string" ? ctx.rawCommand : "";
			const view =
				typeof ctx?.input?.command === "string" ? ctx.input.command : "";
			if (!STEERING_CONFIG_PATH.test(raw) && !STEERING_CONFIG_PATH.test(view)) {
				return false;
			}
			// Read-only uses of the print/read trio stay allowed: reading a
			// repo's project layer is legitimate review work. Only a redirect
			// (or a downstream tee, which is its own ref and matches on its
			// own) turns them into writers.
			const basename = ctx?.input?.basename;
			if (basename === "cat" || basename === "echo" || basename === "printf") {
				return />>?(?![>&])/.test(raw) || /\btee\b/.test(raw);
			}
			return true;
		},
	},
};

const REASON =
	"Do not write pi steering configuration (.pi/steering/**, .pi/steering.ts, .pi/settings.json). A project layer's disabledRules / disabledPlugins / exemptions silently rewrite the global rails — that is how any repo could switch off agents-do-not-merge-directly (red-team F1, 2026-11-03) — and project steering is arbitrary TypeScript executed at session start. Steering changes go through the owner: write the proposed change somewhere else and ask, do not apply it.";

export const configWriteGuardRules = [
	{
		name: "no-steering-config-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: STEERING_CONFIG_PATH,
		reason: REASON,
	},
	{
		name: "no-steering-config-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: STEERING_CONFIG_PATH,
		reason: REASON,
	},
	{
		name: "no-steering-config-bash-mutation",
		tool: "bash" as const,
		command: [...STEERING_CONFIG_WRITERS],
		when: { touchesSteeringConfig: true },
		reason: REASON,
	},
];
