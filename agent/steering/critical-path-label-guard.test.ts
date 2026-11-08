// SPDX-License-Identifier: MIT
// critical-path-label-guard tests — agents never apply or remove the
// owner's critical-path label on a cad0p/pc-* repo (pc-host #714 r1,
// red-team F2 = trust-model F2). See the guard's header for the scope.

import { describe, it } from "node:test";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const RULE = "agents-never-touch-critical-path-label";
const REASON = /the critical-path label is the owner's: agents never apply or remove it/;

describe("critical-path-label-guard", () => {
	const harness = loadHarness({ config });
	const blocked = (command: string) =>
		expectBlocks(harness, { command }, { rule: RULE, reason: REASON });
	const allowed = (command: string) => expectAllows(harness, { command });

	// ---- blocked: applying or removing the label on a pc repo ----
	for (const command of [
		"gh pr edit 714 -R cad0p/pc-host --add-label critical-path",
		"gh pr edit 714 --repo cad0p/pc-host --remove-label critical-path",
		"gh pr edit 714 --repo=cad0p/pc-control --add-label=critical-path",
		"gh pr edit 714 -R cad0p/pc-host --add-label 'docs,critical-path'",
		"gh pr edit 714 -R cad0p/pc-host --add-label Critical-Path",
		"gh -R cad0p/pc-host pr edit 714 --add-label critical-path",
		"gh issue edit 713 -R cad0p/pc-host --add-label critical-path",
		"gh issue edit 713 -R cad0p/pc-tenant --remove-label critical-path",
		// no repo named: the cwd decides, so fail closed
		"gh pr edit 714 --add-label critical-path",
		"cd /home/pier/personal/github/pc-host && gh pr edit 714 --remove-label critical-path",
		"GH_REPO=cad0p/pc-host gh pr edit 714 --add-label critical-path",
		"export GH_REPO=cad0p/pc-host && gh pr edit 714 --add-label critical-path",
		"gh pr create -R cad0p/pc-host --title t --body-file b.md --label critical-path",
		"gh issue create -R cad0p/pc-host --title t --body-file b.md -l critical-path",
		"gh label delete critical-path -R cad0p/pc-host --yes",
		"gh label edit critical-path -R cad0p/pc-host --name urgent",
		"gh api repos/cad0p/pc-host/issues/714/labels -f 'labels[]=critical-path'",
		"gh api --method POST repos/cad0p/pc-host/issues/714/labels -f labels[]=critical-path",
		"gh api -X DELETE repos/cad0p/pc-host/issues/714/labels/critical-path",
		"gh api -X PUT repos/cad0p/pc-host/issues/714/labels -f 'labels[]=docs'",
		"gh api -X DELETE repos/cad0p/pc-host/issues/714/labels",
		"gh api -X PATCH repos/cad0p/pc-host/issues/714 -f 'labels[]=docs'",
		"gh api -X DELETE 'repos/{owner}/{repo}/issues/714/labels/critical-path'",
	]) {
		it(`blocks: ${command}`, async () => {
			await blocked(command);
		});
	}

	// ---- blocked: nested (codemode bash payloads, wrappers) ----
	for (const command of [
		"bash -c 'gh pr edit 714 -R cad0p/pc-host --add-label critical-path'",
		"sh -c \"gh api -X DELETE repos/cad0p/pc-host/issues/714/labels/critical-path\"",
		"env GH_REPO=cad0p/pc-host gh pr edit 714 --add-label critical-path",
		"cd /data/tmp/wt/queue-q1 && git status && gh pr edit 714 --add-label critical-path",
	]) {
		it(`blocks nested: ${command}`, async () => {
			await blocked(command);
		});
	}

	// ---- allowed: near misses ----
	for (const command of [
		// other labels (no -R: the github plugin refuses -R on pr/issue edit)
		"gh pr edit 714 --add-label docs",
		"gh pr edit 714 --remove-label critical-path-candidate",
		"gh issue edit 713 --add-label 'bug,blocked'",
		"gh api repos/cad0p/pc-host/issues/714/labels -f 'labels[]=docs'",
		"gh api -X DELETE repos/cad0p/pc-host/issues/714/labels/docs",
		// reading labels and label events
		"gh pr view 714 -R cad0p/pc-host --json labels",
		"gh api repos/cad0p/pc-host/issues/714/labels --jq '.[].name'",
		"gh api repos/cad0p/pc-host/labels/critical-path",
		"gh api -X GET repos/cad0p/pc-host/issues/714/labels",
		"gh api --paginate repos/cad0p/pc-host/issues/714/events | jq 'select(.label.name == \"critical-path\")'",
		"gh pr list -R cad0p/pc-host --label critical-path",
		"gh label list -R cad0p/pc-host",
		"gh label create critical-path -R cad0p/pc-host --color B60205",
		// a named non-pc repo
		"GH_REPO=cad0p/pi-usage gh pr edit 12 --add-label critical-path",
		"gh api -X DELETE repos/cad0p/pi-subagents/issues/3/labels/critical-path",
		// text that merely mentions it
		"grep -rn 'critical-path' tools/merge-pr.sh",
		"gh pr edit 714 --title 'merge queue: the critical-path label check'",
		"gh pr edit 714 --add-label critical-path --help",
	]) {
		it(`allows: ${command}`, async () => {
			await allowed(command);
		});
	}

	// ---- known gaps (see the guard's header) ----
	it("KNOWN GAP: allows the GraphQL addLabelsToLabelable mutation (label node ids only)", async () => {
		await allowed(
			"gh api graphql -f query='mutation { addLabelsToLabelable(input:{labelableId:\"PR_x\", labelIds:[\"LA_y\"]}) { clientMutationId } }'",
		);
	});
	it("KNOWN GAP: allows curl with the gh token", async () => {
		await allowed(
			"curl -X POST -H \"Authorization: token $(gh auth token)\" https://api.github.com/repos/cad0p/pc-host/issues/714/labels -d '{\"labels\":[\"critical-path\"]}'",
		);
	});
});
