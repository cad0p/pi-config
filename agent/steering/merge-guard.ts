// SPDX-License-Identifier: MIT
/**
 * Merge guard — agents do not merge directly, in private repos.
 *
 * Design: Goldmine personal/github/pc-host/plans/2026-11-02-self-hosted-ci-replaces-s2-fallback.md
 * §3.6 and P1-W1 step 1. The merge helper `tools/merge-pr.sh` (pc-host) is the
 * sole agent merge path: it holds every piece of evidence logic (local gate,
 * merge record, `--admin --match-head-commit`, post-merge reads). This rule
 * holds none of it — it is one message over a handful of patterns.
 *
 * SCOPE (owner ruling 2026-11-03, verbatim: "just gate it to private repos
 * instead, simpler"; reasoning, verbatim: "the reasoning is that public repos
 * have free CI, so no machinery involved"): generic within PRIVATE repos.
 * Public repos run hosted GitHub Actions for free, so their normal required
 * checks ARE the gate and none of the local-gate / `merge-pr.sh` machinery
 * applies — a direct agent merge there is ordinary work. Private repos are the
 * ones on the minutes quota, with local container CI as the gate of record.
 * Every governed repo — the ones whose merges go through
 * `tools/merge-pr.sh` — is private, and every direct merge route there stays
 * refused. (The old every-repo scope refused a direct merge in the public
 * cad0p/pi-usage.) The helper runs `gh` as a subprocess, so steering never
 * sees its merge call and needs no exception.
 *
 * VISIBILITY GATE — how the TARGET repo is resolved, per route:
 *   - `gh pr merge`: `-R/--repo` (separate, `=`, glued; last wins, like gh),
 *     else `GH_REPO` from the COMMAND's own env (a prefix assignment
 *     `GH_REPO=x gh …` or an in-chain `export GH_REPO=x`), else the repo of
 *     the command's effective cwd. A `GH_REPO` set only in the pi PROCESS env
 *     is not visible to this file — but that path is still faithful, because
 *     the cwd probe below is `gh repo view` itself and the child inherits the
 *     process env, so gh applies its own GH_REPO precedence there.
 *   - cwd probe: `gh repo view --json nameWithOwner,isPrivate` in the
 *     command's effective cwd — deliberately NOT an origin-remote URL parse:
 *     it inherits gh's own resolution (process GH_REPO, its remote preference,
 *     insteadOf rewrites), i.e. the exact choice `gh pr merge` without `-R`
 *     would make, and it returns the name and the visibility in one round
 *     trip. Re-implementing that resolution would let the guard and the merge
 *     it guards disagree about the target repo.
 *   - explicitly named repos (`-R`, `GH_REPO`, a `repos/<o>/<r>/…` endpoint):
 *     `gh api repos/<o>/<r> --jq .private` (one round trip, nothing resolved
 *     from cwd).
 *   - `gh api`: the `repos/<owner>/<repo>` path of the endpoint; gh's own
 *     `{owner}` / `{repo}` placeholders resolve the way gh resolves them —
 *     `GH_REPO` from the command's env, else the cwd probe.
 *   - `git push` to `renovate/**`: the push remote's URL — a URL given on the
 *     command line, else `remote.<name>.url`; with no remote operand the
 *     branch's `branch.<name>.remote`, else `origin` — parsed as a GitHub
 *     URL (`https://`, `ssh://`, `git@host:owner/repo`), then the same
 *     `gh api … .private` lookup.
 * Lookups are async `ctx.exec` calls (the same mechanism `currentBranch`
 * already uses), bounded to 5 s, and cached in-process per `owner/repo` for
 * 3 minutes — successful answers ONLY, so a transient failure is retried on
 * the next call. Tests drive them through the stubbed host `exec`; nothing in
 * this file can reach the network on its own.
 *
 * FAIL CLOSED — "unknown" is treated as PRIVATE, so the rule still fires when:
 *   - the effective cwd is walker-unknown (`cd "$X" && gh pr merge`), or the
 *     cwd probe fails;
 *   - the visibility lookup exits non-zero / times out / is not logged in /
 *     prints anything but `true`|`false`, or the repo name is unparsable;
 *   - a `gh api` call carries no resolvable `repos/<o>/<r>` segment;
 *   - the call is a GraphQL merge mutation: the repo appears nowhere in it
 *     (node ids only), so it is refused regardless of visibility;
 *   - a `git push` remote is a non-GitHub host / unparsable path / a named
 *     remote with no `remote.<name>.url`, or the default remote is
 *     unresolvable;
 *   - the current branch is unresolvable, so neither the pushed
 *     `renovate/**` ref nor the default remote can be named.
 *
 * Refused in a private repo (bash tool calls only; the owner's terminal is not
 * bound):
 *   - `gh pr merge` in any form and with any flags (sole exception:
 *     `gh pr merge <n> --disable-auto`, which disarms auto-merge), wherever
 *     `-R/--repo` sits (the gh descriptor's consuming-flag table resolves
 *     positionals).
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
 * Allowed: everything above when the target repo is PUBLIC; `tools/merge-pr.sh …`,
 * `bash tools/merge-pr.sh …`, gh reads (view/checks/list/diff), `gh pr create`,
 * `gh api` GETs of pulls/<n> and rulesets, a push of a non-renovate branch,
 * and text that merely contains the words (grep/rg/cat, `git log --grep`) —
 * rules route on the basename, never on text.
 *
 * False-negative classes (stated as part of the claim, §3.6): a script written
 * to a file and then executed, and any other subprocess (the property that
 * lets the helper through); commands built by expansion, `eval`, aliases or
 * encoding; a commit to `renovate/**` through the contents API
 * (`branch=renovate/…`); the token read with `gh auth token` and used
 * elsewhere (curl, python3); a `gh pr checkout <n> && git push` in the SAME
 * bash chain (the checkout has not run when rules are evaluated — split the
 * calls, or the push is judged against the pre-checkout branch); a public repo
 * turned private *after* a successful lookup was cached (≤3 min window); and
 * any non-pi harness. The reconciler detects what this guard misses.
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

/** The `repos/<owner>/<repo>` route of a `gh api` endpoint. */
const API_REPO_PATH = /(?:^|[\s/])repos\/([^/\s"'`?#]+)\/([^/\s"'`?#]+)/;

/** gh api's placeholders for the repo it resolves (see its --help). */
const API_REPO_PLACEHOLDER = /^\{(?:owner|repo)\}$/;

/** A GitHub owner/repo pair (the shape gh itself accepts). */
const NAMESPACE = /^[^/\s]+\/[^/\s]+$/;

/** A command-line push operand that IS a URL (scp-like or scheme://). */
const REMOTE_URL_OPERAND =
	/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[A-Za-z0-9._-]+@[^:/\s]+:)/;

/** Bound on a visibility lookup: a hung `gh` must not stall the tool call. */
const LOOKUP_TIMEOUT_MS = 5_000;

/** Successful visibility answers are reused for a few minutes. */
const VISIBILITY_TTL_MS = 3 * 60_000;

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

// ---------------------------------------------------------------------------
// Target-repo visibility (the private-repo gate)
// ---------------------------------------------------------------------------

/** Verdict of a visibility probe. Only "public" releases the rule. */
type Visibility = "private" | "public" | "unknown";

/** Successful lookups only: a failure must be retried, never remembered. */
const visibilityCache = new Map<string, { isPrivate: boolean; at: number }>();

/**
 * Trimmed stdout of a bounded `ctx.exec`, or null on ANY failure (non-zero
 * exit, spawn error, timeout, thrown exception, empty output). Mirrors the git
 * plugin's `tryGit` failure collapse so every probe has one failure mode.
 * `cwd` omitted → the session cwd (for lookups that name their repo).
 */
async function tryExec(
	ctx: PredicateContext,
	cmd: string,
	args: string[],
	cwd?: string,
): Promise<string | null> {
	try {
		const res = await ctx.exec(
			cmd,
			args,
			cwd === undefined
				? { timeoutMs: LOOKUP_TIMEOUT_MS }
				: { cwd, timeoutMs: LOOKUP_TIMEOUT_MS },
		);
		if (res.exitCode !== 0) return null;
		const out = res.stdout.trim();
		return out === "" ? null : out;
	} catch {
		return null;
	}
}

/** A cached answer, when one is still fresh. */
function cachedVisibility(fullName: string): Visibility | null {
	const key = fullName.toLowerCase();
	const hit = visibilityCache.get(key);
	if (hit === undefined) return null;
	if (Date.now() - hit.at > VISIBILITY_TTL_MS) {
		visibilityCache.delete(key);
		return null;
	}
	return hit.isPrivate ? "private" : "public";
}

/**
 * Visibility of an explicitly NAMED repo, via
 * `gh api repos/<owner>/<repo> --jq .private`. Cwd-free on purpose: the path
 * names everything, so the probe still works when the command's cwd is a plain
 * directory (or belongs to someone else's repo) — the guard can't be misled
 * into auditing a different repo than the command targets.
 */
async function repoVisibilityByName(
	ctx: PredicateContext,
	fullName: string,
): Promise<Visibility> {
	const cached = cachedVisibility(fullName);
	if (cached !== null) return cached;
	const out = await tryExec(ctx, "gh", [
		"api",
		`repos/${fullName}`,
		"--jq",
		".private",
	]);
	if (out === null) return "unknown";
	if (out !== "true" && out !== "false") return "unknown";
	const isPrivate = out === "true";
	visibilityCache.set(fullName.toLowerCase(), { isPrivate, at: Date.now() });
	return isPrivate ? "private" : "public";
}

/**
 * Visibility of the repo `gh` resolves at the command's effective cwd, via
 * `gh repo view --json nameWithOwner,isPrivate` (see the header: it inherits
 * gh's own resolution, so the guard cannot disagree with the merge it gates).
 * A walker-unknown cwd is unverifiable → "unknown" (fail closed).
 */
async function cwdRepoVisibility(ctx: PredicateContext): Promise<Visibility> {
	if (ctx.cwd === "unknown") return "unknown";
	const cwd = ctx.walkerState?.cwd;
	if (typeof cwd !== "string" || cwd === "unknown") return "unknown";
	const out = await tryExec(
		ctx,
		"gh",
		["repo", "view", "--json", "nameWithOwner,isPrivate"],
		cwd,
	);
	if (out === null) return "unknown";
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch {
		return "unknown";
	}
	if (typeof parsed !== "object" || parsed === null) return "unknown";
	const name = (parsed as { nameWithOwner?: unknown }).nameWithOwner;
	const isPrivate = (parsed as { isPrivate?: unknown }).isPrivate;
	if (typeof name !== "string" || !NAMESPACE.test(name)) return "unknown";
	if (typeof isPrivate !== "boolean") return "unknown";
	visibilityCache.set(name.toLowerCase(), { isPrivate, at: Date.now() });
	return isPrivate ? "private" : "public";
}

/**
 * `[HOST/]OWNER/REPO` (gh's -R/GH_REPO shape) → `OWNER/REPO`; null when it
 * names no namespace. A host prefix and a trailing `.git` are dropped;
 * anything else unparsable stays null so the caller fails closed.
 */
export function repoNamespace(spec: string): string | null {
	const parts = spec
		.trim()
		.replace(/\/+$/, "")
		.split("/")
		.filter((p) => p !== "");
	if (parts.length < 2) return null;
	const repo = (parts[parts.length - 1] ?? "").replace(/\.git$/i, "");
	const owner = parts[parts.length - 2] ?? "";
	if (owner === "" || repo === "") return null;
	return `${owner}/${repo}`;
}

/**
 * `owner/repo` named by a git remote URL, or null for anything that is not a
 * GitHub repo (non-GitHub host, local path, unparsable). Accepts
 * `https://[user[:token]@]github.com/owner/repo[.git]`,
 * `ssh://git@github.com[:port]/owner/repo.git`, `git://…` and the scp-like
 * `git@github.com:owner/repo.git`.
 */
export function githubRepoFromUrl(raw: string): string | null {
	let rest = raw.trim();
	if (rest === "") return null;
	// scp-like `user@host:owner/repo` (no scheme) — normalize to ssh:// first.
	const scp = /^[A-Za-z0-9._-]+@([^:/\s]+):(.+)$/.exec(rest);
	if (scp !== null) rest = `ssh://${scp[1] ?? ""}/${scp[2] ?? ""}`;
	let url: URL;
	try {
		url = new URL(rest);
	} catch {
		return null;
	}
	if (url.hostname.toLowerCase() !== "github.com") return null;
	const parts = decodeURIComponent(url.pathname)
		.split("/")
		.filter((p) => p !== "");
	if (parts.length < 2) return null;
	return repoNamespace(`${parts[0] ?? ""}/${parts[1] ?? ""}`);
}

/**
 * Visibility of the repo the COMMAND itself would resolve: `GH_REPO` from its
 * own env when set, else the cwd probe — gh's precedence, so the guard and the
 * command agree on the target.
 */
async function commandRepoVisibility(
	ctx: PredicateContext,
): Promise<Visibility> {
	const envRepo = ghRepoEnv(ctx);
	if (envRepo === null) return cwdRepoVisibility(ctx);
	const fullName = repoNamespace(envRepo);
	return fullName === null
		? "unknown"
		: repoVisibilityByName(ctx, fullName);
}

/**
 * `gh pr merge` target visibility: `-R/--repo` (last wins, as in gh), else
 * `GH_REPO` from the COMMAND's env, else the cwd repo. `-R` beats GH_REPO —
 * gh's own precedence.
 */
async function prMergeTargetVisibility(
	ctx: PredicateContext,
): Promise<Visibility> {
	const selected = repoFlagValues(ctx).at(-1);
	if (selected !== undefined) {
		const fullName = repoNamespace(selected);
		return fullName === null
			? "unknown"
			: repoVisibilityByName(ctx, fullName);
	}
	return commandRepoVisibility(ctx);
}

/** Visibility of the repo a `gh api` endpoint targets. */
async function apiTargetVisibility(
	ctx: PredicateContext,
	text: string,
): Promise<Visibility> {
	const match = API_REPO_PATH.exec(text);
	if (match === null) return "unknown";
	const owner = match[1] ?? "";
	const repo = match[2] ?? "";
	if (owner === "" || repo === "") return "unknown";
	if (API_REPO_PLACEHOLDER.test(owner) || API_REPO_PLACEHOLDER.test(repo)) {
		return commandRepoVisibility(ctx);
	}
	const fullName = repoNamespace(`${owner}/${repo}`);
	return fullName === null
		? "unknown"
		: repoVisibilityByName(ctx, fullName);
}

/** Values of every `-R` / `--repo` spelling, in argv order. */
function repoFlagValues(ctx: PredicateContext): string[] {
	const words = (ctx.input.args ?? []).map((w) => w?.value ?? w?.text ?? "");
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i] ?? "";
		if (w === "-R" || w === "--repo") {
			const next = words[i + 1];
			if (next !== undefined) {
				out.push(next);
				i++;
			}
		} else if (w.startsWith("--repo=")) {
			out.push(w.slice("--repo=".length));
		} else if (/^-R./.test(w)) {
			const glued = w.slice(2);
			out.push(glued.startsWith("=") ? glued.slice(1) : glued);
		}
	}
	return out;
}

