// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Behavior + end-to-end coverage for the rm plugin's
 * `no-rm-rf-slash` rule (`./rules/no-rm-rf-slash.ts`).
 *
 * The fixtures are ported from the former pattern spot-checks (issue
 * #117 migrated the rule to `command:` + the named `hasRecursiveForce`
 * predicate): if a case flips vs. its old expectation, the routing
 * drifted during the migration. The MERGE GATES live here:
 * recursive-only does NOT fire, force-only does NOT fire,
 * `rm -Rf /` fires, plus the positional `/` pin.
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
import type { Rule } from "../../../schema.ts";
import rmPlugin, { noRmRfSlash } from "../index.ts";

function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

function ruleEvaluator() {
  const resolved = resolvePlugins([rmPlugin], {});
  const rules: readonly Rule[] = [noRmRfSlash];
  return buildEvaluator({ rules }, resolved, makeHost());
}

async function blocks(command: string): Promise<boolean> {
  const ev = ruleEvaluator();
  const r = await ev.evaluate(bashEvent(command), makeCtx("/r"), 0);
  return (r as { block?: boolean } | undefined)?.block === true;
}

describe("rules/no-rm-rf-slash: routing shape", () => {
  it("routes on command rm + hasRecursiveForce predicate", () => {
    assert.equal(noRmRfSlash.command, "rm");
    assert.deepEqual(noRmRfSlash.when, { hasRecursiveForce: true });
  });
});

describe("rules/no-rm-rf-slash: merge gates (issue #117)", () => {
  it("fires on `rm -Rf /` (merge gate)", async () => {
    assert.equal(await blocks("rm -Rf /"), true);
  });

  it("does NOT fire on recursive-only `rm -r /` (merge gate)", async () => {
    assert.equal(await blocks("rm -r /"), false);
  });

  it("does NOT fire on force-only `rm -f /` (merge gate)", async () => {
    assert.equal(await blocks("rm -f /"), false);
  });

  it("fires on `rm -rf /`", async () => {
    assert.equal(await blocks("rm -rf /"), true);
  });

  it("fires on `rm -fr /` (flag order agnostic)", async () => {
    assert.equal(await blocks("rm -fr /"), true);
  });

  it("fires on `rm -r -f /` (separated flags)", async () => {
    assert.equal(await blocks("rm -r -f /"), true);
  });

  it("fires on `rm --recursive --force /` (long-form flags)", async () => {
    assert.equal(await blocks("rm --recursive --force /"), true);
  });

  it("does NOT fire on `rm -rf /tmp` (positional `/` pin)", async () => {
    assert.equal(await blocks("rm -rf /tmp"), false);
  });

  it("does NOT fire on `rm /tmp` (no flags)", async () => {
    assert.equal(await blocks("rm /tmp"), false);
  });

  it("does NOT fire on `rm -r /tmp` (missing force flag)", async () => {
    assert.equal(await blocks("rm -r /tmp"), false);
  });

  it("does NOT fire on `rm -rf .`", async () => {
    assert.equal(await blocks("rm -rf ."), false);
  });

  it("does NOT fire on `echo 'rm -rf /'` (basename is echo)", async () => {
    assert.equal(await blocks("echo 'rm -rf /'"), false);
  });
});

describe("rules/no-rm-rf-slash: end-to-end via buildEvaluator", () => {
  it("blocks `rm -rf /` and ignores override (noOverride: true)", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("rm -rf / # steering-override: no-rm-rf-slash — nope"),
      makeCtx("/r"),
      0,
    );
    assert.equal((r as { block?: boolean } | undefined)?.block, true);
    assert.match(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /no-rm-rf-slash/,
    );
    // noOverride rules should NOT advertise the "To override" hint,
    // because the rule has no override path.
    assert.doesNotMatch(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /To override/,
    );
  });

  it("allows `rm -rf /tmp/foo` (safe path)", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(bashEvent("rm -rf /tmp/foo"), makeCtx("/r"), 0);
    assert.equal(r, undefined);
  });

  it("plugin literal keeps the noOverride: true seal", () => {
    // The seal survived the move out of defaults (#72): the shipped
    // plugin's copy must stay hard-block even against
    // config defaultNoOverride: false.
    const shipped = rmPlugin.rules?.find((r) => r.name === "no-rm-rf-slash");
    assert.ok(shipped, "rule must ship with the plugin");
    assert.equal(shipped.noOverride, true);
  });
});
