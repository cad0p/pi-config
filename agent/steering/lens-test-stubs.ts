// SPDX-License-Identifier: MIT
/**
 * Test support for the pc-host #704 lens-brief gates (base-rules.ts): a gh
 * stub, a git stub and a passing tools/ci.sh summary, wired through the
 * module's env seams. Nothing here touches the network, a real operator
 * clone or the operator's state.
 *
 * The git stub is clone-aware: it records every `-C <clone>` it was called
 * with (git-calls.log, "<clone basename> <command>") and answers from
 * `clones[<basename>]` when the config names that clone, else from the
 * root defaults. A clone scope with no `default_parents` refuses an
 * unknown sha, which is what a clone without that commit does.
 *
 * Every suite that writes a `kind: lens` brief needs this: the brief now
 * carries `head: <40-hex>` and a passing run bound to that head, or the
 * gate refuses it.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The head every stub lens brief reviews (40 hex). */
export const LENS_HEAD = "1".repeat(40);

/** A second head, for the "not the PR's head" cases. */
export const OTHER_HEAD = "2".repeat(40);

/** The head's tree, as the summary's `run on:` line names it. */
export const LENS_TREE = "3".repeat(40);

/** The operator clone's origin/main, for the absorb-of binding. */
export const LENS_MAIN = "4".repeat(40);

/** A non-pc-host repo's PR (the absorb-of binding must read its own clone). */
export const TENANT_PR = "cad0p/pc-tenant#189";

/** That PR's head, as gh reports it. */
export const TENANT_HEAD = "5".repeat(40);

/** That repo's origin/main, as its own clone holds it. */
export const TENANT_MAIN = "6".repeat(40);

const GH_STUB = `#!/usr/bin/env bash
set -Eeuo pipefail
cfg="\$STUB_CFG/gh.json"
sub="\$1 \$2"
pr=""
for a in "\$@"; do
  case "\$a" in
    */pulls/*/files*) pr="\$(sed -E 's#.*/pulls/([0-9]+)/files.*#\\1#' <<<"\$a")" ;;
    *) [[ "\$a" =~ ^[0-9]+\$ ]] && pr="\$a" ;;
  esac
  [[ -z "\$pr" ]] || break
done
case "\$sub" in
  "pr view")
    [[ "\$(jq -r --arg p "\$pr" '.prs[\$p].head_fail // false' "\$cfg")" != true ]] || { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
    jq -r --arg p "\$pr" '.prs[\$p].head // .default_head // ""' "\$cfg" ;;
  "pr diff")
    [[ "\$(jq -r --arg p "\$pr" '.prs[\$p].diff_fail // false' "\$cfg")" != true ]] || { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
    jq -r --arg p "\$pr" '(.prs[\$p].paths // .default_paths // [])[]' "\$cfg" ;;
  "api --paginate")
    case "\$*" in
      *"/pulls/"*"/files"*)
        [[ "\$(jq -r --arg p "\$pr" '.prs[\$p].diff_fail // false' "\$cfg")" != true ]] || { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
        jq -r --arg p "\$pr" '.prs[\$p].lines // .default_lines // 0' "\$cfg" ;;
      *"/issues/"*"/comments"*)
        [[ "\$(jq -r '.comments_fail // false' "\$cfg")" != true ]] || { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
        jq -c '.comments // []' "\$cfg" ;;
      *) echo "unexpected gh api: \$*" >&2; exit 97 ;;
    esac ;;
  *) echo "unexpected gh: \$*" >&2; exit 97 ;;
esac
`;

const GIT_STUB = `#!/usr/bin/env bash
set -Eeuo pipefail
cfg="\$STUB_CFG/git.json"
clone="\$2"
name="\$(basename "\$clone")"
printf '%s %s\n' "\$name" "\$3" >> "\$STUB_CFG/git-calls.log"
shift 2   # -C <clone>
cmd="\$1"
case "\$cmd" in
  fetch) exit 0 ;;
  rev-parse) jq -r --arg n "\$name" --arg r "\$2" '(.clones[\$n] // .) | (.refs[\$r] // "")' "\$cfg" ;;
  cat-file)
    found="\$(jq -r --arg n "\$name" --arg s "\$3" '(.clones[\$n] // .) | if (.commits[\$s] // null) != null then "commit" elif has("default_parents") then "default" else "missing" end' "\$cfg")"
    # A clone scope with no default_parents answers "missing" for a sha it
    # does not hold, as git does: fail closed, never a guessed parent list.
    [[ "\$found" != missing ]] || { echo "fatal: Not a valid object name \$3" >&2; exit 128; }
    {
      printf 'tree 0000000000000000000000000000000000000000\n'
      if [[ "\$found" == commit ]]; then
        jq -r --arg n "\$name" --arg s "\$3" '(.clones[\$n] // .) | .commits[\$s].parents[]' "\$cfg" | sed 's/^/parent /'
      else
        jq -r --arg n "\$name" '(.clones[\$n] // .) | .default_parents[]' "\$cfg" | sed 's/^/parent /'
      fi
      printf '\n'
    } ;;
  merge-base)
    # A pair the config does not name is an ancestor (the permissive default);
    # a case that needs the negative answer names the pair.
    [[ "\$(jq -r --arg n "\$name" --arg k "\$3 \$4" '(.clones[\$n] // .) | ((.ancestors // {}) | if has(\$k) then .[\$k] else true end)' "\$cfg")" == true ]] && exit 0
    exit 1 ;;
  *) echo "unexpected git: \$*" >&2; exit 97 ;;
esac
`;

