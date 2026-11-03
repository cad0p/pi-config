// SPDX-License-Identifier: MIT
/**
 * Merge guard — agents do not merge directly.
 *
 * Design: Goldmine personal/github/pc-host/plans/2026-11-02-self-hosted-ci-replaces-s2-fallback.md
 * §3.6 and P1-W1 step 1. The merge helper `tools/merge-pr.sh` (pc-host) is the
 * sole agent merge path: it holds every piece of evidence logic (local gate,
 * merge record, `--admin --match-head-commit`, post-merge reads). This rule
 * holds none of it — it is one message over a handful of patterns, generic to
 * every repo (owner decision: option A). The helper runs `gh` as a subprocess,
 * so steering never sees its merge call and needs no exception.
 *
 * Refused (bash tool calls only; the owner's terminal is not bound):
 *   - `gh pr merge` in any form and with any flags (sole exception:
 *     `gh pr merge <n> --disable-auto`, which disarms auto-merge), wherever `-R/--repo`
 *     sits (the gh descriptor's consuming-flag table resolves positionals).
 *   - the REST merge: any `gh api` call naming `pulls/<n>/merge`.
 *   - the GraphQL merge mutations `mergePullRequest`,
 *     `enablePullRequestAutoMerge`, `mergeBranch` in any `gh api` call.
 *   - a `git push` that writes a `renovate/**` branch: an explicit
 *     destination refspec under `renovate/`, or — when no refspec is given —
 *     the current branch (`git checkout renovate/x && git push`,
 *     `gh pr checkout <n>` then a bare `git push`) or its upstream
 *     (`origin/renovate/x`).
 *   - `git/refs/heads/renovate/**` written through `gh api` (PATCH/DELETE).
 *
 * Allowed: `tools/merge-pr.sh …`, `bash tools/merge-pr.sh …`, gh reads
 * (view/checks/list/diff), `gh pr create`, `gh api` GETs of pulls/<n> and
 * rulesets, a push of a non-renovate branch, and text that merely contains the
 * words (grep/rg/cat, `git log --grep`) — rules route on the basename, never
 * on text.
 *
 * False-negative classes (stated as part of the claim, §3.6): a script written
 * to a file and then executed, and any other subprocess (the property that
 * lets the helper through); commands built by expansion, `eval`, aliases or
 * encoding; a commit to `renovate/**` through the contents API
 * (`branch=renovate/…`); the token read with `gh auth token` and used
 * elsewhere (curl, python3); a `gh pr checkout <n> && git push` in the SAME
 * bash chain (the checkout has not run when rules are evaluated — split the
 * calls, or the push is judged against the pre-checkout branch); and any
 * non-pi harness. The reconciler detects what this guard misses.
 */

import type { PredicateContext, PredicateShape } from "@cad0p/pi-steering";
import {
	getBranch,
	getUpstream,
	NO_CHECKOUT_IN_CHAIN,
	walkerString,
} from "@cad0p/pi-steering/plugins/git";

declare global {
	interface PiSteeringPredicates {
		attemptsDirectMerge: PredicateShape<boolean>;
		isAutoDisarm: PredicateShape<boolean>;
	}
}

/** REST merge endpoint: `…/pulls/<n>/merge` (optionally with a query). */
const REST_MERGE = /\/pulls\/\d+\/merge(?![\w-])/;

/** GraphQL merge mutations (field names, case-sensitive). */
const GRAPHQL_MERGE = /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/;

/** REST git-ref write to a renovate branch. */
const GIT_REF_RENOVATE = /git\/refs\/heads\/renovate\//;

/** A top-level `renovate/` branch (after refs/heads/ normalization). */
const RENOVATE_BRANCH = /^renovate\//;

/** An upstream tracking a remote's `renovate/` branch (`origin/renovate/x`). */
const RENOVATE_UPSTREAM = /^[^/\s]+\/renovate\//;

/** The ref's own text (basename + args), for the token patterns above. */
function refText(ctx: PredicateContext): string {
	if (typeof ctx.input.command === "string") return ctx.input.command;
	return (ctx.input.args ?? [])
		.map((w) => w?.value ?? w?.text ?? "")
		.join(" ");
}

/**
 * Destination branch of a push refspec, or null when it names no branch
 * (`refs/tags/…`, an empty destination, a deletion of nothing).
 * `src:dst` → dst; `refs/heads/dst` → dst; a bare `src` → src (git's
 * same-name form). `HEAD`/`@` are resolved by the caller.
 */
export function pushDestination(refspec: string): string | null {
	const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec;
	const colon = spec.indexOf(":");
	const dst = colon >= 0 ? spec.slice(colon + 1) : spec;
	if (dst === "") return null;
	if (dst.startsWith("refs/heads/")) return dst.slice("refs/heads/".length);
	if (dst.startsWith("refs/")) return null;
	return dst;
}

type BranchState = string | "unknown";

/**
 * Current branch: the walker's branch tracker first (in-chain
 * `git checkout renovate/x` resolves statically), then a shell-out. An
 * unresolvable branch is `"unknown"` and the guard fails closed, mirroring
 * the shipped `branch:` predicate's default `onUnknown: "block"`.
 */
async function currentBranch(ctx: PredicateContext): Promise<BranchState> {
	const fromWalker = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
	if (fromWalker.kind === "value") return fromWalker.value;
	if (fromWalker.kind === "unknown") return "unknown";
	if (ctx.walkerState?.cwd === "unknown") return "unknown";
	const branch = await getBranch(ctx);
	return branch === null ? "unknown" : branch;
}

