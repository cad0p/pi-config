// SPDX-License-Identifier: MIT
/**
 * reconcile-accept-guard — an incident **acceptance** is an owner action.
 *
 * Owner ruling 2026-11-11, verbatim: "sudo-gated accept but I think a
 * steering rule is enough honestly". So this rule is the control, and it is
 * deliberately the simple one: agents do not accept incidents at all; the
 * owner runs the acceptance from his own terminal.
 *
 * Why it exists. `tools/reconcile.sh accept <id> "<quote>"` needs nothing but a
 * non-empty string, and the tool says so in its own acceptance mail: "Any
 * session can run that command; this mail makes an acceptance the owner did
 * not give visible". That is detection, not prevention. `cmd_accept` marks the
 * incident `accepted` in `~/.local/state/pc-merge/incidents/<repo-key>.json`,
 * and an accepted `unrecorded-merge` incident is exactly what makes the
 * helper's P2 provenance check (`tools/lib/pc-merge.sh`,
 * `pcm_pchost_provenance`) treat a main commit with no merge record as
 * recorded — the next clean sweep then writes
 * `~/.local/state/pc-merge/helper-trusted-sha`, the sha the gate executes on
 * this host as `pier`. A quote an agent can type is not evidence. On
 * 2026-11-11 two owner `--admin` merges (#905, #916) each opened an incident
 * and the agent accepted both with a quote the owner had typed in chat.
 *
 * Also refused, on the same routing and for the same reason (owner decision
 * 2026-11-13, decision note
 * personal/github/pc-host/decisions/2026-11-13-budget-authorization-is-an-owner-action.md):
 * `reconcile.sh budget ...`, the verb that records the authorization a repo's
 * declared `gate-budget:` is honoured by. An agent that could run it could move
 * the bar it is judged by, so it is the owner's, and the authorization mail is
 * the tell outside the routings this rule sees.
 *
 * Refused: `reconcile.sh accept ...` in every spelling the walker exposes —
 * `tools/reconcile.sh accept ...`, `./tools/...`, an absolute path,
 * `bash tools/reconcile.sh accept ...`, `bash -c '... reconcile.sh accept'`,
 * and under a passthrough wrapper (`sudo`, `env`, `nice`, `nohup`, `xargs`,
 * `strace`), which the walker expands into an inner ref of its own. `sweep`,
 * `incident` and every other subcommand stay allowed — this rule is not
 * "agents never run reconcile".
 *
 * The owner's one-liner (fill in the id from the incident mail):
 *   cd ~/personal/github/pc-host && bash tools/reconcile.sh accept <id> "<quote>"
 *
 * Also refused: writing the merge helper's trust state through the write/edit
 * tools — `helper-trusted-sha`, `incidents.json` and the per-repo
 * `incidents/<repo-key>.json` store under `~/.local/state/pc-merge/`.
 * Accepting an incident and editing that state are the same act; blocking only
 * the first would be theatre.
 *
 * Routing note (the one non-obvious bit). A bash rule routes on the ref's
 * basename, and `bash tools/reconcile.sh accept ...` is ONE ref — basename
 * `bash`, args `[tools/reconcile.sh, accept, ...]`. The walker does not
 * descend into a script invocation (only `-c` payloads and the passthrough
 * wrappers named above), so the rule routes on the shells too and the
 * predicate reads the script position itself. The `bash` / `sh` descriptors
 * are declared by `agentConfigGuardPlugin` in index.ts — one declaration per
 * basename (a second one only earns a "duplicate CLI descriptor" warning and
 * the first-registered table wins, but integration.test.ts fails on any new
 * diagnostic) — exactly as ./dev-shm-guard.ts and ./primary-checkout-guard.ts
 * rely on them. Pinned in the test: a plain `bash -c 'echo hi'` must stay
 * allowed, which is what fails first if that descriptor ever disappears
 * (an undeclared routed basename fails CLOSED: MissingDescriptorError on
 * every such ref).
 *
 * Known gaps, deliberately pinned rather than papered over:
 *   - a bash redirect or a shell writer into those paths (`printf ... >
 *     helper-trusted-sha`, `sed -i`, `cp`, `tee`) is not seen: pi-steering
 *     does not expose redirect targets, and routing every writer binary would
 *     refuse ordinary work.
 *   - an interpreter outside the routed set wins the ref: `zsh`,
 *     `dash`, `ksh` (only their `-c` payloads are expanded) and the
 *     non-wrappers `timeout`, `setsid`, `systemd-run`, `unbuffer`.
 *   - a script path held entirely in a variable (`bash "$TOOL" accept ...`) is
 *     not resolvable; a variable-held *prefix*
 *     (`bash "$REPO/tools/reconcile.sh"`) still matches, because the last
 *     segment is literal.
 *   - an agent that writes its own script and runs it is not seen; this rule
 *     matches the command ref, like every other rail in this config.
 *   - `helper-trusted-sha` is a plain file in the agent's writable state root.
 *     Making the trusted state live on main (so a merge has to agree to it) is
 *     the structural follow-up, not this rule.
 */

