// SPDX-License-Identifier: MIT
/**
 * critical-path label guard — agents never apply or remove the owner's
 * `critical-path` label on a pc repo.
 *
 * Why (pc-host #714 r1, red-team F2 = trust-model F2): the merge queue
 * (`tools/merge-pr.sh queue add`) counts the `critical-path` label only when
 * the PR's last label event is a `labeled` by account id 14107574. Agent
 * sessions run `gh` on that same account, so the actor check binds the flag
 * to the ACCOUNT, not to the human: it cannot tell the owner from a session
 * on the owner's token. This rule closes that gap for pi sessions: the label
 * is the owner's, and agents never touch it. Doc: pc-host
 * docs/verification-repo.md, "Merge queue Q1".
 *
 * Refused (bash tool calls whose basename is `gh`; codemode's
 * `tools.bash({ command })` reaches steering as a plain bash call, and the
 * walker expands `bash -c` / `sh -c` / `env` wrappers into the inner ref):
 *   - `gh pr edit` / `gh issue edit` with `--add-label` or `--remove-label`
 *     naming `critical-path` (separate or `=` value, alone or in a comma
 *     list, any case: GitHub label names are case-insensitive);
 *   - `gh pr create` / `gh issue create` with `-l` / `--label critical-path`
 *     (creating with the label applies it);
 *   - `gh label delete critical-path` and `gh label edit critical-path`
 *     (deleting or renaming the label removes it from every PR);
 *   - `gh api` writes to a labels endpoint that name `critical-path`
 *     (`-X DELETE …/issues/<n>/labels/critical-path`, a POST of
 *     `labels[]=critical-path`), and the whole-set writes that can drop it
 *     unseen: `-X PUT` / `-X DELETE` on `…/issues/<n>/labels`, and a PATCH of
 *     `…/issues/<n>` carrying a `labels` field. A `gh api` call is a write
 *     when it has `-X/--method` other than GET/HEAD, or (gh's own default)
 *     fields or `--input` and no method.
 *
 * Scope: a pc repo, `cad0p/pc-*`. The repo is read from `-R/--repo` (last
 * wins), else `GH_REPO` (a same-command prefix, then an in-chain export),
 * else, for `gh api`, the endpoint's `repos/<owner>/<repo>`. An UNNAMED repo
 * (no flag, no GH_REPO, a cwd-resolved `gh pr edit`, gh's `{owner}/{repo}`
 * placeholders) counts as a pc repo: fail closed, no network lookup.
 *
 * Allowed: other labels, reading labels (`gh pr view --json labels`,
 * `gh api …/labels` GETs, `gh api …/events`), `gh label list`,
 * `gh label create critical-path` (defines the label, applies it nowhere),
 * the same writes on a named non-pc repo, and text that merely mentions the
 * label (grep, jq filters on event reads).
 *
 * Known gaps (pinned in the test file): the GraphQL mutations
 * `addLabelsToLabelable` / `removeLabelsFromLabelable` (they carry label node
 * ids, never the name); a label written through curl or python with the token
 * from `gh auth token`; a script written to a file and then run; commands
 * built by expansion, `eval` or aliases; and the owner's own terminal (not
 * bound, by design). The queue's `flag-ignored` / `added` events record what
 * the flag was at each add, so a mislabel stays visible after the fact.
 */

import type { PredicateContext, PredicateShape } from "@cad0p/pi-steering";

declare global {
	interface PiSteeringPredicates {
		touchesCriticalPathLabel: PredicateShape<boolean>;
	}
}

const LABEL = "critical-path";

/** The pc repos (`cad0p/pc-*`), case-insensitive like GitHub names. */
const PC_REPO = /^cad0p\/pc-[^/\s]+$/i;