/**
 * `GH_REPO` as the command's own child env sees it: a prefix assignment
 * (`GH_REPO=x gh …`) or an in-chain write the walker tracked
 * (`export GH_REPO=x`, `GH_REPO=x; gh …`). Empty → null (gh treats an empty
 * GH_REPO as unset and falls back to the remotes).
 */
function ghRepoEnv(ctx: PredicateContext): string | null {
	for (const w of ctx.input.envAssignments ?? []) {
		const token = w?.text ?? w?.value ?? "";
		const eq = token.indexOf("=");
		if (eq <= 0) continue;
		if (token.slice(0, eq) !== "GH_REPO") continue;
		const value = unquote(token.slice(eq + 1));
		if (value !== "") return value;
	}
	const scoped = ctx.walkerState?.env.get("GH_REPO");
	return typeof scoped === "string" && scoped !== "" ? scoped : null;
}

/** Strip one layer of matching shell quotes. */
function unquote(raw: string): string {
	const q = raw[0];
	if (raw.length >= 2 && (q === '"' || q === "'") && raw.endsWith(q)) {
		return raw.slice(1, -1);
	}
	return raw;
}

// ---------------------------------------------------------------------------
// Branch / push state
// ---------------------------------------------------------------------------

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

/** `git config --get <key>` at the command's cwd, or null. */
async function gitConfig(
	ctx: PredicateContext,
	key: string,
): Promise<string | null> {
	const cwd = ctx.walkerState?.cwd;
	if (typeof cwd !== "string" || cwd === "unknown") return null;
	return tryExec(ctx, "git", ["config", "--get", key], cwd);
}