import { definePredicate, unwrapBooleanLeafArg } from "@cad0p/pi-steering";
import type {
	BooleanLeafArgs,
	Plugin,
	PredicateContext,
	PredicateShape,
} from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		/** `when.reconcileAcceptsIncident` — a `reconcile.sh accept` ref. */
		reconcileAcceptsIncident: PredicateShape<boolean>;
		/** `when.reconcileSetsBudget` — a `reconcile.sh budget` ref. */
		reconcileSetsBudget: PredicateShape<boolean>;
	}
}

/** The tool whose `accept` subcommand is the owner's. */
const SCRIPT = "reconcile.sh";

/**
 * Shells whose script position is read as the command (the walker expands
 * their `-c` payloads but not their script invocation). Exactly the basenames
 * the rule routes on; an interpreter outside this set is a known gap above.
 */
const SHELL_BASENAMES = ["bash", "sh"] as const;
const SHELLS = new Set<string>(SHELL_BASENAMES);

/** `reconcile.sh` flags that take a value (none today; kept for parity). */
const SCRIPT_VALUE_FLAGS = new Set<string>([]);

/**
 * Shell flags that consume the NEXT word, so it is not read as the script:
 * `bash -o errexit tools/reconcile.sh ...`, `sh --rcfile <f> ...`. `-c`
 * is not here — its payload is a command string, never a script path, and
 * the walker expands it into refs of its own.
 */
const SHELL_VALUE_FLAGS = new Set([
	"-o",
	"+o",
	"-O",
	"+O",
	"--rcfile",
	"--init-file",
]);

/**
 * Subcommand + operands of the ref. Flags are skipped (a glued
 * `--flag=value` is one word), `--` is skipped as an option terminator, and
 * the value of a known value-taking flag is skipped too.
 */
function positionals(
	ctx: PredicateContext,
	valueFlags: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	const words = ctx.input?.args ?? [];
	for (let i = 0; i < words.length; i++) {
		const value = (words[i]?.value ?? words[i]?.text ?? "").trim();
		if (value === "") continue;
		if (value === "--") continue;
		if (value.startsWith("-") || value.startsWith("+")) {
			if (valueFlags.has(value)) i++;
			continue;
		}
		out.push(value);
	}
	return out;
}

/** The last path segment of a word (`tools/reconcile.sh` → `reconcile.sh`). */
function scriptBasename(word: string): string {
	const trimmed = word.replace(/\/+$/, "");
	const cut = trimmed.lastIndexOf("/");
	return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * The subcommand of a `reconcile.sh` ref, or `undefined` when the ref is not
 * one. `tools/reconcile.sh <sub> ...`, an absolute or `./` path to it, or a
 * `bash` / `sh` ref whose script position is `reconcile.sh`.
 */
function reconcileSubcommand(ctx: PredicateContext): string | undefined {
	if (ctx.input?.tool !== "bash") return undefined;
	const basename = ctx.input.basename ?? "";
	if (basename === SCRIPT) return positionals(ctx, SCRIPT_VALUE_FLAGS)[0];
	if (SHELLS.has(basename)) {
		// `bash tools/reconcile.sh accept ...` is a single ref: the first
		// positional is the script, the rest belong to it. `bash -c '...'`
		// is expanded by the walker into inner refs of their own, so its
		// payload never reads as a script path here.
		const [script, ...rest] = positionals(ctx, SHELL_VALUE_FLAGS);
		if (script === undefined || scriptBasename(script) !== SCRIPT) {
			return undefined;
		}
		return rest[0];
	}
	return undefined;
}

/**
 * `when.reconcileAcceptsIncident` — is this ref an incident acceptance?
 * Faithful for both polarities: the answer is the ref's, and
 * `when: { ...: true }` is the only use here.
 */
export const reconcileAcceptsIncident = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		return (reconcileSubcommand(ctx) === "accept") === expected;
	},
);