/**
 * Does this `git push` write a `renovate/**` branch? With explicit
 * refspecs the destinations decide; without one the implied destination is
 * the current branch (push.default) or, failing that, its upstream.
 */
async function pushesRenovate(ctx: PredicateContext): Promise<boolean> {
	const positionals = ctx.command.positionals();
	if (positionals[0] !== "push") return false;

	const operands = positionals
		.slice(1)
		.filter((t) => t !== "--" && !t.startsWith("-"));
	// git reads the first non-option argument as <repository> unless it
	// carries a colon (then it is a refspec and the remote defaults).
	const refspecs =
		operands.length === 0
			? []
			: (operands[0] ?? "").includes(":")
				? operands
				: operands.slice(1);

	if (refspecs.length === 0) {
		const branch = await currentBranch(ctx);
		if (branch === "unknown") return true;
		if (RENOVATE_BRANCH.test(branch)) return true;
		const upstream = await getUpstream(ctx);
		return upstream !== null && RENOVATE_UPSTREAM.test(upstream);
	}

	for (const spec of refspecs) {
		const dst = pushDestination(spec);
		if (dst === null) continue;
		if (dst === "HEAD" || dst === "@") {
			const branch = await currentBranch(ctx);
			if (branch === "unknown") return true;
			if (RENOVATE_BRANCH.test(branch)) return true;
			continue;
		}
		if (RENOVATE_BRANCH.test(dst)) return true;
	}
	return false;
}

/**
 * Is this "gh pr merge" exactly the disarm form "gh pr merge <n> --disable-auto"
 * (owner ruling 2026-11-03)? -R/--repo (separate, "=", or glued) may sit
 * anywhere. Any other flag, a non-numeric selector, or an extra positional
 * keeps it refused (fail closed).
 */
function isDisableAutoOnly(ctx: PredicateContext): boolean {
	const words = (ctx.input.args ?? []).map((w) => w?.value ?? w?.text ?? "");
	const rest: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i] ?? "";
		if (w === "-R" || w === "--repo") {
			if (i + 1 >= words.length) return false;
			i++;
		} else if (w.startsWith("--repo=") || /^-R./.test(w)) {
			// repo selector; consumed
		} else rest.push(w);
	}
	if (rest.length !== 4) return false;
	if (rest.filter((w) => w === "--disable-auto").length !== 1) return false;
	const pos = rest.filter((w) => w !== "--disable-auto");
	return pos[0] === "pr" && pos[1] === "merge" && /^\d+$/.test(pos[2] ?? "");
}

/** Does this gh call merge, or write a renovate ref, by any route? */
function ghAttemptsDirectMerge(ctx: PredicateContext): boolean {
	const positionals = ctx.command.positionals();
	if (positionals[0] === "pr" && positionals[1] === "merge") {
		return !isDisableAutoOnly(ctx);
	}
	if (positionals[0] !== "api") return false;
	const text = refText(ctx);
	return (
		REST_MERGE.test(text) ||
		GRAPHQL_MERGE.test(text) ||
		GIT_REF_RENOVATE.test(text)
	);
}

export const mergeGuardPlugin = {
	name: "merge-guard",
	// No cliDescriptors: `gh` and `git` are declared by the github and git
	// plugins (re-declaring them only produces descriptor-collision warnings).
	predicates: {
		attemptsDirectMerge: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			if (ctx.input.basename === "gh") return ghAttemptsDirectMerge(ctx);
			if (ctx.input.basename === "git") return pushesRenovate(ctx);
			return false;
		},
		// True for exactly gh pr merge <n> --disable-auto (+ -R/--repo).
		isAutoDisarm: (args: unknown, ctx: PredicateContext) => {
			if (args !== true) return false;
			if (ctx.input.basename !== "gh") return false;
			const p = ctx.command.positionals();
			return p[0] === "pr" && p[1] === "merge" && isDisableAutoOnly(ctx);
		},
	},
	// The github plugin merge-time rules (closing keyword, -R placement)
	// police merges carrying a squash subject; a disarm merges nothing.
	exemptions: [
		{ rule: "pr-merge-needs-closing-keywords", when: { isAutoDisarm: true } },
		{ rule: "gh-repo-flag-before-subcommand", when: { isAutoDisarm: true } },
	],
};

const REASON =
	"Agents do not merge directly — merge through tools/merge-pr.sh (the sole merge path: it runs the local gate on the head, binds the merge record and performs the merge). This guard refuses gh pr merge in any form except the bare disarm gh pr merge <n> --disable-auto (alone, optionally with -R/--repo), the REST pulls/<n>/merge endpoint, the GraphQL mergePullRequest / enablePullRequestAutoMerge / mergeBranch mutations, a push to a renovate/** branch (explicit refspec, current branch or upstream), and writes to git/refs/heads/renovate/**. The owner merges from their own terminal.";

export const mergeGuardRules = [
	{
		name: "agents-do-not-merge-directly",
		tool: "bash" as const,
		command: ["gh", "git"] as const,
		when: {
			attemptsDirectMerge: true,
			// `--help` / `--version` are introspection, not a merge.
			not: { infoOnly: { extraFlags: ["-h"] } },
		},
		reason: REASON,
	},
];
