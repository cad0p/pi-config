// SPDX-License-Identifier: MIT
/**
 * rm-relative-guard — a recursive `rm` on a RELATIVE path is refused
 * unless the same command `&&`-chains an absolute `cd` before it.
 *
 * Incident 2026-11-07 14:59Z (pc-host #587 live leg): the cleanup ran
 * `cd /home/pier/personal/github/pc-host-587live` and then, on a
 * SEPARATE statement, `rm -rf .local`. The worktree had already
 * vanished, the `cd` failed, and the `rm` ran in the shell's cwd —
 * the pc-tenant primary checkout — deleting pc-tenant/.local
 * (restored from restic snapshot 3fe41ed4). `cd X && rm -rf Y`
 * aborts the delete when the `cd` fails; `cd X; rm -rf Y` does not.
 * Same class as reflections/2026-11-04-a-failed-precondition-must-
 * abort-the-delete.
 *
 * Refused: `rm` carrying a recursive flag (`-r`, `-R`, `-rf`,
 * `-fr`, `--recursive` — any bundle containing r/R) with ANY path
 * operand that is not already anchored (`/…`, `~/…`, `$HOME/…`),
 * unless the same tool_call `&&`-chains an absolute `cd` before it.
 *
 * How the chain is read — NOT by re-parsing the command string. The
 * engine's own speculative-entry synthesis pass already models
 * `&&`-reachability (pi-steering README, "`&&`-chain speculative
 * allow"): an observer whose `watch` matches `cd <absolute path>`
 * writes a synthetic entry into every `&&`-reachable later ref's
 * `walkerState.events`, and `when.missing: { in: "tool_call" }`
 * reads exactly that view. `;` and `||` reset the chain, so
 * `cd /abs ; rm -rf rel` and `cd /abs || rm -rf rel` stay refused.
 * Any `&&`-reachable cd counts, not just the immediately preceding
 * ref: `cd /abs && echo x && rm -rf rel` is equally short-circuit
 * safe, which is the property the rule encodes.
 *
 * Flag detection reuses the rm plugin's own descriptor table
 * (`RM_RECURSIVE_FLAG` through the bound `ctx.command` facade), so
 * bundles (`-rf`, `-fr`, `-Rf`) and long forms agree with the
 * shipped `no-rm-rf-slash` rail by construction. Operands come from
 * `ctx.command.positionals()` — the same descriptor-bound argv view —
 * never from a hand-rolled shell split.
 *
 * Allowed: anchored operands (`/data/tmp/x`, `~/x`, `$HOME/x`),
 * non-recursive `rm` (`rm file`, `rm -f rel`), `git rm -r foo`
 * (basename `git`, so the rule never routes), and
 * `cd /data/tmp/wt && rm -rf .local`.
 *
 * Known gaps (deliberately out of scope, pinned in the test file):
 *   - `find <rel> -delete` — no `rm` ref exists at all;
 *     `find <rel> -exec rm -r {} +` does surface an `rm` ref, but its
 *     operands are find placeholders (`{}`), so the relative find ROOT
 *     is invisible here. Use an absolute find root plus the same cd
 *     discipline.
 *   - a wrapper payload (`bash -c 'cd /abs && rm -rf rel'`): the
 *     synthesis pass treats the wrapper ref as a chain break, so the
 *     inner cd never reaches the inner rm — the pair is refused
 *     (fail-closed; use an absolute path).
 *   - `xargs rm -r`, a script that runs rm internally, an `rm`
 *     reached through an alias/variable — steering sees only the
 *     agent's own commands.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Observer,
	Plugin,
	PredicateShape,
} from "@cad0p/pi-steering";
import { RM_RECURSIVE_FLAG } from "@cad0p/pi-steering/plugins/rm";

declare global {
	interface PiSteeringPredicates {
		/**
		 * `when.hasRecursiveRelativeOperand` — the `rm` ref carries a
		 * recursive flag AND at least one path operand that is not
		 * anchored (`/`, `~`, `$HOME`). Boolean leaf.
		 */
		hasRecursiveRelativeOperand: PredicateShape<boolean>;
	}
}

/**
 * The session-event type the observer below declares and the rule
 * reads. Only ever materialized SPECULATIVELY (per `&&`-chain), never
 * written to the session — see the observer's `onResult`.
 */