/** `git push` operands: the explicit remote (if any) and the refspecs. */
function pushOperands(ctx: PredicateContext): {
	repository: string | null;
	refspecs: string[];
} {
	const positionals = ctx.command.positionals();
	const operands = positionals
		.slice(1)
		.filter((t) => t !== "--" && !t.startsWith("-"));
	// git reads the first non-option argument as <repository> unless it
	// carries a colon (then it is a refspec and the remote defaults) — but a
	// URL operand carries a colon too (`git@github.com:o/r.git`), so it stays
	// a repository.
	const first = operands[0];
	if (first === undefined) return { repository: null, refspecs: [] };
	if (first.includes(":") && !REMOTE_URL_OPERAND.test(first)) {
		return { repository: null, refspecs: operands };
	}
	return { repository: first, refspecs: operands.slice(1) };
}

/**
 * Does this `git push` write a `renovate/**` branch? With explicit
 * refspecs the destinations decide; without one the implied destination is
 * the current branch (push.default) or, failing that, its upstream.
 * `"unknown"` = the destination cannot be named at all (unresolvable
 * branch) — the caller fails closed.
 */
async function renovateDestination(
	ctx: PredicateContext,
): Promise<"yes" | "no" | "unknown"> {
	const { refspecs } = pushOperands(ctx);
	if (refspecs.length === 0) {
		const branch = await currentBranch(ctx);
		if (branch === "unknown") return "unknown";
		if (RENOVATE_BRANCH.test(branch)) return "yes";
		const upstream = await getUpstream(ctx);
		return upstream !== null && RENOVATE_UPSTREAM.test(upstream)
			? "yes"
			: "no";
	}
	for (const spec of refspecs) {
		const dst = pushDestination(spec);
		if (dst === null) continue;
		if (dst === "HEAD" || dst === "@") {
			const branch = await currentBranch(ctx);
			if (branch === "unknown") return "unknown";
			if (RENOVATE_BRANCH.test(branch)) return "yes";
			continue;
		}
		if (RENOVATE_BRANCH.test(dst)) return "yes";
	}
	return "no";
}

