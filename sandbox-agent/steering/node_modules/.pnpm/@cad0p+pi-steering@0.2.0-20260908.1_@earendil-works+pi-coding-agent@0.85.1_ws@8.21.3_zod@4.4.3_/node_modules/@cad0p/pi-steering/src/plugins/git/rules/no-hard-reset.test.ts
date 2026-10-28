// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Behavior + end-to-end coverage for the git plugin's `no-hard-reset`
 * rule (`./no-hard-reset.ts`).
 *
 * The fixtures are ported from the former pattern spot-checks (issue
 * #117 migrated the rule to `command:` + `subcommand:` + `flag:`): if
 * a case flips vs. its old expectation, the routing drifted during
 * the migration.
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
import { noHardReset } from "./no-hard-reset.ts";

/**
 * Minimal facts plugin: the real git descriptor table without the
 * plugin's predicates / trackers, so these suites pin the rule's own
 * routing (not the git plugin's exec-backed predicates).
 */
const gitFacts = {
  name: "git-facts",
  cliDescriptors: { git: GIT_CLI_DESCRIPTOR },
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
  const rules: readonly Rule[] = [noHardReset];
  return buildEvaluator({ rules }, resolved, makeHost());
}

async function blocks(command: string): Promise<boolean> {
  const ev = ruleEvaluator();
  const r = await ev.evaluate(bashEvent(command), makeCtx("/r"), 0);
  return (r as { block?: boolean } | undefined)?.block === true;
}

describe("rules/no-hard-reset: routing shape", () => {
  it("routes on command git + subcommand reset + --hard flag", () => {
    assert.equal(noHardReset.command, "git");
    assert.deepEqual(noHardReset.when, {
      subcommand: "reset",
      flag: { anyOf: [{ aliases: ["--hard"], takesValue: false }] },
    });
  });
});

describe("rules/no-hard-reset: end-to-end via buildEvaluator", () => {
  it("blocks `git reset --hard`", async () => {
    assert.equal(await blocks("git reset --hard"), true);
  });

  it("blocks `git reset --hard HEAD`", async () => {
    assert.equal(await blocks("git reset --hard HEAD"), true);
  });

  it("allows `git reset --soft HEAD~1`", async () => {
    assert.equal(await blocks("git reset --soft HEAD~1"), false);
  });

  it("blocks `git -C /other reset --hard` (pre-subcommand flag)", async () => {
    assert.equal(await blocks("git -C /other reset --hard"), true);
  });

  it("blocks `git -c key=val reset --hard` (key=val config)", async () => {
    assert.equal(await blocks("git -c key=val reset --hard"), true);
  });

  it("blocks `sh -c 'git reset --hard'` (wrapper)", async () => {
    assert.equal(await blocks("sh -c 'git reset --hard'"), true);
  });

  it("does NOT block `echo 'git reset --hard'` (basename is echo)", async () => {
    assert.equal(await blocks("echo 'git reset --hard'"), false);
  });

  it("block reason names the rule", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("git reset --hard HEAD"),
      makeCtx("/r"),
      0,
    );
    assert.match(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /no-hard-reset/,
    );
  });
});