export const ABS_CD_EVENT = "absolute-cd-in-chain";

/**
 * A `cd` to an absolute path, matched against the ref's ENV-RESOLVED
 * text (`cd "$WS" && …` resolves to `cd /data/tmp/…` and matches;
 * an unresolvable `cd "$X"` stays raw and does not — fail-closed).
 */
export const ABSOLUTE_CD =
	/^cd\s+(?:\/|~(?=\/|$)|\$HOME(?=\/|$)|\$\{HOME\}(?=\/|$))/;

/** A path operand that is already anchored: absolute, `~` or `$HOME`. */
const ANCHORED = /^(?:\/|~(?=\/|$)|\$HOME(?=\/|$)|\$\{HOME\}(?=\/|$))/;

/** `find -exec` placeholders — argv tokens, never paths of their own. */
const FIND_PLACEHOLDER = new Set(["{}", "+", ";", "\\;"]);

/**
 * Does this operand list contain a path that is NOT anchored? Flag-
 * shaped words are skipped: the rm descriptor declares only
 * `recursive` / `force`, so an undeclared long flag
 * (`--one-file-system`) surfaces from `positionals()` as a word of
 * its own — it is a flag, not a path.
 */
export function hasRelativeOperand(operands: readonly string[]): boolean {
	for (const op of operands) {
		if (op === "") continue;
		if (op.startsWith("-")) continue;
		if (FIND_PLACEHOLDER.has(op)) continue;
		if (!ANCHORED.test(op)) return true;
	}
	return false;
}

/**
 * `when.hasRecursiveRelativeOperand` — recursive flag + a relative
 * operand. Both reads go through the descriptor-bound facade, so a
 * bundled `-rf` counts for `recursive` exactly as the shipped
 * `no-rm-rf-slash` predicate counts it.
 */
export const hasRecursiveRelativeOperand = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		if (ctx.input?.tool !== "bash") return false;
		if (!ctx.command.hasFlag(RM_RECURSIVE_FLAG)) return false;
		return hasRelativeOperand(ctx.command.positionals()) === expected;
	},
);

/**
 * Feeds the engine's `&&`-chain speculative synthesis pass: every ref
 * that is `&&`-reachable AFTER an absolute `cd` sees a synthetic
 * `ABS_CD_EVENT` entry in `walkerState.events`.
 *
 * `onResult` is a deliberate no-op. The observer exists for `watch` +
 * `writes` only (that is all the synthesis pass reads); writing a real
 * entry would add session noise for every successful `cd /abs` and
 * would be `agent_loop`-scoped, i.e. able to satisfy a LATER
 * tool_call — the rule reads `in: "tool_call"` (speculative entries
 * only) precisely so a cd in one command can never license a delete in
 * another.
 */
export const absoluteCdObserver = {
	name: "rm-relative-guard-absolute-cd",
	writes: [ABS_CD_EVENT],
	watch: { toolName: "bash", inputMatches: { command: ABSOLUTE_CD } },
	onResult: () => {
		// Intentionally empty — see the JSDoc above.
	},
} as const satisfies Observer;

/** The owner's message, verbatim (brief steering-rm-relative). */
const REASON =
	"recursive rm on a relative path: use an absolute path, or chain it as cd /abs/dir && rm -r rel (incident 2026-11-07 rm in wrong cwd)";

export const rmRelativeGuardRules = [
	{
		name: "no-recursive-rm-relative-path",
		tool: "bash" as const,
		command: "rm" as const,
		// Both leaves must hold: a recursive delete of a relative path,
		// AND no absolute `cd` in this `&&` chain (speculative scope).
		// `as const` keeps `missing.event` a literal so defineConfig's
		// writes-union check (Writes extends string) accepts it.
		when: {
			hasRecursiveRelativeOperand: true,
			missing: { event: ABS_CD_EVENT, in: "tool_call" },
		},
		reason: REASON,
	} as const,
];

export const rmRelativeGuardPlugin = {
	name: "rm-relative-guard",
	// No cliDescriptors: `rm` is declared by the rm plugin — the very
	// descriptor table this guard's flag read is bound to. Re-declaring
	// it only produces descriptor-collision warnings.
	predicates: { hasRecursiveRelativeOperand },
	observers: [absoluteCdObserver],
} as const satisfies Plugin;