/**
 * URL of the remote a `git push` would write: the explicit operand when it
 * looks like a URL, else `remote.<operand>.url`; with no operand the
 * branch's `branch.<name>.remote`, else `origin`. Null when unresolvable.
 */
async function pushRemoteUrl(ctx: PredicateContext): Promise<string | null> {
	const { repository } = pushOperands(ctx);
	const resolve = async (remoteOrUrl: string): Promise<string | null> => {
		const configured = await gitConfig(ctx, `remote.${remoteOrUrl}.url`);
		if (configured !== null) return configured;
		return REMOTE_URL_OPERAND.test(remoteOrUrl) ? remoteOrUrl : null;
	};
	if (repository !== null) return resolve(repository);
	const branch = await currentBranch(ctx);
	if (branch === "unknown") return null;
	const configuredRemote = await gitConfig(ctx, `branch.${branch}.remote`);
	return resolve(
		configuredRemote !== null && configuredRemote !== ""
			? configuredRemote
			: "origin",
	);
}

// ---------------------------------------------------------------------------
// gh routes
// ---------------------------------------------------------------------------

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

/**
 * Does this gh call merge, or write a renovate ref, in a PRIVATE repo? The
 * repo is resolved per route (see the header) and every unresolvable answer
 * is "private" — fail closed. The disarm never looks anything up.
 */
