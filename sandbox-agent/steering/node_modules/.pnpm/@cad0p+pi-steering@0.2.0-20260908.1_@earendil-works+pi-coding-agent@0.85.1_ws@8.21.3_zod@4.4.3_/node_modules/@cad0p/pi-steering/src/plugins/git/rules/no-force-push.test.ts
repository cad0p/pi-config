// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Behavior + end-to-end coverage for the git plugin's `no-force-push`
 * rule (`./no-force-push.ts`).
 *
 * The fixtures are ported from the former pattern spot-checks (issue
 * #117 migrated the rule to `command:` + `subcommand:` + force-signal
 * condition): if a case flips vs. its old expectation, the routing
 * drifted during the migration. The one deliberate behavior change is
 * `--force-bar` (unknown `--force-*` suffixes no longer block —
 * token-exact matching; see the rule's table-reference docs).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  makeCtx,
  makeTrackedHost as makeHost,
} from "../../../__test-helpers__.ts";
import { buildEvaluator } from "../../../evaluator.ts";
import { resolvePlugins } from "../../../plugin-merger.ts";
import type { Plugin, Rule } from "../../../schema.ts";
import { GIT_CLI_DESCRIPTOR } from "../descriptors.ts";
import { isForcePush } from "../predicates/is-force-push.ts";
import { noForcePush } from "./no-force-push.ts";

/**
 * Minimal facts plugin: the real git descriptor table without the
 * plugin's predicates / trackers, so these suites pin the rule's own
 * routing (not the git plugin's exec-backed predicates) — plus the
 * `isForcePush` predicate the rule's `when:` names (shipped rule +
 * shipped predicate travel together; the load-time key check pins
 * the pairing).
 */
const gitFacts = {
  name: "git-facts",
  cliDescriptors: { git: GIT_CLI_DESCRIPTOR },
  predicates: { isForcePush },
} as const satisfies Plugin;

function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

function ruleEvaluator() {
  const resolved = resolvePlugins([gitFacts], {});
  const rules: readonly Rule[] = [noForcePush];
  return buildEvaluator({ rules }, resolved, makeHost());
}

async function blocks(command: string): Promise<boolean> {
  const ev = ruleEvaluator();
  const r = await ev.evaluate(bashEvent(command), makeCtx("/r"), 0);
  return (r as { block?: boolean } | undefined)?.block === true;
}

describe("rules/no-force-push: routing shape", () => {
  it("routes on command git + subcommand push + registered isForcePush leaf", () => {
    assert.equal(noForcePush.command, "git");
    const when = noForcePush.when as {
      subcommand?: unknown;
      isForcePush?: unknown;
    };
    assert.equal(when.subcommand, "push");
    // Nullary registered predicate (ADR §13) — never an inline
    // `condition:` (banned by the examples pin; shipped rules name
    // the concept too).
    assert.equal(when.isForcePush, true);
    assert.ok(!("condition" in (noForcePush.when as object)));
  });

  it("force entries are --help-pinned token-exact spellings (table-owned)", () => {
    const { flags: gitFlags } = GIT_CLI_DESCRIPTOR;
    assert.deepEqual(
      [
        gitFlags.force,
        gitFlags.forceShort,
        gitFlags.forceWithLease,
        gitFlags.forceIfIncludes,
        gitFlags.mirror,
      ].map((e) => e.aliases),
      [
        ["--force"],
        ["-f"],
        ["--force-with-lease"],
        ["--force-if-includes"],
        ["--mirror"],
      ],
    );
  });
});

describe("rules/no-force-push: blocks every force form", () => {
  it("blocks `git push --force`", async () => {
    assert.equal(await blocks("git push --force"), true);
  });

  it("blocks `git push -f`", async () => {
    assert.equal(await blocks("git push -f"), true);
  });

  it("blocks `git push --force-with-lease` (sealed, #65)", async () => {
    assert.equal(await blocks("git push --force-with-lease"), true);
  });

  it("blocks `git push --force-if-includes` (sealed, #65)", async () => {
    assert.equal(await blocks("git push --force-if-includes"), true);
  });

  it("blocks bundled short flags (`-uf`, `-fu`, `-nfv`) (#65)", async () => {
    assert.equal(await blocks("git push -uf origin main"), true);
    assert.equal(await blocks("git push -fu origin main"), true);
    assert.equal(await blocks("git push -nfv origin main"), true);
  });

  it("blocks leading-`+` refspecs (#65 merge gate)", async () => {
    assert.equal(await blocks("git push origin +main"), true);
    assert.equal(await blocks("git push origin +src:dst"), true);
  });

  it("blocks `git push --mirror` (#65 merge gate)", async () => {
    assert.equal(await blocks("git push --mirror"), true);
  });

  it("blocks `git push origin main --force`", async () => {
    assert.equal(await blocks("git push origin main --force"), true);
  });

  it("blocks `git -C /other push --force` (pre-subcommand flag)", async () => {
    assert.equal(await blocks("git -C /other push --force"), true);
  });

  it("blocks `git -c rerere.enabled=false push --force` (key=val config)", async () => {
    assert.equal(
      await blocks("git -c rerere.enabled=false push --force"),
      true,
    );
  });

  it("blocks `git --git-dir=/path push --force` (long-form pre-subcommand)", async () => {
    assert.equal(await blocks("git --git-dir=/path push --force"), true);
  });

  it("blocks `git push --force` behind `sh -c` wrapper", async () => {
    // The AST backend's wrapper-expansion sees the inner command even
    // behind sh/bash -c. Routing-on-basename is why the walker exists.
    assert.equal(await blocks("sh -c 'git push --force'"), true);
  });

  it("blocks `/usr/bin/git push --force` (path stripped)", async () => {
    assert.equal(await blocks("/usr/bin/git push --force"), true);
  });

  it("block reason names the rule", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("git push --force"),
      makeCtx("/r"),
      0,
    );
    assert.match(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /no-force-push/,
    );
  });
});

describe("rules/no-force-push: allows clean pushes", () => {
  it("does NOT block plain `git push origin main` (#65 merge gate)", async () => {
    assert.equal(await blocks("git push origin main"), false);
  });

  it("does NOT block non-force short flags alone (-u/-n/-q/-v)", async () => {
    assert.equal(await blocks("git push -u origin main"), false);
    assert.equal(await blocks("git push -n origin main"), false);
    assert.equal(await blocks("git push -q origin main"), false);
    assert.equal(await blocks("git push -v origin main"), false);
  });

  it("does NOT block branch names with mid-token `+` (c++-port)", async () => {
    // Only LEADING-`+` refspec forms are force markers.
    assert.equal(await blocks("git push origin c++-port"), false);
  });

  it("does NOT block unknown `--force-*` suffixes (token-exact, #117)", async () => {
    // Deliberate change from the old `--force\\b` over-match: unknown
    // future spellings are not force evidence. Real git rejects
    // `--force-bar` as an unknown option anyway.
    assert.equal(await blocks("git push --force-bar"), false);
  });

  it("does NOT block `echo 'git push --force'` (basename is echo)", async () => {
    assert.equal(await blocks("echo 'git push --force'"), false);
  });
});