const HELPER_STUB = `#!/usr/bin/env bash
set -Eeuo pipefail
cfg="\$STUB_CFG/helper.json"
[[ "\$1" == rounds ]] || { echo "unexpected helper: \$*" >&2; exit 97; }
pr="\$3"
if [[ "\$(jq -r --arg p "\$pr" '.fail[\$p] // false' "\$cfg")" == true ]]; then
  echo "error: the lens round count failed (rc 5): a lens bucket row names no head" >&2
  exit 2
fi
jq -r --arg p "\$pr" '(.rounds[\$p] // []) | to_entries[] | "\\(.key + 1) \\(.value)"' "\$cfg"
`;

/** Write a stub to `<dir>/<name>` and make it executable; returns its path. */
function stub(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

/**
 * Install the stubs under `root` and point the module's seams at them.
 * The gh stub answers for PR 650 (the suites' PR) with `LENS_HEAD` as its
 * head; the helper stub prints no rounds; the git stub has no commits.
 */
export function installLensStubs(root: string): void {
	const bin = join(root, "stubs");
	mkdirSync(bin, { recursive: true });
	// The suites' PRs: 650 is the parent, 700 the split piece (a strict subset
	// with fewer changed lines, so it restarts at round 1).
	writeFileSync(
		join(bin, "gh.json"),
		JSON.stringify({
			default_head: LENS_HEAD,
			default_paths: ["tools/example.sh"],
			default_lines: 40,
			prs: {
				"650": { head: LENS_HEAD, paths: ["tools/example.sh"], lines: 40 },
				"700": { head: LENS_HEAD, paths: ["tools/example.sh"], lines: 10 },
			},
			comments: [],
		}),
	);
	// Any sha reads as a two-parent merge of the reviewed head and main, and
	// main is not an ancestor of the reviewed head: one parent reachable from
	// main, which is the absorb shape.
	writeFileSync(
		join(bin, "git.json"),
		JSON.stringify({
			commits: {},
			refs: { "refs/remotes/origin/main": LENS_MAIN },
			ancestors: { [`${LENS_HEAD} ${LENS_MAIN}`]: false },
			default_parents: [LENS_HEAD, LENS_MAIN],
		}),
	);
	writeFileSync(join(bin, "helper.json"), JSON.stringify({ rounds: {}, fail: {} }));
	process.env.STUB_CFG = bin;
	process.env.PI_H4_GH = stub(bin, "gh", GH_STUB);
	process.env.PI_H4_GIT = stub(bin, "git", GIT_STUB);
	process.env.PI_H4_MERGE_HELPER = stub(bin, "merge-pr.sh", HELPER_STUB);
	process.env.PI_H4_CLONE = join(root, "clone");
	// The per-repo clones (base-rules.ts repoClone): one directory per repo,
	// so pc-host PRs resolve to the stub's clones/cad0p--pc-host and a repo
	// with no directory there is the missing-clone case.
	process.env.PI_H4_CLONES_ROOT = join(root, "clones");
	mkdirSync(join(root, "clones", "cad0p--pc-host"), { recursive: true });
	process.env.PI_H4_PCMERGE_STATE = join(root, "pc-merge");
	// The helper's own evidence override is dropped: the suite drives the
	// state root, and an ambient override would point every case at another
	// tree (a case that wants it sets it after this call).
	delete process.env.PC_MERGE_EVIDENCE_ROOT;
}

/** Drop the seams (the temp root is removed by the suite). */
export function clearLensStubs(): void {
	for (const name of [
		"STUB_CFG",
		"PI_H4_GH",
		"PI_H4_GIT",
		"PI_H4_MERGE_HELPER",
		"PI_H4_CLONE",
		"PI_H4_CLONES_ROOT",
		"PI_H4_PCMERGE_STATE",
		"PC_MERGE_EVIDENCE_ROOT",
		"PI_H4_ROUNDS_FROM_HELPER",
	]) {
		delete process.env[name];
	}
}

/** The clone directories the stubs answer for, under `root`. */
export function cloneDir(root: string, name: string): string {
	return join(root, "clones", name);
}

/**
 * A tools/ci.sh summary for `head`: green, clean, and bound to that head.
 * Returns its path.
 */
export function passingSummary(
	root: string,
	head: string = LENS_HEAD,
	name = "ci-summary.txt",
): string {
	const path = join(root, name);
	writeFileSync(
		path,
		[
			"ci summary",
			`run on:    snapshot commit ${head} tree ${LENS_TREE}`,
			"  ok  lint",
			"worktree dirty after run: no",
			"result: PASS",
			"",
		].join("\n"),
	);
	return path;
}

/** The header lines a lens brief needs: the head and its passing run. */
export function lensHeaderLines(root: string): string {
	return `head: ${LENS_HEAD}\ngreen-run: ${passingSummary(root)}\n`;
}