async function ghAttemptsDirectMerge(ctx: PredicateContext): Promise<boolean> {
	const positionals = ctx.command.positionals();
	if (positionals[0] === "pr" && positionals[1] === "merge") {
		if (isDisableAutoOnly(ctx)) return false;
		return (await prMergeTargetVisibility(ctx)) !== "public";
	}
	if (positionals[0] !== "api") return false;
	const text = refText(ctx);
	// GraphQL merge mutations carry only node ids — there is no repo in the
	// call to probe, so they are refused whatever the visibility would be.
	if (GRAPHQL_MERGE.test(text)) return true;
	if (!REST_MERGE.test(text) && !GIT_REF_RENOVATE.test(text)) return false;
	return (await apiTargetVisibility(ctx, text)) !== "public";
}

/**
 * Does this `git push` write a `renovate/**` branch on a private repo? The
 * destination is decided first (local, cheap); only a real renovate write
 * pays for the remote-URL and visibility probes.
 */
async function pushesRenovate(ctx: PredicateContext): Promise<boolean> {
	if (ctx.command.positionals()[0] !== "push") return false;
	const destination = await renovateDestination(ctx);
	if (destination === "no") return false;
	if (destination === "unknown") return true;
	const url = await pushRemoteUrl(ctx);
	if (url === null) return true;
	const fullName = githubRepoFromUrl(url);
	if (fullName === null) return true;
	return (await repoVisibilityByName(ctx, fullName)) !== "public";
}

export const mergeGuardPlugin = {
	name: "merge-guard",
	// No cliDescriptors: `gh` and `git` are declared by the github and git
	// plugins (re-declaring them only produces descriptor-collision warnings).
	predicates: {
		attemptsDirectMerge: async (args: unknown, ctx: PredicateContext) => {
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
	"Agents do not merge directly in PRIVATE repos — merge through tools/merge-pr.sh (the sole merge path: it runs the local gate on the head, binds the merge record and performs the merge). This guard refuses gh pr merge in any form except the bare disarm gh pr merge <n> --disable-auto (alone, optionally with -R/--repo), the REST pulls/<n>/merge endpoint, the GraphQL mergePullRequest / enablePullRequestAutoMerge / mergeBranch mutations, a push to a renovate/** branch (explicit refspec, current branch or upstream), and writes to git/refs/heads/renovate/**. Public repos are not gated — merge them normally. When the target repo's visibility cannot be resolved the guard fails closed (the repo is treated as private). The owner merges from their own terminal.";

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