/**
 * `when.reconcileSetsBudget` — is this ref a per-repo gate-budget
 * authorization? Same routing, same refusals, same gaps as `accept`: the verb
 * writes the record `tools/merge-pr.sh` reads to honour a repo's declared
 * `gate-budget:`, so an agent that could run it could move the bar it is judged
 * by (owner decision 2026-11-13, decision note
 * personal/github/pc-host/decisions/2026-11-13-budget-authorization-is-an-owner-action.md).
 */
export const reconcileSetsBudget = definePredicate<BooleanLeafArgs>(
	(args, ctx) => {
		const expected = unwrapBooleanLeafArg(args);
		if (expected === undefined) return false;
		return (reconcileSubcommand(ctx) === "budget") === expected;
	},
);

const ACCEPT_REASON = `blocked: an incident acceptance is an owner action.

tools/reconcile.sh accept needs only a non-empty quote, and an accepted
unrecorded-merge incident is what makes the helper's provenance check treat an
unrecorded main commit as recorded — the next clean sweep then writes
~/.local/state/pc-merge/helper-trusted-sha, the sha the gate runs on this host
as pier. A quote an agent can type is not evidence, so agents never accept.
Everything else (sweep, incident, --help) stays allowed.

The owner runs, in his own terminal:
  cd ~/personal/github/pc-host && bash tools/reconcile.sh accept <id> "<quote>"

If you were about to accept on his behalf: print that command for him instead,
with the incident id and a quote he actually said.`;

const BUDGET_REASON = `blocked: a gate-budget authorization is an owner action.

tools/reconcile.sh budget writes the record tools/merge-pr.sh reads to honour a
repo's declared gate-budget: in its repo file at main. Any session can run it —
the verb reads no actor, and the authorization mail is the only tell — so agents
never do: a budget an agent records is a bar an agent moved.

The owner runs, in his own terminal:
  cd ~/personal/github/pc-host && bash tools/reconcile.sh budget <owner>/<repo> <seconds> "<the owner's words, verbatim>"

If you were about to record one on his behalf: print that command for him
instead, with the number and the repo the gate refused.`;

const TRUST_STATE_REASON = `blocked: the merge helper's trust state is not an agent-writable file.

helper-trusted-sha and the incidents store under ~/.local/state/pc-merge/ decide
what code the gate runs and which incident stands. Accepting an incident and
editing that state are the same act; the owner does both from his own terminal.
Report what you would have written instead.`;

/**
 * The trust state: the trusted sha the gate executes, and the incident store
 * (`incidents.json` as the older layout, `incidents/<repo-key>.json` as
 * reconcile.sh writes it today).
 */
const TRUST_STATE_PATH =
	/(?:^|\/)pc-merge\/(?:helper-trusted-sha|incidents\.json|incidents\/[^/]+\.json)$/;

export const reconcileAcceptPlugin = {
	name: "reconcile-accept-guard",
	cliDescriptors: {
		// Our own basename only. bash / sh are declared by
		// agentConfigGuardPlugin in index.ts; declaring them again only earns
		// a "duplicate CLI descriptor" warning (same-table collision — see
		// ./dev-shm-guard.ts DECLARED_ELSEWHERE), and integration.test.ts's
		// zero-new-diagnostic gate fails on it.
		"reconcile.sh": {},
	},
	predicates: {
		reconcileAcceptsIncident,
		reconcileSetsBudget,
	},
} satisfies Plugin;

export const reconcileAcceptRules = [
	{
		name: "no-reconcile-accept",
		tool: "bash" as const,
		command: [SCRIPT, ...SHELL_BASENAMES] as const,
		when: { reconcileAcceptsIncident: true },
		reason: ACCEPT_REASON,
	},
	{
		name: "no-reconcile-budget",
		tool: "bash" as const,
		command: [SCRIPT, ...SHELL_BASENAMES] as const,
		when: { reconcileSetsBudget: true },
		reason: BUDGET_REASON,
	},
	{
		name: "no-pc-merge-trust-state-write",
		tool: "write" as const,
		field: "path" as const,
		pattern: TRUST_STATE_PATH,
		reason: TRUST_STATE_REASON,
	},
	{
		name: "no-pc-merge-trust-state-edit",
		tool: "edit" as const,
		field: "path" as const,
		pattern: TRUST_STATE_PATH,
		reason: TRUST_STATE_REASON,
	},
];