/** The `repos/<owner>/<repo>` route of a `gh api` endpoint. */
const API_REPO_PATH = /(?:^|\/)repos\/([^/\s"'`?#]+)\/([^/\s"'`?#]+)/;

/** gh api fields that make an unmethoded call a POST. */
const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** `issues/<n>/labels` (the whole set) and `issues/<n>/labels/<name>`. */
const ISSUE_LABELS_SET = /(?:^|\/)issues\/\d+\/labels\/?(?:[?#].*)?$/;
const LABELS_ENDPOINT = /(?:^|\/)labels(?:\/|$|[?#])/;
/** `issues/<n>` or `pulls/<n>` itself (a PATCH there may carry `labels`). */
const ISSUE_ITSELF = /(?:^|\/)(?:issues|pulls)\/\d+\/?(?:[?#].*)?$/;

type Ctx = PredicateContext;

function unquote(s: string): string {
	return s.replace(/^(["'])(.*)\1$/, "$2");
}

/** The ref's argv after the basename, unquoted. */
function argv(ctx: Ctx): string[] {
	return (ctx.input.args ?? []).map((w) => unquote(w?.value ?? w?.text ?? ""));
}

/** Does a label-list value (comma-separated) name the critical-path label? */
function namesLabel(value: string): boolean {
	return value
		.split(",")
		.some((v) => unquote(v.trim()).toLowerCase() === LABEL);
}

/** Every value given to one of `flags` (separate, `=`, or glued short). */
function flagValues(words: string[], flags: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i] ?? "";
		for (const f of flags) {
			if (w === f) {
				if (i + 1 < words.length) out.push(words[i + 1] ?? "");
			} else if (f.startsWith("--") && w.startsWith(`${f}=`)) {
				out.push(w.slice(f.length + 1));
			} else if (!f.startsWith("--") && w.startsWith(f) && w.length > f.length) {
				out.push(w.slice(f.length));
			}
		}
	}
	return out;
}

/** The repo named by -R/--repo (last wins), else GH_REPO, else null. */
function namedRepo(ctx: Ctx, words: string[]): string | null {
	const flagged = flagValues(words, ["-R", "--repo"]);
	if (flagged.length > 0) return flagged[flagged.length - 1] ?? null;
	for (const w of ctx.input.envAssignments ?? []) {
		const tok = unquote(w?.value ?? w?.text ?? "");
		const m = /^GH_REPO=["']?(.*?)["']?$/.exec(tok);
		if (m && m[1]) return m[1];
	}
	const env = (ctx.walkerState as { env?: ReadonlyMap<string, string> } | undefined)?.env;
	const fromEnv = env?.get?.("GH_REPO");
	return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null;
}

/** A named repo outside cad0p/pc-* releases the rule; unnamed fails closed. */
function inPcScope(repo: string | null): boolean {
	if (repo === null) return true;
	const name = repo.replace(/^(?:https?:\/\/)?github\.com\//i, "").replace(/\.git$/, "");
	if (/[{}]/.test(name)) return true;
	return PC_REPO.test(name);
}

/** gh api: the endpoint operand (first non-flag after `api`, skipping flag values). */
function apiEndpoint(words: string[]): string | null {
	const takesValue = new Set([
		"-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header",
		"--input", "-q", "--jq", "-t", "--template", "-R", "--repo", "--hostname",
		"--cache", "-p", "--preview",
	]);
	let seenApi = false;
	for (let i = 0; i < words.length; i++) {
		const w = words[i] ?? "";
		if (!seenApi) {
			if (w === "api") seenApi = true;
			else if (w === "-R" || w === "--repo") i++;
			continue;
		}
		if (takesValue.has(w)) {
			i++;
			continue;
		}
		if (w.startsWith("-")) continue;
		return w;
	}
	return null;
}

/** gh api's effective method: -X/--method, else POST with fields, else GET. */
function apiMethod(words: string[]): string {
	const m = flagValues(words, ["-X", "--method"]);
	if (m.length > 0) return (m[m.length - 1] ?? "").toUpperCase();
	const hasField = words.some(
		(w) => FIELD_FLAGS.has(w) || /^--(?:field|raw-field|input)=/.test(w) || /^-[fF]./.test(w),
	);
	return hasField ? "POST" : "GET";
}

function apiTouchesLabel(ctx: Ctx, words: string[]): boolean {
	const endpoint = apiEndpoint(words);
	if (endpoint === null) return false;
	const method = apiMethod(words);
	if (method === "GET" || method === "HEAD") return false;
	const text = words.join(" ");
	const fields = flagValues(words, ["-f", "-F", "--field", "--raw-field"]);
	let hit = false;
	if (LABELS_ENDPOINT.test(endpoint) && text.toLowerCase().includes(LABEL)) hit = true;
	else if (ISSUE_LABELS_SET.test(endpoint) && (method === "PUT" || method === "DELETE")) hit = true;
	else if (ISSUE_ITSELF.test(endpoint) && fields.some((f) => /^labels(?:\[\])?=/.test(f))) hit = true;
	if (!hit) return false;
	const m = API_REPO_PATH.exec(endpoint);
	const repo = namedRepo(ctx, words) ?? (m ? `${m[1]}/${m[2]}` : null);
	return inPcScope(repo);
}

function ghTouchesLabel(ctx: Ctx): boolean {
	const words = argv(ctx);
	const p = ctx.command.positionals();
	const [noun, verb] = [p[0], p[1]];
	if (noun === "api") return apiTouchesLabel(ctx, words);
	let hit = false;
	if ((noun === "pr" || noun === "issue") && verb === "edit") {
		hit = flagValues(words, ["--add-label", "--remove-label"]).some(namesLabel);
	} else if ((noun === "pr" || noun === "issue") && (verb === "create" || verb === "new")) {
		hit = flagValues(words, ["-l", "--label"]).some(namesLabel);
	} else if (noun === "label" && (verb === "delete" || verb === "edit")) {
		hit = typeof p[2] === "string" && unquote(p[2]).toLowerCase() === LABEL;
	}
	return hit && inPcScope(namedRepo(ctx, words));
}

export const criticalPathLabelGuardPlugin = {
	name: "critical-path-label-guard",
	// No cliDescriptors: `gh` is declared by the github plugin (re-declaring
	// it only produces descriptor-collision warnings).
	predicates: {
		touchesCriticalPathLabel: (args: unknown, ctx: Ctx) => {
			if (args !== true) return false;
			if (ctx.input.basename !== "gh") return false;
			return ghTouchesLabel(ctx);
		},
	},
};

export const CRITICAL_PATH_LABEL_REASON =
	"the critical-path label is the owner's: agents never apply or remove it";

export const criticalPathLabelRules = [
	{
		name: "agents-never-touch-critical-path-label",
		tool: "bash" as const,
		command: ["gh"] as const,
		when: {
			touchesCriticalPathLabel: true,
			not: { infoOnly: { extraFlags: ["-h"] } },
		},
		reason: CRITICAL_PATH_LABEL_REASON,
	},
];
