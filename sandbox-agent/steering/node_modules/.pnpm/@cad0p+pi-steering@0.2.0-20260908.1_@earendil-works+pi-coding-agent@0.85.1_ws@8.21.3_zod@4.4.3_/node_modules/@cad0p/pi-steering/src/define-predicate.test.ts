// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `definePredicate<T>` — shape smoke + typed-argument flow.
 *
 * `definePredicate` is purely type-level sugar; at runtime it returns
 * its handler unchanged. These tests pin the runtime contract (call
 * with typed args gets through unchanged) and the type signature by
 * constructing examples that would fail to compile if the generic
 * were mishandled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { definePredicate } from "./define-predicate.ts";
import { commandFromInput } from "./helpers/command.ts";
import type { Plugin, PredicateContext, PredicateHandler } from "./schema.ts";

describe("definePredicate", () => {
  it("returns the handler unchanged (pure pass-through)", () => {
    const handler = (_args: { pattern: RegExp }, _ctx: PredicateContext) =>
      true;
    const wrapped = definePredicate<{ pattern: RegExp }>(handler);
    assert.equal(wrapped, handler as unknown);
  });

  it("resulting handler is assignable into Plugin.predicates", () => {
    interface CommitFormatArgs {
      pattern: RegExp;
      onUnknown?: "allow" | "block";
    }
    const commitFormat = definePredicate<CommitFormatArgs>((args, _ctx) =>
      args.pattern.test("conventional: subject"),
    );
    // If definePredicate returned PredicateHandler<CommitFormatArgs>
    // instead of the loose PredicateHandler, this assignment would
    // fail because Plugin.predicates is keyed with the loose
    // handler type.
    const plugin: Plugin = {
      name: "git",
      predicates: { commitFormat },
    };
    assert.equal(plugin.name, "git");
    assert.equal(typeof plugin.predicates?.commitFormat, "function");
  });

  it("handler still invokes with typed args at runtime", async () => {
    interface Args {
      flag: string;
    }
    let sawArgs: Args | null = null;
    const handler = definePredicate<Args>((args, _ctx) => {
      sawArgs = args;
      return args.flag === "yes";
    });
    const loose = handler as PredicateHandler;
    const ctx: PredicateContext = {
      cwd: "/",
      tool: "bash",
      input: { tool: "bash", command: "" },
      command: commandFromInput({ tool: "bash", command: "" }),
      agentLoopIndex: 0,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      appendEntry: () => {},
      findEntries: () => [],
    };
    const r = await loose({ flag: "yes" }, ctx);
    assert.equal(r, true);
    assert.deepEqual(sawArgs, { flag: "yes" });
  });
});
