// SPDX-License-Identifier: MIT
// Part of pi-steering.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Observer, Rule } from "../schema.ts";
import { dropUnusedObservers } from "./drop-unused-observers.ts";

/** Minimal Observer for tests. */
function mkObserver(name: string, writes?: readonly string[]): Observer {
  const base = {
    name,
    watch: { toolName: "bash" as const },
    onResult: () => {},
  } satisfies Observer;
  return writes === undefined ? base : { ...base, writes };
}

/** Minimal Rule with a specific `missing` shape. */
function mkRuleWithMissing(name: string, event: string, since?: string): Rule {
  return {
    name,
    tool: "bash",
    command: "x",
    when: {
      missing: since
        ? { event, in: "agent_loop", since }
        : { event, in: "agent_loop" },
    },
    reason: "test",
  };
}

/** Rule with no missing at all. */
function mkRuleNoMissing(name: string): Rule {
  return {
    name,
    tool: "bash",
    command: "x",
    reason: "test",
  };
}

describe("dropUnusedObservers", () => {
  it("keeps observer whose write is consumed by a rule's missing.event", () => {
    const observers = [mkObserver("a", ["X"])];
    const rules = [mkRuleWithMissing("r1", "X")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.name, "a");
    assert.equal(dropped.length, 0);
  });

  it("drops observer whose writes are not consumed", () => {
    const observers = [mkObserver("a", ["X"])];
    const rules = [mkRuleNoMissing("r1")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]?.name, "a");
    assert.deepEqual(dropped[0]?.writes, ["X"]);
    assert.equal(dropped[0]?.reason, "unused-writes");
  });

  it("keeps observer when at least one of its writes is consumed", () => {
    const observers = [mkObserver("a", ["X", "Y"])];
    const rules = [mkRuleWithMissing("r1", "X")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 0);
  });

  it("keeps observer with `writes: undefined` (conservative)", () => {
    const observers = [mkObserver("a", undefined)];
    const rules = [mkRuleNoMissing("r1")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 0);
  });

  it("keeps observer with empty `writes: []` (conservative parity)", () => {
    const observers = [mkObserver("a", [])];
    const rules = [mkRuleNoMissing("r1")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 0);
  });

  it("keeps observer whose write is consumed only by missing.since", () => {
    const observers = [mkObserver("a", ["X"])];
    const rules = [mkRuleWithMissing("r1", "Y", /* since */ "X")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 0);
  });

  it("partitions a mixed observer set correctly", () => {
    const observers = [
      mkObserver("consumed", ["X"]),
      mkObserver("unused", ["Z"]),
      mkObserver("undeclared"),
    ];
    const rules = [mkRuleWithMissing("r1", "X")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.deepEqual(kept.map((o) => o.name).sort(), [
      "consumed",
      "undeclared",
    ]);
    assert.deepEqual(
      dropped.map((d) => d.name),
      ["unused"],
    );
  });

  it("drops everything when no rule uses `when.missing`", () => {
    const observers = [mkObserver("a", ["X"]), mkObserver("b", ["Y", "Z"])];
    const rules = [mkRuleNoMissing("r1"), mkRuleNoMissing("r2")];
    const { kept, dropped } = dropUnusedObservers(observers, rules);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 2);
  });

  it("returns empty arrays for empty inputs", () => {
    const { kept, dropped } = dropUnusedObservers([], []);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 0);
  });

  it("honors caller-applied rule filtering (disabledRules)", () => {
    // Caller is responsible for filtering disabled rules before
    // passing to this helper — demonstrate that a rule NOT in the
    // input list does NOT cause its observer writes to stay alive.
    const observers = [mkObserver("a", ["X"])];
    const rulesAfterDisable: Rule[] = []; // r1 (consumer) disabled → filtered out
    const { kept, dropped } = dropUnusedObservers(observers, rulesAfterDisable);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
  });
});
