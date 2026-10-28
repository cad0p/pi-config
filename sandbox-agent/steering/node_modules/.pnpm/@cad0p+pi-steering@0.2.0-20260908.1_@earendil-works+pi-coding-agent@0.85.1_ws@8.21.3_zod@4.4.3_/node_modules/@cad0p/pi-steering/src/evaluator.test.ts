// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the v2 evaluator pipeline (`buildEvaluator`).
 *
 * The suite exercises the full `tool_call`-to-verdict path:
 *
 *   - bash rules (pattern / requires / unless / when.cwd + onUnknown /
 *     when.not / when.condition / plugin predicates / override comments
 *     / noOverride semantics / rule ordering / walker reuse / exec
 *     memoization / findEntries),
 *   - write + edit rules (field=path / field=content, override
 *     detection, `joined newText` behavior),
 *   - evaluator-level guarantees (walker called once per tool_call;
 *     exec cache shared across rules; unknown `when.<key>` surfaces a
 *     clear error).
 *
 * Heavy use of in-memory stubs for `ExtensionContext` +
 * {@link EvaluatorHost} so the tests are hermetic — no child processes,
 * no real pi runtime. Each helper is commented where it deviates from
 * pi's real behavior.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvState, Tracker } from "@cad0p/unbash-walker";
import type {
  BashToolCallEvent,
  EditToolCallEvent,
  ToolCallEvent,
  WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { makeCtx, makeTrackedHost as makeHost } from "./__test-helpers__.ts";

/** Escape a literal string for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { MissingDescriptorError } from "./arity.ts";
import {
  buildEvaluator,
  EVALUATOR_BUILTIN_TRACKERS,
  type EvaluatorHost,
} from "./evaluator.ts";
import { evaluateWhen } from "./evaluator-internals/predicates.ts";
import {
  BLOCK_REASON_PREAMBLE,
  ENGINE_ERROR_PREAMBLE,
} from "./helpers/block-reason-preamble.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import type {
  CLIDescriptor,
  Observer,
  Pattern,
  Plugin,
  PredicateContext,
  PredicateFn,
  PredicateHandler,
  Rule,
  SteeringConfig,
  TopLevelWhenClause,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------
//
// Event shape helpers stay local to this file — the tool_call and
// tool_result builders in observer-dispatcher.test.ts are genuinely
// different events and don't share a helper surface.

/** Short-hand: build a bash tool_call event with the given command. */
function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

function writeEvent(path: string, content: string): WriteToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "write",
    input: { path, content },
  };
}

function editEvent(
  path: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): EditToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "edit",
    input: { path, edits: [...edits] },
  };
}

/**
 * Basenames these suites drive without owning plugins (issue #107:
 * absent descriptors are loud). Pinned explicit-strict here so each
 * suite exercises its own feature — argv-descriptor loudness itself is
 * pinned in the `arity` / `argv-leaves` suites, not here.
 * Gaps stay loud: resolution names the missing basename, so a new
 * command surfaces as a failure pointing at this list.
 */
const TEST_STRICT_BASENAMES = [
  "git",
  "cd",
  "cr",
  "rm",
  "echo",
  "sync",
  "alpha",
  "bravo",
  "sh",
  "bash",
  "ls",
  "lint",
  "diff",
  "foo",
  "run-me",
  "sudo",
  "aws",
  "npm",
  "anything",
  "mycli",
  "gh",
  "go",
  "kubectl",
  "docker",
  "cowsay",
  "x",
  "y",
  "z",
  "true",
  "cat",
  "pwd",
  "cmd",
  "finalize",
];

/** Resolve plugins with `{}` config so the merger surface is exercised too. */
function resolve(plugins: Plugin[] = []): ResolvedPluginState {
  // Explicit-strict for uncovered basenames (no descriptor-collision:
  // an explicitly passed entry always wins by first registration).
  const covered = new Set(
    plugins.flatMap((p) => Object.keys(p.cliDescriptors ?? {})),
  );
  const strict: Record<string, CLIDescriptor> = {};
  for (const b of TEST_STRICT_BASENAMES) {
    if (!covered.has(b)) strict[b] = {};
  }
  return resolvePlugins(
    [...plugins, { name: "test-explicit-strict", cliDescriptors: strict }],
    {},
  );
}

/**
 * Capture `console.warn` invocations for the S1 tests asserting that
 * a predicate throw is logged (vs. propagating up into pi's
 * `tool_result` shim and leaking the raw `error.message` to the LLM).
 *
 * Usage:
 *
 * ```ts
 * const warnings = captureWarnings();
 * try {
 *   // ... code that should log ...
 *   assert.ok(warnings.some((w) => /expected/.test(w)));
 * } finally {
 *   warnings.restore();
 * }
 * ```
 *
 * Implemented as direct reassignment rather than `t.mock.method` so
 * the helper works regardless of which describe/it block it's called
 * from (some tests don't take `t` — adding it everywhere was noisier
 * than the 4-line util).
 */
function captureWarnings(): string[] & { restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  return Object.assign(warnings, {
    restore: () => {
      console.warn = original;
    },
  });
}

// ---------------------------------------------------------------------------
// Baseline bash behaviour
// ---------------------------------------------------------------------------

const NO_FORCE_PUSH: Rule = {
  name: "no-force-push",
  tool: "bash",
  command: "git",
  reason: "no force push",
};

describe("buildEvaluator: bash basics", () => {
  it("fires on a matching command", async () => {
    const evaluator = buildEvaluator(
      { rules: [NO_FORCE_PUSH] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("git push --force"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res!.reason!, /\[steering:no-force-push@[^\]]+\]/);
  });

  it("returns undefined on a non-matching command", async () => {
    const evaluator = buildEvaluator(
      { rules: [NO_FORCE_PUSH] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("ls -la"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });

  it("respects requires (AND logic)", async () => {
    const rule: Rule = { ...NO_FORCE_PUSH, requires: "\\bmain\\b" };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const fires = await evaluator.evaluate(
      bashEvent("git push --force origin main"),
      makeCtx("/repo"),
      0,
    );
    const skips = await evaluator.evaluate(
      bashEvent("git push --force origin feature"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(fires);
    assert.equal(skips, undefined);
  });

  it("respects unless (exemption)", async () => {
    const rule: Rule = { ...NO_FORCE_PUSH, unless: "--force-with-lease" };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    assert.equal(
      await evaluator.evaluate(
        bashEvent("git push --force-with-lease"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
    );
  });

  it("catches wrappers (sh -c '...')", async () => {
    const evaluator = buildEvaluator(
      { rules: [NO_FORCE_PUSH] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sh -c 'git push --force'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
  });

  it("write rules accept RegExp pattern (not just string)", async () => {
    // Bash routing is exact-equality (no regex); RegExp patterns live
    // on write/edit rules (their mechanism is untouched).
    const rule: Rule = {
      name: "no-etc",
      tool: "write",
      field: "path",
      pattern: /^\/etc\//,
      reason: "no etc writes",
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "write",
        input: { path: "/etc/hosts", content: "x" },
      },
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
  });
});

// ---------------------------------------------------------------------------
// requires / unless as PredicateFn
// ---------------------------------------------------------------------------
//
// `requires` and `unless` also accept a PredicateFn (per schema.ts),
// not just a Pattern. The existing bash-basics block only exercises
// the Pattern form. These tests pin the PredicateFn form + verify the
// PredicateContext the fn receives carries the documented fields
// (cwd, tool, input, agentLoopIndex).

describe("buildEvaluator: requires/unless as PredicateFn", () => {
  it("requires: PredicateFn gates the rule and sees a full PredicateContext", async () => {
    const seen: PredicateContext[] = [];
    let shouldPass = true;
    const rule: Rule = {
      name: "req-fn",
      tool: "bash",
      command: "git",
      reason: "req-fn",
      requires: async (ctx) => {
        seen.push(ctx);
        return shouldPass;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

    // requires-fn returns true → rule fires.
    shouldPass = true;
    const fires = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/repo"),
      7,
    );
    assert.ok(fires);

    // requires-fn returns false → rule skipped.
    shouldPass = false;
    const skips = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/repo"),
      8,
    );
    assert.equal(skips, undefined);

    // Spy verified: ctx shape is the documented PredicateContext for
    // a bash candidate (cwd = per-ref walker cwd, tool = "bash",
    // input.command = basename+args, agentLoopIndex forwarded verbatim).
    assert.equal(seen.length, 2);
    const ctx = seen[0]!;
    assert.equal(ctx.cwd, "/repo");
    assert.equal(ctx.tool, "bash");
    assert.equal(
      (ctx.input as { tool: "bash"; command: string }).command,
      "git push",
    );
    assert.equal(ctx.agentLoopIndex, 7);
    // Functional-shape sanity: the closures the evaluator injected.
    assert.equal(typeof ctx.exec, "function");
    assert.equal(typeof ctx.findEntries, "function");
    assert.equal(typeof ctx.appendEntry, "function");
    // Second invocation carries the updated agentLoopIndex.
    assert.equal(seen[1]!.agentLoopIndex, 8);
  });

  it("unless: PredicateFn exempts the rule and sees a full PredicateContext", async () => {
    const seen: PredicateContext[] = [];
    let exempt = false;
    const rule: Rule = {
      name: "unl-fn",
      tool: "bash",
      command: "git",
      reason: "unl-fn",
      unless: async (ctx) => {
        seen.push(ctx);
        return exempt;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

    // unless-fn returns false → rule NOT exempt → fires.
    exempt = false;
    const fires = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/repo"),
      3,
    );
    assert.ok(fires);

    // unless-fn returns true → rule exempted → skipped.
    exempt = true;
    const skips = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/repo"),
      4,
    );
    assert.equal(skips, undefined);

    assert.equal(seen.length, 2);
    const ctx = seen[0]!;
    assert.equal(ctx.cwd, "/repo");
    assert.equal(ctx.tool, "bash");
    assert.equal(
      (ctx.input as { tool: "bash"; command: string }).command,
      "git push",
    );
    assert.equal(ctx.agentLoopIndex, 3);
    assert.equal(seen[1]!.agentLoopIndex, 4);
  });

  it("requires-fn sync throw projects to satisfied: rule fires, single warn", async () => {
    const rule: Rule = {
      name: "req-throws",
      tool: "bash",
      command: "git",
      reason: "req-throws",
      requires: () => {
        throw new Error("boom-requires");
      },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const res = await evaluator.evaluate(
        bashEvent("git push"),
        makeCtx("/repo"),
        0,
      );
      // Strict projection: unknown requires → satisfied → chain
      // continues → rule fires (fail CLOSED, not warn+skip).
      assert.ok(res && res.block === true);
      // Exactly one rule-tagged warn (locks no double-warn with the
      // shared backstop catch).
      assert.equal(
        warnings.filter((w) =>
          /predicate threw for rule "req-throws"@user/.test(w),
        ).length,
        1,
      );
      assert.ok(
        warnings.some((w) => /boom-requires/.test(w)),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it("requires-fn async rejection projects to satisfied: rule fires, single warn", async () => {
    const rule: Rule = {
      name: "req-rejects",
      tool: "bash",
      command: "git",
      reason: "req-rejects",
      requires: async () => {
        throw new Error("boom-requires-async");
      },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const res = await evaluator.evaluate(
        bashEvent("git push"),
        makeCtx("/repo"),
        0,
      );
      // Sync throw and async rejection project identically (both
      // surface at the clause's `await`).
      assert.ok(res && res.block === true);
      assert.equal(
        warnings.filter((w) =>
          /predicate threw for rule "req-rejects"@user/.test(w),
        ).length,
        1,
      );
      assert.ok(
        warnings.some((w) => /boom-requires-async/.test(w)),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it("unless-fn throw (sync + async) projects to absent: rule fires, single warn per throw", async () => {
    const cases: Array<{ name: string; unless: Pattern | PredicateFn }> = [
      {
        name: "unl-throws-sync",
        unless: () => {
          throw new Error("boom-unless-sync");
        },
      },
      {
        name: "unl-rejects-async",
        unless: async () => {
          throw new Error("boom-unless-async");
        },
      },
    ];
    // Mirrors the issue's draft-prs-only exploit trace: pattern
    // matches, throwing `unless` fn must NOT skip the rule.
    for (const { name, unless } of cases) {
      const rule: Rule = {
        name,
        tool: "bash",
        command: "git",
        reason: name,
        unless,
      };
      const warnings = captureWarnings();
      try {
        const evaluator = buildEvaluator(
          { rules: [rule] },
          resolve(),
          makeHost(),
        );
        const res = await evaluator.evaluate(
          bashEvent("git push"),
          makeCtx("/repo"),
          0,
        );
        assert.ok(res && res.block === true);
        assert.equal(
          warnings.filter((w) =>
            new RegExp(`predicate threw for rule "${name}"@user`).test(w),
          ).length,
          1,
        );
      } finally {
        warnings.restore();
      }
    }
  });

  it("MissingDescriptorError from requires/unless fns passes through to a loud rule-tagged block (no warn)", async () => {
    const clauses: Array<{
      name: string;
      makeClause: () => Pick<Rule, "requires" | "unless">;
    }> = [
      {
        name: "req-mde",
        makeClause: () => ({
          requires: () => {
            throw new MissingDescriptorError("gh");
          },
        }),
      },
      {
        name: "unl-mde",
        makeClause: () => ({
          unless: () => {
            throw new MissingDescriptorError("gh");
          },
        }),
      },
    ];
    const warnings = captureWarnings();
    try {
      for (const { name, makeClause } of clauses) {
        const rule: Rule = {
          name,
          tool: "bash",
          command: "git",
          reason: name,
          ...makeClause(),
        };
        const evaluator = buildEvaluator(
          { rules: [rule] },
          resolve(),
          makeHost(),
        );
        const res = await evaluator.evaluate(
          bashEvent("git push"),
          makeCtx("/repo"),
          0,
        );
        // Loud-block passthrough wins over projection: rule-tagged
        // block naming the basename + remedy, never warn+skip.
        assert.ok(res && res.block === true);
        assert.match(res.reason!, new RegExp(`\\[steering:${name}@user\\]`));
        assert.match(res.reason!, /No CLI descriptor for basename "gh"/);
      }
      assert.equal(warnings.length, 0);
    } finally {
      warnings.restore();
    }
  });

  it("Pattern requires/unless forms are unaffected", async () => {
    const base: Rule = {
      name: "pat",
      tool: "bash",
      command: "git",
      reason: "pat",
    };
    // requires-Pattern non-match → skip.
    const reqSkip = buildEvaluator(
      { rules: [{ ...base, requires: "\\bmain\\b" }] },
      resolve(),
      makeHost(),
    );
    assert.equal(
      await reqSkip.evaluate(
        bashEvent("git push origin feature"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
    );
    // unless-Pattern match → skip.
    const unlSkip = buildEvaluator(
      { rules: [{ ...base, unless: "\\bmain\\b" }] },
      resolve(),
      makeHost(),
    );
    assert.equal(
      await unlSkip.evaluate(
        bashEvent("git push origin main"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
    );
    // requires-Pattern match + unless-Pattern non-match → fires.
    const fires = buildEvaluator(
      {
        rules: [{ ...base, requires: "\\bmain\\b", unless: "\\bfeature\\b" }],
      },
      resolve(),
      makeHost(),
    );
    assert.ok(
      await fires.evaluate(
        bashEvent("git push origin main"),
        makeCtx("/repo"),
        0,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// when.cwd + walker + onUnknown
// ---------------------------------------------------------------------------

describe("buildEvaluator: when.cwd", () => {
  it("fires only when per-ref effective cwd matches", async () => {
    const rule: Rule = {
      name: "no-amend-personal",
      tool: "bash",
      command: "git",
      reason: "no amend personal",
      when: { cwd: "/personal/" },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const fires = await evaluator.evaluate(
      bashEvent("cd /home/me/personal/x && git commit --amend"),
      makeCtx("/work"),
      0,
    );
    const skips = await evaluator.evaluate(
      bashEvent("cd /home/me/work/x && git commit --amend"),
      makeCtx("/work"),
      0,
    );
    assert.ok(fires);
    assert.equal(skips, undefined);
  });

  it("object-form with onUnknown:'block' fires on unresolvable cd target", async () => {
    const rule: Rule = {
      name: "block-unknown-cwd",
      tool: "bash",
      command: "rm",
      reason: "blocks on unknown cwd",
      when: { cwd: { pattern: "/never-matches/", onUnknown: "block" } },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    // Tier B (PR #5): `cd $(pwd)` is statically intractable — the walker
    // emits the cwdTracker's `unknown` sentinel, and the engine's
    // `when.cwd` with `onUnknown: 'block'` fires the rule (fail-closed).
    // This supersedes the pre-Tier-B Phase 1 exception that would have
    // carried /repo forward silently.
    const res = await evaluator.evaluate(
      bashEvent("cd $(pwd) && rm foo"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res, "rule must fire when cwd is unknown and onUnknown:'block'");
    assert.match(
      (res as { reason: string }).reason,
      /block-unknown-cwd/,
      "block reason names the firing rule",
    );
  });

  it("object-form with onUnknown:'allow' skips on unresolvable cd target (opt-out of fail-closed)", async () => {
    // Opposite of the block case above. An author who knows their
    // rule should NOT fire on unresolvable cwd opts in via
    // onUnknown: "allow". The walker still emits "unknown"; the
    // built-in evaluateCwd routes to the allow branch.
    const rule: Rule = {
      name: "dont-block-on-unknown",
      tool: "bash",
      command: "rm",
      reason: "would block, but onUnknown allows",
      when: { cwd: { pattern: "/never-matches/", onUnknown: "allow" } },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("cd $(pwd) && rm foo"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "rule must NOT fire when cwd is unknown and onUnknown:'allow'",
    );
  });

  it("object-form without onUnknown defaults to 'block' (fail-closed)", async () => {
    // Pins the default: omitting `onUnknown` is equivalent to
    // `onUnknown: 'block'`. Covers the evaluator's hot-path branch
    // where obj.onUnknown is undefined.
    const rule: Rule = {
      name: "default-block-on-unknown",
      tool: "bash",
      command: "rm",
      reason: "default-block",
      when: { cwd: { pattern: "/never-matches/" } },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("cd $(pwd) && rm foo"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res,
      "rule must fire on unknown when onUnknown is omitted (default: block)",
    );
  });

  it("object-form with onUnknown:'Allow' (capitalization typo) falls back to fail-closed block", async () => {
    // Pin the symmetry between this engine site (`evaluateCwd`)
    // and the gitPlugin's `unwrapPatternArg` site
    // (`src/plugins/git/predicates.ts`): both
    // treat any non-lowercase-`"allow"` value as the fail-CLOSED
    // default. The JSDoc on `onUnknown` documents `"allow" | "block"`
    // in lowercase only; this test guards the typo-defense behavior
    // that protects safety-rail rules with `cwd:` carve-outs from
    // silently failing OPEN under a capitalization mistake.
    //
    // Counterfactual: a refactor that re-introduced the
    // `(obj.onUnknown ?? "block") === "block"` form (which only
    // triggers the `??` fallback on `undefined`) would route
    // `"Allow"` through the explicit-equality check, find it !==
    // `"block"`, and silently allow — the engine and plugin would
    // disagree on the same input, and a vault-scoped rule like
    // `not: { cwd: { pattern: ..., onUnknown: "Allow" } }` would
    // behave inconsistently between cwd and branch / upstream /
    // remote predicates.
    const rule: Rule = {
      name: "capitalization-typo-fail-closed",
      tool: "bash",
      command: "rm",
      reason: "typo defense",
      when: {
        cwd: {
          pattern: "/never-matches/",
          // Deliberate capitalization typo. Cast through `unknown`
          // because the schema's `onUnknown` field is typed against
          // the lowercase literal union; the runtime guard is what
          // we're pinning here, not the type.
          onUnknown: "Allow" as unknown as "allow" | "block",
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("cd $(pwd) && rm foo"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res,
      "capitalization-typo `onUnknown: 'Allow'` must fall back to fail-CLOSED block, matching the gitPlugin site",
    );
  });

  it("plugin predicate with onUnknown:'block' fires when handler sees unknown", async () => {
    // Stand in for the future `when.branch` predicate: the plugin
    // handler honors the object form's `onUnknown` policy itself.
    const branchPredicate: PredicateHandler<
      string | { pattern: string; onUnknown?: "allow" | "block" }
    > = (args) => {
      const unwrapped =
        typeof args === "object" &&
        args !== null &&
        "pattern" in (args as Record<string, unknown>)
          ? (args as { pattern: string; onUnknown?: "allow" | "block" })
          : { pattern: args as string };
      // Stub: pretend the branch is always "unknown".
      if (unwrapped.onUnknown === "allow") return false;
      // "block" (default) → predicate passes so the rule fires.
      return true;
    };
    const plugin: Plugin = {
      name: "git",
      predicates: { branch: branchPredicate },
    };
    const ruleBlock: Rule = {
      name: "no-main-commit",
      tool: "bash",
      command: "git",
      reason: "no commit on main",
      when: { branch: { pattern: "^main$", onUnknown: "block" } },
    };
    const ruleAllow: Rule = {
      ...ruleBlock,
      name: "no-main-commit-allow",
      when: { branch: { pattern: "^main$", onUnknown: "allow" } },
    };

    const evalBlock = buildEvaluator(
      { rules: [ruleBlock] },
      resolve([plugin]),
      makeHost(),
    );
    const evalAllow = buildEvaluator(
      { rules: [ruleAllow] },
      resolve([plugin]),
      makeHost(),
    );

    assert.ok(
      await evalBlock.evaluate(bashEvent("git commit -m x"), makeCtx("/r"), 0),
    );
    assert.equal(
      await evalAllow.evaluate(bashEvent("git commit -m x"), makeCtx("/r"), 0),
      undefined,
    );
  });

  // ---------------------------------------------------------------
  // Tier B / PR #5 — D1/D2 success criteria.
  //
  // Pin the end-to-end chain through the real engine (buildEvaluator
  // wires cwdTracker + envTracker by default). These asserts guard
  // against future tracker-composition regressions — a change that
  // drops env tracker registration, or re-introduces the Phase 1
  // exception, would surface here first.
  // ---------------------------------------------------------------

  it('chain: `WS=/ws; cd "$WS/pkg"; cmd` — rule with when.cwd: /ws\\/pkg/ fires on cmd', async () => {
    const rule: Rule = {
      name: "block-rm-in-pkg",
      tool: "bash",
      command: "rm",
      reason: "no rm inside the package",
      when: { cwd: "/ws/pkg" },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('WS=/ws; cd "$WS/pkg"; rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.ok(res, "env-expanded cwd /ws/pkg should match the rule");
    assert.match((res as { reason: string }).reason, /block-rm-in-pkg/);
  });

  it("chain: `cd \"$UNDEFINED\"; rm foo` — fail-closed onUnknown:'block' fires rule", async () => {
    const rule: Rule = {
      name: "workspace-only",
      tool: "bash",
      command: "rm",
      reason: "only allowed in /workspace",
      when: { cwd: /\/workspace/ },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEFINED"; rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.ok(
      res,
      "unresolvable cd target must fail-close via onUnknown:'block'",
    );
    assert.match((res as { reason: string }).reason, /workspace-only/);
  });

  it('subshell isolation: `(FOO=/s; cd "$FOO"); cmd` — outer cmd sees initial cwd, no leaked env', async () => {
    const rule: Rule = {
      name: "in-s-only",
      tool: "bash",
      command: "cmd",
      reason: "only allowed at /s",
      when: { cwd: "^/s$" },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    // Outer cmd runs at /start (subshell's cd /s didn't leak out).
    // The rule wants cwd === /s; it shouldn't fire.
    const res = await evaluator.evaluate(
      bashEvent('(FOO=/s; cd "$FOO"); cmd'),
      makeCtx("/start"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "outer cmd's cwd is /start, not /s — no block",
    );
  });
});

// ---------------------------------------------------------------------------
// when.cwd: Pattern[] / { pattern: Pattern[]; onUnknown? } array form
// ---------------------------------------------------------------------------
//
// Pins the array shorthand and `{ pattern: Pattern[]; onUnknown }` form
// for the engine's built-in `cwd` predicate. Mirror tests for the
// gitPlugin's pattern-valued predicates (branch / upstream / remote)
// live in `plugins/git/predicates.test.ts`.
//
// Array semantics: OR-of-matches. Empty array invalid (rule skips);
// arrays with non-Pattern elements invalid (rule skips uniformly
// regardless of walker-cwd state).

describe("buildEvaluator: when.cwd array form", () => {
  it("shorthand Pattern[] matches when cwd matches any pattern", async () => {
    const rule: Rule = {
      name: "vault-only",
      tool: "bash",
      command: "rm",
      reason: "vault paths",
      when: { cwd: [/\/Goldmine\//, /\/\.cache\/napkin-distill\//] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/home/me/Goldmine/notes"),
      0,
    );
    assert.ok(res, "first array pattern must match cwd");
  });

  it("shorthand Pattern[] skips when cwd matches no pattern", async () => {
    const rule: Rule = {
      name: "vault-only",
      tool: "bash",
      command: "rm",
      reason: "vault paths",
      when: { cwd: [/\/Goldmine\//, /\/\.cache\/napkin-distill\//] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/home/me/code/project"),
      0,
    );
    assert.equal(res, undefined, "no array pattern matches — rule skips");
  });

  it("shorthand Pattern[] under walker-unknown cwd fires fail-closed (default onUnknown: 'block')", async () => {
    // Bare-array shorthand (no `onUnknown` specified) inherits the
    // same default `onUnknown: "block"` posture as the bare single-
    // pattern shorthand. Without this contract, a refactor that wired
    // the array-shorthand path to fall-through fail-skip would let
    // `cd "$VAR" && rm foo` slip past a vault-scoped rule — silent
    // fail-OPEN, which is exactly the safety regression `onUnknown:
    // "block"` is the default for.
    const rule: Rule = {
      name: "vault-only-shorthand",
      tool: "bash",
      command: "rm",
      reason: "vault paths",
      when: { cwd: [/^\/work\//, /^\/Goldmine\//] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEF" && rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.ok(
      res,
      "bare-array shorthand under walker-unknown cwd — fires fail-closed by default",
    );
  });

  it("shorthand mixed-type array under walker-unknown cwd — rule skips uniformly", async () => {
    // Cross-branch parity with the known-cwd mixed-type-array test:
    // the explicit `Array.isArray return false` early-return runs
    // BEFORE the unknown-cwd branch, so a malformed-array shorthand
    // fail-skips uniformly across known and unknown cwd. Without this
    // uniformity, a typo like `[/foo/, 123]` would behave one way
    // under known cwd (skip) and another way under unknown cwd (fire
    // fail-closed at the trailing fallback), masking config errors
    // asymmetrically.
    const rule: Rule = {
      name: "mixed-arr-unknown",
      tool: "bash",
      command: "rm",
      reason: "mixed arr unknown",
      when: { cwd: [/\/foo\//, 123] as unknown as RegExp[] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEF" && rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "shorthand mixed-type array under walker-unknown cwd — rule skips uniformly",
    );
  });

  it("single-element array equivalent to single-pattern shorthand", async () => {
    const rule: Rule = {
      name: "single-elem",
      tool: "bash",
      command: "rm",
      reason: "single elem",
      when: { cwd: [/^\/work$/] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const hit = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.ok(hit);
    const miss = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/elsewhere"),
      0,
    );
    assert.equal(miss, undefined);
  });

  it("empty array is invalid (rule skips, regardless of walker cwd)", async () => {
    const rule: Rule = {
      name: "empty-arr",
      tool: "bash",
      command: "rm",
      reason: "empty arr",
      when: { cwd: [] as RegExp[] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.equal(res, undefined, "empty array invalid — rule skips");
  });

  it("array with non-Pattern element is invalid (rule skips, NOT a fail-open coercion)", async () => {
    // Without the explicit `Array.isArray(value) && return false` guard
    // in evaluateCwd, this falls through to the malformed-shorthand
    // path. Empirically, `new RegExp([/foo/, 123])` produces source
    // `\/foo\/,123` (regex escapes the slashes from `Array.toString()`),
    // which only matches paths containing the literal substring
    // `/foo/,123` — effectively skip under known cwd, but the unknown-
    // cwd branch would still fire fail-closed at the bottom of
    // evaluateCwd. The explicit guard pins uniform fail-skip across
    // known and unknown cwd — same as gitPlugin's null-→-skip path.
    const rule: Rule = {
      name: "mixed-arr",
      tool: "bash",
      command: "rm",
      reason: "mixed arr",
      when: { cwd: [/\/work\//, 123] as unknown as RegExp[] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const known = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work/proj"),
      0,
    );
    assert.equal(
      known,
      undefined,
      "non-Pattern element in array — rule skips (no fail-open)",
    );
  });

  it("object form { pattern: Pattern[]; onUnknown: 'allow' } skips on walker-unknown", async () => {
    const rule: Rule = {
      name: "vault-allow-unknown",
      tool: "bash",
      command: "rm",
      reason: "vault",
      when: {
        cwd: {
          pattern: [/\/Goldmine\//, /\/\.cache\/napkin-distill\//],
          onUnknown: "allow",
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEF" && rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "onUnknown: 'allow' on Pattern[] skips when walker can't resolve cwd",
    );
  });

  it("object form { pattern: Pattern[]; onUnknown: 'block' } fires on walker-unknown (default)", async () => {
    const rule: Rule = {
      name: "vault-block-unknown",
      tool: "bash",
      command: "rm",
      reason: "vault",
      when: {
        cwd: {
          pattern: [/\/Goldmine\//, /\/\.cache\/napkin-distill\//],
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEF" && rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.ok(
      res,
      "default onUnknown: 'block' on Pattern[] fires when walker can't resolve cwd",
    );
  });

  it("object form { pattern: Pattern[] } matches OR-of-patterns under known cwd", async () => {
    const rule: Rule = {
      name: "vault-known",
      tool: "bash",
      command: "rm",
      reason: "vault",
      when: {
        cwd: {
          pattern: [/\/Goldmine\//, /\/\.cache\/napkin-distill\//],
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const hit = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/home/me/.cache/napkin-distill/x"),
      0,
    );
    assert.ok(hit, "second pattern in array matches");
    const miss = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/home/me/code"),
      0,
    );
    assert.equal(miss, undefined, "neither pattern matches — rule skips");
  });

  it("single-pattern shorthand fast-path preserved (behavioral equivalence with single-element array)", async () => {
    // Pin the fast-path's behavioral equivalence with the array form.
    // The engine's evaluateCwd reads the single-pattern shorthand
    // directly without allocating a normalization object; the array
    // path takes a separate branch. Both must produce the same verdict
    // for the same effective input.
    const withArray: Rule = {
      name: "shorthand-array",
      tool: "bash",
      command: "rm",
      reason: "r",
      when: { cwd: [/^\/work\/proj$/] },
    };
    const withSingle: Rule = {
      name: "shorthand-single",
      tool: "bash",
      command: "rm",
      reason: "r",
      when: { cwd: /^\/work\/proj$/ },
    };
    const evalArr = buildEvaluator(
      { rules: [withArray] },
      resolve(),
      makeHost(),
    );
    const evalSingle = buildEvaluator(
      { rules: [withSingle] },
      resolve(),
      makeHost(),
    );
    const arr = await evalArr.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work/proj"),
      0,
    );
    const single = await evalSingle.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work/proj"),
      0,
    );
    assert.ok(arr);
    assert.ok(single);
    assert.equal((arr as { block: boolean }).block, true);
    assert.equal((single as { block: boolean }).block, true);
  });

  it("object form with mixed-type array under known cwd — rule skips (no silent fail-open)", async () => {
    // Without the object-shape early-return, the trailing fallback
    // calls `matchesPattern(obj, walkerCwd)` which compiles
    // `String({pattern: [/work/, 123]})` = `"[object Object]"` into
    // `/[object Object]/`. JS parses that as a single character class
    // matching any of {b, c, e, j, o, t, space, O} — so under known
    // cwd it silently fail-OPENs (matches almost every real path,
    // since most contain a `t` or `o`) and FIRES the rule. Pin
    // uniformly with the array-shorthand fail-skip path so a typo in
    // the object form behaves the same as a typo in the shorthand
    // form.
    const rule: Rule = {
      name: "obj-mixed",
      tool: "bash",
      command: "rm",
      reason: "obj mixed",
      when: {
        cwd: {
          pattern: [/\/work\//, 123] as unknown as RegExp[],
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work/proj"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "object form with mixed-type array — rule skips (no silent throw)",
    );
  });

  it("object form with malformed scalar pattern under known cwd — rule skips (no silent fail-open)", async () => {
    // Same rationale as the mixed-array case: without the object-
    // shape early-return, the trailing fallback compiles
    // `String({pattern: 123})` = `"[object Object]"` into
    // `/[object Object]/` (a character class matching any of
    // {b, c, e, j, o, t, space, O}) and fail-OPENs against almost
    // every real cwd. The object-shape early-return fail-skips
    // uniformly.
    const rule: Rule = {
      name: "obj-bad-scalar",
      tool: "bash",
      command: "rm",
      reason: "obj bad scalar",
      when: {
        cwd: { pattern: 123 as unknown as RegExp },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work/proj"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "object form with malformed scalar — rule skips (no silent fail-open)",
    );
  });

  it("object form with mixed-type array under unknown cwd — rule skips (uniform with shorthand)", async () => {
    // Without the object-shape early-return, the unknown-cwd branch
    // at the bottom of evaluateCwd would fire fail-closed (return
    // `true`) on this malformed object — asymmetric with the
    // shorthand-array malformed path that fail-skips uniformly. Pin
    // the symmetric uniform-fail-skip behavior.
    const rule: Rule = {
      name: "obj-mixed-unknown",
      tool: "bash",
      command: "rm",
      reason: "obj mixed unknown",
      when: {
        cwd: {
          pattern: [/\/work\//, 123] as unknown as RegExp[],
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEF" && rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "object form with mixed-type array under unknown cwd — rule skips uniformly",
    );
  });

  it("empty array under unknown cwd — rule skips (documented asymmetry with malformed scalar)", async () => {
    // Documented asymmetry: empty array is invalid → skips even under
    // unknown cwd (the `length === 0` early-return runs before the
    // unknown-cwd check); malformed scalar (e.g. `cwd: 123`) is
    // treated as fail-closed shorthand attempt → fires under unknown.
    // Pin both fail-modes so a future refactor that collapses the
    // two has to acknowledge it.
    const rule: Rule = {
      name: "empty-arr-unknown",
      tool: "bash",
      command: "rm",
      reason: "empty arr unknown",
      when: { cwd: [] as RegExp[] },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEF" && rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "empty array invalid — rule skips even under unknown cwd",
    );
  });

  it("malformed scalar under unknown cwd — rule fires (asymmetry pin)", async () => {
    // Counterfactual to the empty-array case above. Pinning the
    // pre-extension fail-closed shorthand-attempt behavior so a
    // refactor that wires a uniform fail-skip into the bottom
    // fallback would trip this test.
    const rule: Rule = {
      name: "bad-scalar-unknown",
      tool: "bash",
      command: "rm",
      reason: "bad scalar unknown",
      when: { cwd: 123 as unknown as RegExp },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent('cd "$UNDEF" && rm foo'),
      makeCtx("/start"),
      0,
    );
    assert.ok(
      res,
      "malformed scalar under unknown cwd — rule fires (fail-closed shorthand attempt)",
    );
  });
});

describe("buildEvaluator: when.missing", () => {
  // "Fires while missing." — the rule author's model ("block cr
  // unless sync is present") now matches the engine: no entry of
  // the type in the given scope → predicate matches → rule fires.
  const sessionEntry = (
    customType: string,
    data: Record<string, unknown>,
    ts = "2026-01-01T00:00:00.000Z",
    id = "e1",
  ) => ({
    type: "custom" as const,
    customType,
    data,
    timestamp: ts,
    id,
    parentId: null,
  });

  it("in: 'agent_loop' — fires when no entry for current agent loop", async () => {
    const rule: Rule = {
      name: "cr-needs-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: { missing: { event: "ws-sync-done", in: "agent_loop" } },
    };
    // No entries anywhere → rule fires.
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const fires = await evaluator.evaluate(
      bashEvent("cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(fires);
  });

  it("in: 'agent_loop' — skips when entry's _agentLoopIndex matches ctx", async () => {
    const rule: Rule = {
      name: "cr-needs-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: { missing: { event: "ws-sync-done", in: "agent_loop" } },
    };
    const ctx = makeCtx("/r", [
      sessionEntry("ws-sync-done", { _agentLoopIndex: 5 }),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const skips = await evaluator.evaluate(bashEvent("cr --review"), ctx, 5);
    assert.equal(skips, undefined);
  });

  it("in: 'agent_loop' — fires when only entries from PRIOR agent loops exist", async () => {
    const rule: Rule = {
      name: "cr-needs-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: { missing: { event: "ws-sync-done", in: "agent_loop" } },
    };
    const ctx = makeCtx("/r", [
      sessionEntry("ws-sync-done", { _agentLoopIndex: 3 }, undefined, "a"),
      sessionEntry("ws-sync-done", { _agentLoopIndex: 4 }, undefined, "b"),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const fires = await evaluator.evaluate(bashEvent("cr --review"), ctx, 5);
    assert.ok(fires);
  });

  it("in: 'session' — skips whenever ANY entry of event exists", async () => {
    const rule: Rule = {
      name: "once-per-session",
      tool: "bash",
      command: "cr",
      reason: "once-per-session",
      when: { missing: { event: "welcome-shown", in: "session" } },
    };
    const ctx = makeCtx("/r", [
      sessionEntry("welcome-shown", { _agentLoopIndex: 0 }),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const skips = await evaluator.evaluate(bashEvent("cr --review"), ctx, 99);
    assert.equal(skips, undefined);
  });

  it("in: 'session' — fires when no entry of event exists", async () => {
    const rule: Rule = {
      name: "once-per-session",
      tool: "bash",
      command: "cr",
      reason: "once-per-session",
      when: { missing: { event: "welcome-shown", in: "session" } },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const fires = await evaluator.evaluate(
      bashEvent("cr --review"),
      makeCtx("/r"),
      0,
    );
    assert.ok(fires);
  });

  it("not.missing: inverts — fires when event IS PRESENT in agent loop", async () => {
    const rule: Rule = {
      name: "no-cr-twice",
      tool: "bash",
      command: "cr",
      reason: "no-cr-twice",
      when: {
        not: { missing: { event: "cr-attempted", in: "agent_loop" } },
      },
    };
    // Entry tagged with the current agent loop → missing predicate
    // says NOT-missing=false (so missing did happen) → nested clause
    // is false → not flips to true → rule fires.
    const ctx = makeCtx("/r", [
      sessionEntry("cr-attempted", { _agentLoopIndex: 5 }),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const fires = await evaluator.evaluate(bashEvent("cr --review"), ctx, 5);
    assert.ok(fires);
  });

  it("not.missing: skips — when event is missing in agent loop", async () => {
    const rule: Rule = {
      name: "no-cr-twice",
      tool: "bash",
      command: "cr",
      reason: "no-cr-twice",
      when: {
        not: { missing: { event: "cr-attempted", in: "agent_loop" } },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const skips = await evaluator.evaluate(
      bashEvent("cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(skips, undefined);
  });

  it("treats a predicate throw as 'rule did not fire' and logs a warning (S1)", async () => {
    const rule: Rule = {
      name: "bad",
      tool: "bash",
      command: "cr",
      reason: "bad",
      // @ts-expect-error — deliberately malformed for runtime check
      when: { missing: "not-an-object" },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const result = await evaluator.evaluate(
        bashEvent("cr"),
        makeCtx("/r"),
        0,
      );
      // Rule does NOT fire — a throwing predicate is isolated from the
      // rest of the rule list (S1). No block verdict returned.
      assert.equal(result, undefined);
      // Warning names the rule + source tag and contains the original
      // error message (so operators can locate + fix the bug).
      assert.ok(
        warnings.some((w) =>
          /predicate threw for rule "bad"@user.*when\.missing expected/.test(w),
        ),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it('treats legacy "turn" scope as an unknown-scope typo (S1)', async () => {
    // "turn" was the removed PoC scope name. v0.1.0 has no special-case
    // hint for it — it falls through to the generic "unknown scope"
    // error, same as any other typo.
    const rule: Rule = {
      name: "legacy-turn",
      tool: "bash",
      command: "cr",
      reason: "legacy",
      // @ts-expect-error — "turn" is the removed PoC scope name
      when: { missing: { event: "ws-sync-done", in: "turn" } },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const result = await evaluator.evaluate(
        bashEvent("cr"),
        makeCtx("/r"),
        0,
      );
      assert.equal(result, undefined);
      assert.ok(
        warnings.some((w) =>
          /predicate threw for rule "legacy-turn"@user.*when\.missing\.in must be.*"agent_loop", "session", or "tool_call"/.test(
            w,
          ),
        ),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it('isolates a typo-scope throw like "agentLoop" (camelCase, S1)', async () => {
    const rule: Rule = {
      name: "typo",
      tool: "bash",
      command: "cr",
      reason: "typo",
      // @ts-expect-error — camelCase is not a valid scope
      when: { missing: { event: "ws-sync-done", in: "agentLoop" } },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const result = await evaluator.evaluate(
        bashEvent("cr"),
        makeCtx("/r"),
        0,
      );
      assert.equal(result, undefined);
      assert.ok(
        warnings.some((w) =>
          /predicate threw for rule "typo"@user.*when\.missing\.in must be.*"agent_loop", "session", or "tool_call"/.test(
            w,
          ),
        ),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it("untagged entries are treated as 'missing from this loop' (G5)", async () => {
    // Simulates a pre-feature entry (hand-written session JSONL,
    // or a plugin that bypassed the wrapper): `data` has no
    // `_agentLoopIndex` key. The agent_loop filter must NOT treat
    // undefined as a match, so the rule's `when.missing` predicate
    // still fires (rule blocks).
    const rule: Rule = {
      name: "cr-needs-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: { missing: { event: "legacy", in: "agent_loop" } },
    };
    const ctx = makeCtx("/r", [
      sessionEntry("legacy", { foo: "bar" }), // no _agentLoopIndex
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
    assert.ok(
      res && res.block === true,
      "untagged entries must not satisfy agent_loop scope",
    );
  });
});
describe("buildEvaluator: when.missing.since (temporal ordering)", () => {
  // `since` acts as an invalidation sentinel. Rule fires when the
  // most-recent `event` entry in scope is NOT strictly newer than
  // the most-recent `since` entry in scope. Absent / never-written
  // `since` degrades to simple-presence semantics.
  const sessionEntry = (
    customType: string,
    data: Record<string, unknown>,
    ts: string,
    id: string,
  ) => ({
    type: "custom" as const,
    customType,
    data,
    timestamp: ts,
    id,
    parentId: null,
  });

  it("same loop, event after since → present (rule does NOT fire)", async () => {
    const rule: Rule = {
      name: "needs-fresh-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: {
        missing: {
          event: "ws-sync-done",
          in: "agent_loop",
          since: "upstream-failed",
        },
      },
    };
    const ctx = makeCtx("/r", [
      sessionEntry(
        "upstream-failed",
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:00.000Z",
        "a",
      ),
      sessionEntry(
        "ws-sync-done",
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:10.000Z",
        "b",
      ),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
    assert.equal(res, undefined, "rule must skip when event is fresh");
  });

  it("same loop, since after event → stale (rule fires)", async () => {
    const rule: Rule = {
      name: "needs-fresh-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: {
        missing: {
          event: "ws-sync-done",
          in: "agent_loop",
          since: "upstream-failed",
        },
      },
    };
    const ctx = makeCtx("/r", [
      sessionEntry(
        "ws-sync-done",
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:00.000Z",
        "a",
      ),
      sessionEntry(
        "upstream-failed",
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:10.000Z",
        "b",
      ),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
    assert.ok(res && res.block === true, "rule must fire when event is stale");
  });

  it("event present, since never written → present (rule does NOT fire)", async () => {
    const rule: Rule = {
      name: "needs-fresh-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: {
        missing: {
          event: "ws-sync-done",
          in: "agent_loop",
          since: "upstream-failed",
        },
      },
    };
    const ctx = makeCtx("/r", [
      sessionEntry(
        "ws-sync-done",
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:00.000Z",
        "a",
      ),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
    assert.equal(
      res,
      undefined,
      "never-written since degrades to simple-presence",
    );
  });

  it("neither event nor since written → rule fires", async () => {
    const rule: Rule = {
      name: "needs-fresh-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: {
        missing: {
          event: "ws-sync-done",
          in: "agent_loop",
          since: "upstream-failed",
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("cr review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "no event at all must fire regardless of since",
    );
  });

  it("only since written → event absent, rule fires", async () => {
    const rule: Rule = {
      name: "needs-fresh-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: {
        missing: {
          event: "ws-sync-done",
          in: "agent_loop",
          since: "upstream-failed",
        },
      },
    };
    const ctx = makeCtx("/r", [
      sessionEntry(
        "upstream-failed",
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:00.000Z",
        "a",
      ),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
    assert.ok(
      res && res.block === true,
      "no event means missing=true regardless of since",
    );
  });

  it("cross-loop: since in prior loop, event in current loop (agent_loop scope)", async () => {
    // The `since` entry from loop 4 is OUT of current-loop scope, so
    // the agent_loop filter drops it. From loop-5's perspective
    // `since` is "never written" → simple-presence semantics.
    const rule: Rule = {
      name: "needs-fresh-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: {
        missing: {
          event: "ws-sync-done",
          in: "agent_loop",
          since: "upstream-failed",
        },
      },
    };
    const ctx = makeCtx("/r", [
      sessionEntry(
        "upstream-failed",
        { _agentLoopIndex: 4 },
        "2026-01-01T00:00:05.000Z",
        "a",
      ),
      sessionEntry(
        "ws-sync-done",
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:00.000Z",
        "b",
      ),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
    assert.equal(
      res,
      undefined,
      "prior-loop since must not invalidate current-loop event",
    );
  });

  it("in: 'session' scope with since compares across whole session", async () => {
    const rule: Rule = {
      name: "needs-fresh-welcome",
      tool: "bash",
      command: "cr",
      reason: "welcome",
      when: {
        missing: {
          event: "welcome-shown",
          in: "session",
          since: "policy-updated",
        },
      },
    };
    // policy-updated after welcome-shown → stale, rule fires.
    const ctx = makeCtx("/r", [
      sessionEntry("welcome-shown", {}, "2026-01-01T00:00:00.000Z", "a"),
      sessionEntry("policy-updated", {}, "2026-01-01T00:01:00.000Z", "b"),
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 99);
    assert.ok(
      res && res.block === true,
      "session-scope since must fire on stale event",
    );
  });

  it("runtime error on non-string since value", async () => {
    const rule: Rule = {
      name: "bad-since",
      tool: "bash",
      command: "cr",
      reason: "bad",
      when: {
        missing: {
          event: "ws-sync-done",
          in: "agent_loop",
          // @ts-expect-error — deliberate runtime type violation.
          since: 42,
        },
      },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const res = await evaluator.evaluate(
        bashEvent("cr review"),
        makeCtx("/r"),
        5,
      );
      // Predicate throw is isolated (S1) — no block verdict.
      assert.equal(res, undefined);
      assert.ok(
        warnings.some((w) => /when\.missing\.since must be a string/.test(w)),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });
});

describe("buildEvaluator: `&&`-chain speculative allow via when.missing", () => {
  // When the current bash tool_call contains a prior `&&`-chained ref
  // that matches an observer writing the required event, the engine
  // speculatively treats the event as "about to happen" and declines
  // to fire the rule. Safe because `&&` short-circuits: if the prior
  // command fails, the current one never runs, so the speculative
  // decision is moot.
  const SYNC_DONE_EVENT = "chain-sync-done" as const;

  const syncObserver: Observer = {
    name: "chain-sync-tracker",
    writes: [SYNC_DONE_EVENT],
    watch: {
      toolName: "bash",
      inputMatches: { command: /^sync\b/ },
      exitCode: "success",
    },
    onResult: () => {
      /* unused in evaluator tests — the reverse-index only reads metadata */
    },
  };

  const crNeedsSync: Rule = {
    name: "cr-needs-sync",
    tool: "bash",
    command: "cr",
    reason: "sync first",
    when: { missing: { event: SYNC_DONE_EVENT, in: "agent_loop" } },
  };

  it("allows `sync && cr` — prior && ref matches the sync observer", async () => {
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "speculative allow should skip the rule on sync && cr",
    );
  });

  it("blocks `cr && sync` — cr is first, no prior && match", async () => {
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("cr --review && sync"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "cr has no prior && ref matching sync — rule must fire",
    );
  });

  it("blocks `sync ; cr` — `;` does NOT qualify as prior-&&", async () => {
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync ; cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "semicolon does not short-circuit — speculative allow unsafe",
    );
  });

  it("blocks `sync || cr` — `||` means cr runs on sync failure", async () => {
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync || cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "|| means cr runs on sync failure — speculative allow unsafe",
    );
  });

  it("allows `(sync) && cr` — subshell + && commits the chain", async () => {
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("(sync) && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "subshell exit with && should still count as prior-&&",
    );
  });

  it("allows `echo foo && sync && cr` — full && chain", async () => {
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("echo foo && sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "sync is a prior && ref of cr via transitive chain",
    );
  });

  it("no observers writing event → no speculative allow", async () => {
    // Reverse index is empty (no observers registered), so the rule
    // fires even though `sync` runs first — no way to know sync
    // writes SYNC_DONE_EVENT without the observer's `writes:` link.
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "with no observers, fall back to simple missing check",
    );
  });

  it("observer without inputMatches.command → no speculative allow", async () => {
    // An observer that would fire on any bash tool_result isn't a
    // strong enough signal for speculative allow: we can't tell
    // whether the prior ref would actually make the observer fire.
    const looseObserver: Observer = {
      name: "loose-observer",
      writes: [SYNC_DONE_EVENT],
      watch: { toolName: "bash" },
      onResult: () => {},
    };
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [looseObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "observers with no command pattern must not trigger speculative allow",
    );
  });

  it("multiple observers writing same event — any command match triggers allow", async () => {
    const obsA: Observer = {
      name: "obs-a",
      writes: [SYNC_DONE_EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^never-match\b/ },
      },
      onResult: () => {},
    };
    const obsB: Observer = {
      name: "obs-b",
      writes: [SYNC_DONE_EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
      },
      onResult: () => {},
    };
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [obsA, obsB] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(res, undefined, "obs-b's command pattern matches — allow");
  });

  it("plugin observer (not inline) also feeds the reverse index", async () => {
    const pluginWithObs: Plugin = {
      name: "chain-plugin",
      observers: [syncObserver],
    };
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync] },
      resolve([pluginWithObs]),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "plugin-shipped observers should populate the reverse index too",
    );
  });

  it("combines with since — speculative allow also applies when event is stale", async () => {
    // Event previously present but since-sentinel made it stale.
    // Prior && ref matches → the new sync is "about to happen" and
    // freshens the state. Speculative allow, rule skips.
    const ruleWithSince: Rule = {
      name: "cr-needs-fresh-sync",
      tool: "bash",
      command: "cr",
      reason: "sync first",
      when: {
        missing: {
          event: SYNC_DONE_EVENT,
          in: "agent_loop",
          since: "upstream-failed",
        },
      },
    };
    const makeStaleCtx = () =>
      makeCtx("/r", [
        {
          type: "custom" as const,
          customType: SYNC_DONE_EVENT,
          data: { _agentLoopIndex: 5 },
          timestamp: "2026-01-01T00:00:00.000Z",
          id: "a",
          parentId: null,
        },
        {
          type: "custom" as const,
          customType: "upstream-failed",
          data: { _agentLoopIndex: 5 },
          timestamp: "2026-01-01T00:00:10.000Z",
          id: "b",
          parentId: null,
        },
      ]);
    const evaluator = buildEvaluator(
      { rules: [ruleWithSince], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeStaleCtx(),
      5,
    );
    assert.equal(
      res,
      undefined,
      "stale event + prior && sync ref → speculative allow",
    );
  });

  // ---- Chain reachability (|| and | must not bleed into && prior sets) ----

  it("blocks `lint || sync && cr` — `||` short-circuits sync out of cr's prior", async () => {
    // Bash parses as `(lint || sync) && cr`. When `lint` succeeds, `sync`
    // is SKIPPED but the compound `(lint || sync)` is true, so `cr`
    // still runs — without sync ever running. Speculative allow via
    // sync would be unsafe here, because sync is not guaranteed to
    // have run before cr.
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("lint || sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "`||` before a prior-&& ref breaks reachability — cr must still block",
    );
  });

  it("allows `cd /r ; sync && cr` — `;` restores reachability on a new statement", async () => {
    // After a `;` statement boundary, the next ref runs unconditionally
    // again. From there `sync && cr` is a continuous `&&` chain
    // starting on an unconditionally-reached ref, so speculative allow
    // of `cr` via `sync` is safe.
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("cd /r ; sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "`;` restores reachability; the sync && cr segment grants speculative allow",
    );
  });

  // ---- Observer watch compatibility (toolName + exitCode) ----

  it("does not speculative-allow when observer requires exitCode: 'failure'", async () => {
    // `&&` only advances on success, so an observer gated on failure
    // can never fire from a prior-&& ref. Treating its `writes` as
    // speculatively-happening would be wrong (the event will never be
    // written from this path).
    const failObserver: Observer = {
      name: "fail-gated-sync",
      writes: [SYNC_DONE_EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
        exitCode: "failure",
      },
      onResult: () => {},
    };
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [failObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "observer gated on failure cannot fire via && short-circuit; no speculative allow",
    );
  });

  it("does not speculative-allow when observer's toolName is non-bash", async () => {
    // Prior `&&` refs always originate from bash tool_calls. An
    // observer scoped to a non-bash tool can never fire on one, so
    // its declared writes are never produced on this code path.
    const readObserver: Observer = {
      name: "read-scoped-sync",
      writes: [SYNC_DONE_EVENT],
      watch: {
        toolName: "read",
        inputMatches: { command: /^sync\b/ },
      },
      onResult: () => {},
    };
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [readObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "read-scoped observer can't fire on bash refs; no speculative allow",
    );
  });

  // ---- Observer dedup (user wins, matches dispatcher) ----

  it("user observer shadows plugin observer of the same name in speculative allow", async () => {
    // Plugin ships an observer `chain-sync-tracker` with a LOOSE watch
    // (`/^sync\b/`) that would match `sync`. User declares their own
    // observer of the same name with a TIGHT watch (`/^sync --lock\b/`)
    // that does NOT match bare `sync`. The dispatcher fires only the
    // user's observer (dedup-by-name, user wins); speculative-synthesis reverse-
    // index must apply the same semantics or it will grant on a
    // pattern that never actually produces the event.
    const userTightObserver: Observer = {
      name: "chain-sync-tracker",
      writes: [SYNC_DONE_EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync --lock\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const pluginWithLooseObs: Plugin = {
      name: "chain-plugin",
      observers: [syncObserver], // loose `/^sync\b/`
    };
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [userTightObserver] },
      resolve([pluginWithLooseObs]),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "user observer's tighter watch wins; bare `sync` no longer matches",
    );
  });

  // ---- Subshell coverage: multi-ref + conservative under-allow pins ----

  it("allows `(echo hi && sync) && cr` — multi-ref subshell inherits the outer && chain", async () => {
    // GAP-01 regression fence. The walker flattens the subshell into
    // a linear ref list with `echo.joiner='&&', sync.joiner='&&',
    // cr.joiner=undefined`. Under the chain reachability rule, sync is
    // unconditionally reached via echo's `&&` and contributes to cr's
    // prior set. Speculative allow fires via the sync observer.
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [syncObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("(echo hi && sync) && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "multi-ref subshell: both refs inside the `(...)` participate in cr's prior chain; sync matches observer",
    );
  });

  it("conservative-under: `foo && (bar ; sync) && cr` — only sync in prior, foo is dropped at `;`", async () => {
    // `&&` joiner flattening visibility. The walker flattens to
    // `foo.joiner='&&', bar.joiner=';', sync.joiner='&&',
    // cr.joiner=undefined`. The `;` inside the subshell clears the
    // prior chain, so cr's prior set is `[sync]` only — NOT
    // `[foo, sync]`. This is the intentional conservative-under trade-
    // off of the chain-reachability walk in
    // `evaluator-internals/speculative-synthesis.ts`; pin it so a
    // future walker change that treats the outer `&&` as bridging
    // across the `;` doesn't silently flip to an over-allow.
    //
    // We prove it with an observer that matches ONLY `foo` (not sync).
    // If foo were in cr's prior chain the rule would wrongly
    // speculative-allow; because the `;` cleared it, the rule must
    // still fire.
    const fooObserver: Observer = {
      name: "foo-only",
      writes: [SYNC_DONE_EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^foo\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const evaluator = buildEvaluator(
      { rules: [crNeedsSync], observers: [fooObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("foo && (bar ; sync) && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "conservative-under: cr's prior is [sync] after `;`; fooObserver can't allow",
    );
  });

  // ---- Pinned correctness case: two-speculative-writes + since ----

  it("blocks `A && B && cr` when A writes X and B writes Y (X since Y)", async () => {
    // Walker-producer unification correctness case. Pre-unification,
    // speculative-allow was a boolean "any prior && ref matches an
    // observer writing the event" — it ignored cross-type invalidators
    // written by OTHER prior && refs. So `A && B && cr` with X-writer A
    // and Y-writer B (Y being X's since-invalidator) incorrectly
    // speculative-allowed: A's write of X counted even though B's later
    // write of Y would stale it.
    //
    // Post-unification, speculative entries carry AST-ordered timestamps
    // (baseline + 1 + index), so the synthetic X at ts=baseline+1 is
    // older than synthetic Y at ts=baseline+2. `when.missing: { event:
    // X, since: Y }` correctly reads X as stale and fires the rule.
    const EVENT_X = "chain-two-writes-x" as const;
    const EVENT_Y = "chain-two-writes-y" as const;
    const aObserver: Observer = {
      name: "a-writer",
      writes: [EVENT_X],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^alpha\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const bObserver: Observer = {
      name: "b-writer",
      writes: [EVENT_Y],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^bravo\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const rule: Rule = {
      name: "cr-since-y-blocks",
      tool: "bash",
      command: "cr",
      reason: "X is stale (Y written after)",
      when: {
        missing: {
          event: EVENT_X,
          in: "agent_loop",
          since: EVENT_Y,
        },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [rule], observers: [aObserver, bObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("alpha && bravo && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "unification: synthetic X older than synthetic Y → X is stale → rule fires",
    );
  });

  it("allows `A && B && cr` when the since-type matches NEITHER prior ref's observer", async () => {
    // Regression guard for the inverse scenario. If only X's observer
    // is registered (no one writes Y), A's write of X makes the event
    // fresh AND the invalidator is absent in scope — missing degrades
    // to simple-presence semantics, rule does NOT fire. Confirms the
    // unification still grants allow when there's no cross-type
    // invalidator in play.
    const EVENT_X = "chain-only-x" as const;
    const EVENT_Y_ABSENT = "chain-only-x-since-absent" as const;
    const aObserver: Observer = {
      name: "a-writer-only",
      writes: [EVENT_X],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^alpha\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const rule: Rule = {
      name: "cr-since-absent-allows",
      tool: "bash",
      command: "cr",
      reason: "X is stale (Y written after)",
      when: {
        missing: {
          event: EVENT_X,
          in: "agent_loop",
          since: EVENT_Y_ABSENT,
        },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [rule], observers: [aObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("alpha && bravo && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "synthetic X present + Y absent → simple-presence → rule does NOT fire",
    );
  });

  it("allows `B && A && cr` (AST-reversed): X newer than Y does NOT fire", async () => {
    // Mirror of the blocks-case above. Same observers, same rule, but
    // the command chain is AST-REVERSED: Y-writer first, X-writer second.
    // Synthetic Y at ts=baseline+1, synthetic X at ts=baseline+2 → X is
    // AST-newer than Y → `missing: { event: X, since: Y }` reads X as
    // FRESH (written after the since-invalidator) → rule does NOT fire.
    //
    // This case is the integration-layer guard for the strict-ordering
    // property of speculative timestamps. Under a mutation that ties all
    // speculative timestamps (e.g., every speculative at baseline+1),
    // `eventLatest <= sinceLatest` would flip to true (tie case), the
    // rule would incorrectly fire, and this test would fail. The paired
    // blocks-case above passes under that mutation because a tie still
    // satisfies `<=` → the fix is guarded on both sides only when this
    // test is present.
    const EVENT_X = "chain-reversed-x" as const;
    const EVENT_Y = "chain-reversed-y" as const;
    const aObserver: Observer = {
      name: "a-writer-reversed",
      writes: [EVENT_X],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^alpha\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const bObserver: Observer = {
      name: "b-writer-reversed",
      writes: [EVENT_Y],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^bravo\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const rule: Rule = {
      name: "cr-since-y-allows-reversed",
      tool: "bash",
      command: "cr",
      reason: "X is stale (Y written after)",
      when: {
        missing: {
          event: EVENT_X,
          in: "agent_loop",
          since: EVENT_Y,
        },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [rule], observers: [aObserver, bObserver] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("bravo && alpha && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "AST-reversed: synthetic X newer than synthetic Y → X is fresh → rule does NOT fire",
    );
  });
});

describe("buildEvaluator: when.missing with in='tool_call'", () => {
  // `tool_call` scope narrows `missing` to the speculative-only
  // timeline: real (session-persisted) entries are ignored entirely.
  // Fires when the speculative event is absent from THIS tool_call's
  // `&&`-chain; does NOT fire when a prior chained ref writes the
  // event. Use for "must be chained directly before" semantics, vs
  // `agent_loop`'s "must have missing anywhere this loop".

  it("event in chain: `sync && cr` — synthetic write satisfies tool_call presence", async () => {
    const EVENT = "chain-only-sync" as const;
    const observer: Observer = {
      name: "sync-writer",
      writes: [EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const rule: Rule = {
      name: "cr-needs-chained-sync",
      tool: "bash",
      command: "cr",
      reason: "sync must be chained directly before cr",
      when: {
        missing: { event: EVENT, in: "tool_call" },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [rule], observers: [observer] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("sync && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "speculative sync in chain → tool_call missing → rule does NOT fire",
    );
  });

  it("event absent from chain: bare `cr` — no speculative write → rule fires", async () => {
    const EVENT = "chain-only-sync" as const;
    const observer: Observer = {
      name: "sync-writer",
      writes: [EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const rule: Rule = {
      name: "cr-needs-chained-sync",
      tool: "bash",
      command: "cr",
      reason: "sync must be chained directly before cr",
      when: {
        missing: { event: EVENT, in: "tool_call" },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [rule], observers: [observer] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "bare cr, no sync in chain → tool_call presence check fails → rule fires",
    );
  });

  it("ignores real entries: `sync` ran in prior tool_call, now bare `cr` — rule still fires", async () => {
    // The defining characteristic of tool_call vs agent_loop:
    // real (persisted) entries from PRIOR tool_calls are ignored.
    // With in: "agent_loop" the same fixture would NOT fire because
    // sync already missing this loop. With in: "tool_call", only
    // speculative entries in the CURRENT chain count.
    const EVENT = "chain-only-sync" as const;
    const observer: Observer = {
      name: "sync-writer",
      writes: [EVENT],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const rule: Rule = {
      name: "cr-needs-chained-sync",
      tool: "bash",
      command: "cr",
      reason: "sync must be chained directly before cr",
      when: {
        missing: { event: EVENT, in: "tool_call" },
      },
    };
    const host = makeHost();
    const evaluator = buildEvaluator(
      { rules: [rule], observers: [observer] },
      resolve(),
      host,
    );
    // Pre-seed a real entry simulating a prior successful sync in
    // this agent loop (what agent_loop scope would satisfy).
    host.appendEntry(EVENT, { _agentLoopIndex: 0, priorRun: true });
    const res = await evaluator.evaluate(
      bashEvent("cr --review"),
      makeCtx("/r"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "real prior-tool_call sync entry is ignored under in='tool_call' → rule fires",
    );
  });

  it("tool_call + since: in-chain invalidator stales the in-chain event", async () => {
    // `alpha && bravo && cr` where alpha writes X and bravo writes Y.
    // Y is the since-invalidator for X. Under tool_call scope, both
    // X and Y are speculative-only; AST ordering gives X.ts < Y.ts
    // → X is stale → rule fires.
    const EVENT_X = "tc-since-x" as const;
    const EVENT_Y = "tc-since-y" as const;
    const aObs: Observer = {
      name: "a-writer",
      writes: [EVENT_X],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^alpha\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const bObs: Observer = {
      name: "b-writer",
      writes: [EVENT_Y],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^bravo\b/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    const rule: Rule = {
      name: "cr-x-since-y-tc",
      tool: "bash",
      command: "cr",
      reason: "X stale (Y written after)",
      when: {
        missing: { event: EVENT_X, in: "tool_call", since: EVENT_Y },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [rule], observers: [aObs, bObs] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("alpha && bravo && cr --review"),
      makeCtx("/r"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "speculative X older than speculative Y → tool_call: X is stale → rule fires",
    );
  });
});

describe("buildEvaluator: when.not + when.condition", () => {
  it("when.not inverts the nested clause", async () => {
    const rule: Rule = {
      name: "push-outside-mainline",
      tool: "bash",
      command: "git",
      reason: "push outside mainline",
      when: { not: { cwd: "/mainline/" } },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const inMainline = await evaluator.evaluate(
      bashEvent("cd /mainline/x && git push"),
      makeCtx("/repo"),
      0,
    );
    const outside = await evaluator.evaluate(
      bashEvent("cd /feature/x && git push"),
      makeCtx("/repo"),
      0,
    );
    // Inside mainline → inner match → not fails → rule skipped.
    assert.equal(inMainline, undefined);
    // Outside mainline → inner fails → not matches → rule fires.
    assert.ok(outside);
  });

  it("when.condition calls the PredicateFn with ctx", async () => {
    let seenCwd: string | null = null;
    const rule: Rule = {
      name: "cond-rule",
      tool: "bash",
      command: "git",
      reason: "cond",
      when: {
        condition: (ctx) => {
          seenCwd = ctx.cwd;
          return ctx.cwd.includes("/feature/");
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const fires = await evaluator.evaluate(
      bashEvent("cd /feature/x && git push"),
      makeCtx("/home"),
      0,
    );
    assert.ok(fires);
    assert.equal(seenCwd, "/feature/x");

    const skips = await evaluator.evaluate(
      bashEvent("cd /trunk/x && git push"),
      makeCtx("/home"),
      0,
    );
    assert.equal(skips, undefined);
  });
});

// ---------------------------------------------------------------------------
// when multi-key (AND semantics + short-circuit) and when.not multi-key
// ---------------------------------------------------------------------------
//
// The existing when.* tests exercise a single key per clause. These
// pin the two multi-key behaviours {@link evaluateWhen} implements:
// AND semantics across keys at the SAME level (cwd AND condition),
// and nested AND inversion through `not` (NOT of the inner AND).

describe("buildEvaluator: when multi-key AND + short-circuit", () => {
  it("when with multiple keys requires ALL to pass (AND) and short-circuits", async () => {
    let conditionCalls = 0;
    const rule: Rule = {
      name: "multi-key",
      tool: "bash",
      command: "git",
      reason: "multi-key",
      // `cwd` key is declared first: Object.entries iterates in
      // insertion order, so cwd is evaluated before condition. This
      // property is what lets the evaluator short-circuit: when cwd
      // misses, the condition fn is never called.
      when: {
        cwd: "^/feature/",
        condition: () => {
          conditionCalls++;
          return conditionCalls === 1;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

    // (a) cwd matches + condition returns true (first call) → fires.
    const firesA = await evaluator.evaluate(
      bashEvent("cd /feature/x && git push"),
      makeCtx("/home"),
      0,
    );
    assert.ok(firesA, "(a) both true → AND passes → rule fires");
    assert.equal(conditionCalls, 1);

    // (b) cwd matches + condition returns false (second call) → skipped.
    const skipsB = await evaluator.evaluate(
      bashEvent("cd /feature/y && git push"),
      makeCtx("/home"),
      0,
    );
    assert.equal(skipsB, undefined, "(b) cond false → AND fails → skipped");
    assert.equal(conditionCalls, 2);

    // (c) cwd doesn't match → evaluator short-circuits BEFORE the
    // condition fn is called; the counter stays at 2.
    const skipsC = await evaluator.evaluate(
      bashEvent("cd /trunk/x && git push"),
      makeCtx("/home"),
      0,
    );
    assert.equal(skipsC, undefined, "(c) cwd miss → AND fails → rule skipped");
    assert.equal(
      conditionCalls,
      2,
      "(c) short-circuit must NOT invoke condition when cwd already failed",
    );
  });

  it("when.not inverts the nested clause: NOT (cwd AND condition)", async () => {
    // Four-cell truth table for NOT (cwd AND condition):
    //   cwd | cond | inner AND | NOT → rule fires?
    //    F  |  F   |    F      |  T  → fires
    //    F  |  T   |    F      |  T  → fires
    //    T  |  F   |    F      |  T  → fires
    //    T  |  T   |    T      |  F  → SKIPPED
    // Only the (T, T) cell should skip; the other three fire.
    let flag = false;
    const rule: Rule = {
      name: "not-multi-key",
      tool: "bash",
      command: "git",
      reason: "not-multi-key",
      when: {
        not: {
          cwd: "^/main$",
          condition: () => flag,
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

    async function run(cwdPath: string, f: boolean) {
      flag = f;
      return evaluator.evaluate(
        bashEvent(`cd ${cwdPath} && git push`),
        makeCtx("/home"),
        0,
      );
    }

    // (F, F): cwd mismatch + flag false.
    assert.ok(await run("/other", false), "(F,F) → NOT(F)=T → fires");
    // (F, T): cwd mismatch + flag true.
    assert.ok(await run("/other", true), "(F,T) → NOT(F)=T → fires");
    // (T, F): cwd match + flag false.
    assert.ok(await run("/main", false), "(T,F) → NOT(F)=T → fires");
    // (T, T): cwd match + flag true → inner AND is true → NOT flips to
    // false → rule skipped.
    assert.equal(
      await run("/main", true),
      undefined,
      "(T,T) → NOT(T)=F → rule skipped",
    );
  });
});

// ---------------------------------------------------------------------------
// not-block onUnknown semantics: trinary leaf composition + corrected
// evaluateNot pseudocode + leaf adapter contract.
// ---------------------------------------------------------------------------
//
// These tests pin the engine's behavior when a `not:` block contains
// leaves that surface trinary `"unknown"` (built-in `cwd` on a
// walker-unknown sentinel, or a plugin handler returning `"unknown"`).
// The corrected pseudocode composes leaves with Kleene 3-valued AND,
// then applies the block-level `onUnknown:` policy on the unknown-leaf
// case BEFORE the not-flip. The flip is skipped on unknown so authors
// who write `onUnknown: "block"` directly mean "rule fires" without
// having to write the double-inversion `"allow"` workaround.

describe("buildEvaluator: not-block trinary + Kleene AND composition", () => {
  // Helper: a plugin that registers two trinary predicates whose
  // verdicts we control per call.
  function trinaryPlugin(
    flagA: () => boolean | "unknown",
    flagB: () => boolean | "unknown",
  ): Plugin {
    return {
      name: "trinary-test",
      predicates: {
        triA: () => flagA(),
        triB: () => flagB(),
      },
    };
  }

  function makeRule(when: NonNullable<Rule["when"]>, name: string = "r"): Rule {
    return {
      name,
      tool: "bash",
      command: "git",
      reason: name,
      when,
    };
  }

  function buildWith(
    when: NonNullable<Rule["when"]>,
    plugin: Plugin,
    name: string = "r",
  ) {
    return buildEvaluator(
      { rules: [makeRule(when, name)] },
      resolve([plugin]),
      makeHost(),
    );
  }

  it("Kleene AND: all-true leaves → not(true) = false (rule skips)", async () => {
    const plugin = trinaryPlugin(
      () => true,
      () => true,
    );
    const ev = buildWith(
      { not: { triA: "x", triB: "y" } } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.equal(
      r,
      undefined,
      "all-true → inner AND = true → not(true) = false → rule does not fire",
    );
  });

  it("Kleene AND: any-false leaf absorbs → not(false) = true (rule fires)", async () => {
    const plugin = trinaryPlugin(
      () => true,
      () => false,
    );
    const ev = buildWith(
      { not: { triA: "x", triB: "y" } } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "any-false → false absorbs in Kleene AND → not(false) = true → rule fires",
    );
  });

  it("Kleene AND: all-false leaves → not(false) = true (rule fires)", async () => {
    const plugin = trinaryPlugin(
      () => false,
      () => false,
    );
    const ev = buildWith(
      { not: { triA: "x", triB: "y" } } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(r && r.block === true, "all-false → not(false) = true");
  });

  it("Kleene AND: mixed known true + false → false absorbs (rule fires)", async () => {
    const plugin = trinaryPlugin(
      () => true,
      () => false,
    );
    const ev = buildWith(
      { not: { triA: "x", triB: "y" } } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(r && r.block === true, "true & false = false in Kleene AND");
  });

  it("Kleene AND: known true + unknown → unknown → block-level onUnknown:'block' fires (default)", async () => {
    const plugin = trinaryPlugin(
      () => true,
      () => "unknown",
    );
    // No explicit onUnknown: — defaults to "block" (fail-CLOSED).
    const ev = buildWith(
      { not: { triA: "x", triB: "y" } } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "true & unknown = unknown → default block-level 'block' → rule fires (no flip)",
    );
  });

  it("Kleene AND: known true + unknown → unknown → block-level onUnknown:'allow' skips", async () => {
    const plugin = trinaryPlugin(
      () => true,
      () => "unknown",
    );
    const ev = buildWith(
      {
        not: { triA: "x", triB: "y", onUnknown: "allow" },
      } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.equal(
      r,
      undefined,
      "unknown → explicit block-level 'allow' → not-clause = false → rule skips",
    );
  });

  it("Kleene AND: all-unknown leaves → unknown → default 'block' fires fail-CLOSED", async () => {
    const plugin = trinaryPlugin(
      () => "unknown",
      () => "unknown",
    );
    const ev = buildWith(
      { not: { triA: "x", triB: "y" } } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "all-unknown → default 'block' fires the rule (no double-inversion required)",
    );
  });

  it("Kleene AND: all-unknown leaves → unknown → explicit 'allow' skips fail-OPEN", async () => {
    const plugin = trinaryPlugin(
      () => "unknown",
      () => "unknown",
    );
    const ev = buildWith(
      {
        not: { triA: "x", triB: "y", onUnknown: "allow" },
      } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.equal(
      r,
      undefined,
      "all-unknown → explicit 'allow' skips the rule (opt-in fail-OPEN)",
    );
  });

  it("Kleene AND: false absorbs unknown (any-false short-circuits the not-flip directly)", async () => {
    const plugin = trinaryPlugin(
      () => false,
      () => "unknown",
    );
    const ev = buildWith(
      {
        not: { triA: "x", triB: "y", onUnknown: "allow" },
      } as unknown as NonNullable<Rule["when"]>,
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    // Even with onUnknown: "allow", the false leaf absorbs in Kleene
    // AND → combined = false → not(false) = true → rule fires. The
    // onUnknown: "allow" only applies on the unknown branch, not the
    // false-absorbs branch.
    assert.ok(
      r && r.block === true,
      "false absorbs in Kleene AND; onUnknown: 'allow' is irrelevant when the combined verdict is definite false",
    );
  });

  it("Kleene AND: all-unknown leaves with default 'block' modifier project to rule-fires (no false to absorb)", async () => {
    // Different code path from the F+U + 'allow' sibling above. With
    // no `false` leaf to absorb, Kleene AND of all-unknown verdicts
    // stays `"unknown"`; the block-level `onUnknown:` policy then
    // projects to a definite verdict. Default `"block"` fires the
    // rule fail-CLOSED. Pins the not-block evaluator's
    // `block.onUnknown` read + Kleene-AND no-false-absorb path,
    // which the F+U cell can't exercise (false absorbs to false
    // BEFORE the modifier is consulted).
    const plugin = trinaryPlugin(
      () => "unknown",
      () => "unknown",
    );
    const ev = buildWith(
      { not: { triA: "x", triB: "y" } } as unknown as NonNullable<Rule["when"]>, // no onUnknown: → default block
      plugin,
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "all-unknown → Kleene AND yields 'unknown' → default block-level 'block' projects fail-CLOSED → rule fires",
    );
  });

  it("corrected evaluateNot: cwd-only not-block under walker-unknown fires fail-CLOSED (default)", async () => {
    // Closes the silent fail-OPEN class: `not: { cwd: P }` under
    // walker-unknown cwd surfaces unknown via the trinary cwd
    // predicate; default block-level onUnknown: "block" projects
    // directly to rule-fires WITHOUT the not-flip applying to true.
    const rule = makeRule({ not: { cwd: /github/ } }, "no-git-worktree");
    const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const r = await ev.evaluate(
      bashEvent('cd "$VAR" && git push'),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      r && r.block === true,
      "walker-unknown cwd inside not: → default 'block' fires the rule",
    );
  });

  it("corrected evaluateNot: cwd-only not-block under walker-unknown skips with onUnknown:'allow'", async () => {
    const rule = makeRule(
      { not: { cwd: /github/, onUnknown: "allow" } },
      "no-git-worktree-allow",
    );
    const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const r = await ev.evaluate(
      bashEvent('cd "$VAR" && git push'),
      makeCtx("/repo"),
      0,
    );
    assert.equal(
      r,
      undefined,
      "walker-unknown cwd inside not: → explicit 'allow' skips the rule",
    );
  });

  it("corrected evaluateNot: cwd-only not-block on KNOWN cwd matches → not(true) = false", async () => {
    const rule = makeRule({ not: { cwd: /github/ } }, "no-git-worktree");
    const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const r = await ev.evaluate(
      bashEvent("cd /github/repo && git push"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(
      r,
      undefined,
      "known cwd matches /github/ → inner true → not(true) = false → rule skips",
    );
  });

  it("corrected evaluateNot: cwd-only not-block on KNOWN cwd misses → not(false) = true", async () => {
    const rule = makeRule({ not: { cwd: /github/ } }, "no-git-worktree");
    const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const r = await ev.evaluate(
      bashEvent("cd /elsewhere && git push"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      r && r.block === true,
      "known cwd doesn't match /github/ → inner false → not(false) = true → rule fires",
    );
  });

  it("`not: { condition: () => false }`: PredicateFn-false absorbs in Kleene AND → not(false) = true → rule fires", async () => {
    // Pins the condition-leaf path through the not-block evaluator.
    // `condition:` is a built-in non-registry leaf (sits on
    // BuiltInWhenLeaves) but goes through the same Kleene-AND
    // composition + not-flip as registry-driven plugin predicates.
    // A returned `false` absorbs in the AND; the not-flip yields
    // `true` so the rule fires.
    const rule = makeRule(
      { not: { condition: () => false } },
      "not-condition-false-fires",
    );
    const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "condition false absorbs → not(false) = true → rule fires",
    );
  });

  it("`not: { condition: () => { throw } }`: PredicateFn throw → unknown leaf → default block fires", async () => {
    // Pins the condition-throw → unknown-leaf path through the
    // not-block evaluator. A condition that throws produces an
    // `"unknown"` verdict at the leaf; with no leaves to absorb to
    // false, Kleene AND yields `"unknown"` and the block-level
    // `onUnknown:` (default `"block"`) fires the rule fail-CLOSED.
    const rule = makeRule(
      {
        not: {
          condition: () => {
            throw new Error("boom");
          },
        },
      },
      "not-condition-throw-fires",
    );
    const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "condition throw → unknown leaf → default block fires fail-CLOSED",
    );
  });

  it("`not: { condition: () => { throw }, onUnknown: 'allow' }`: PredicateFn throw → unknown leaf → block-level allow skips", async () => {
    // Companion to the default-`"block"` test above. Block-level
    // `onUnknown: "allow"` projects the unknown-leaf case to
    // `false` BEFORE the not-flip applies, so the not-clause
    // contributes `false` → outer when-AND short-circuits → rule
    // SKIPS (fail-OPEN). This is the documented opt-in path for
    // authors who want a throwing condition to NOT fire the rule.
    const rule = makeRule(
      {
        not: {
          condition: () => {
            throw new Error("boom");
          },
          onUnknown: "allow",
        },
      },
      "not-condition-throw-allow-skips",
    );
    const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.equal(
      r,
      undefined,
      "condition throw → unknown leaf → block-level allow projects to false → not-clause skips → rule SKIPS (fail-OPEN)",
    );
  });
});

// ---------------------------------------------------------------------------
// Outer-leaf trinary projection: leaf-level `onUnknown:` modifier on the
// spread form projects unknown → boolean per the leaf adapter.
// ---------------------------------------------------------------------------

describe("buildEvaluator: outer-leaf trinary projection via onUnknown", () => {
  function trinaryPlugin(verdict: () => boolean | "unknown"): Plugin {
    return {
      name: "trinary-leaf",
      predicates: { tri: () => verdict() },
    };
  }

  it("plugin handler returning 'unknown' → default leaf-level 'block' fires the rule", async () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { tri: "x" } as unknown as NonNullable<Rule["when"]>, // bare — no leaf-level onUnknown:
    };
    const ev = buildEvaluator(
      { rules: [rule] },
      resolve([trinaryPlugin(() => "unknown")]),
      makeHost(),
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "bare leaf → default leaf-level 'block' fires the rule",
    );
  });

  it("plugin handler returning 'unknown' → explicit leaf-level 'allow' skips the rule", async () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: {
        tri: { value: "x", onUnknown: "allow" } as any,
      } as unknown as NonNullable<Rule["when"]>,
    };
    const ev = buildEvaluator(
      { rules: [rule] },
      resolve([trinaryPlugin(() => "unknown")]),
      makeHost(),
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.equal(
      r,
      undefined,
      "explicit leaf-level 'allow' projects unknown → false → rule skips",
    );
  });

  it("plugin handler that throws → treated as 'unknown'; default 'block' fires the rule", async () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { tri: "x" } as unknown as NonNullable<Rule["when"]>,
    };
    const ev = buildEvaluator(
      { rules: [rule] },
      resolve([
        trinaryPlugin(() => {
          throw new Error("plugin handler bug");
        }),
      ]),
      makeHost(),
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "throw → unknown → default 'block' projection → rule fires (preserves fail-CLOSED-by-default for buggy plugin handlers)",
    );
  });

  it("plugin handler that throws inside not-block → unknown leaf composes via Kleene → default block-level 'block' fires", async () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { not: { tri: "x" } } as unknown as NonNullable<Rule["when"]>,
    };
    const ev = buildEvaluator(
      { rules: [rule] },
      resolve([
        trinaryPlugin(() => {
          throw new Error("plugin handler bug");
        }),
      ]),
      makeHost(),
    );
    const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
    assert.ok(
      r && r.block === true,
      "throw inside not-block → unknown leaf → Kleene unknown → default block-level 'block' → rule fires",
    );
  });
  it("plugin handler returning null → narrowed to 'unknown' → default 'block' fires", async () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { tri: "x" } as unknown as NonNullable<Rule["when"]>,
    };
    const warnings = captureWarnings();
    try {
      const ev = buildEvaluator(
        { rules: [rule] },
        resolve([trinaryPlugin(() => null as unknown as boolean)]),
        makeHost(),
      );
      const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
      assert.ok(
        r && r.block === true,
        "non-trinary handler return narrows to 'unknown' → default block fires",
      );
      assert.ok(
        warnings.some((w) => w.includes("handler returned")),
        "console.warn surfaces the malformed return",
      );
    } finally {
      warnings.restore();
    }
  });

  it("plugin handler returning undefined → narrowed to 'unknown' → default 'block' fires", async () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { tri: "x" } as unknown as NonNullable<Rule["when"]>,
    };
    const warnings = captureWarnings();
    try {
      const ev = buildEvaluator(
        { rules: [rule] },
        resolve([trinaryPlugin(() => undefined as unknown as boolean)]),
        makeHost(),
      );
      const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
      assert.ok(r && r.block === true);
    } finally {
      warnings.restore();
    }
  });

  it("plugin handler returning the string 'true' → narrowed to 'unknown' → default 'block' fires", async () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { tri: "x" } as unknown as NonNullable<Rule["when"]>,
    };
    const warnings = captureWarnings();
    try {
      const ev = buildEvaluator(
        { rules: [rule] },
        resolvePlugins([trinaryPlugin(() => "true" as unknown as boolean)], {}),
        makeHost(),
      );
      const r = await ev.evaluate(bashEvent("git push"), makeCtx("/repo"), 0);
      assert.ok(
        r && r.block === true,
        "a string-typed return is treated as malformed (not coerced to boolean truthy)",
      );
    } finally {
      warnings.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Empty-clause validation at config-resolve time.
// ---------------------------------------------------------------------------

describe("buildEvaluator: empty-clause validation at config-resolve", () => {
  it("throws on empty when: {}", () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: {},
    };
    assert.throws(
      () => buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
      /contains no predicate leaves/,
    );
  });

  it("throws on `when: { not: {} }` (zero-key inner block)", () => {
    // Direct empty-inner case (no modifier keys at all). Validator
    // recurses into the not-block and applies the same
    // no-predicate-leaves check; an empty body trips the inner
    // branch even before MODIFIER_KEYS stripping.
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { not: {} },
    };
    assert.throws(
      () => buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
      /\.not contains no predicate leaves/,
    );
  });

  it("throws on not-block with only modifier keys (e.g. not: { onUnknown: 'block' })", () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { not: { onUnknown: "block" } as any },
    };
    assert.throws(
      () => buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
      /\.not contains no predicate leaves/,
    );
  });

  it("accepts when: { not: { cwd: P } } — not: counts as a leaf at outer level", () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { not: { cwd: "/github/" } },
    };
    assert.doesNotThrow(() =>
      buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
    );
  });

  it("throws on plugin-shipped rules too (validator covers resolved.rules, not just config.rules)", () => {
    const plugin: Plugin = {
      name: "p",
      rules: [
        {
          name: "plugin-empty",
          tool: "bash",
          command: "git",
          reason: "plugin",
          when: {},
        },
      ],
    };
    assert.throws(
      () => buildEvaluator({}, resolvePlugins([plugin], {}), makeHost()),
      /contains no predicate leaves/,
    );
  });

  it("throws on outer-level modifier-only when: { onUnknown: 'block' } (JSON / `as any` path)", () => {
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { onUnknown: "block" } as unknown as NonNullable<Rule["when"]>,
    };
    assert.throws(
      () => buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
      /contains no predicate leaves/,
    );
  });
});

describe("buildEvaluator: plugin predicates", () => {
  it("dispatches to resolved.predicates[key]", async () => {
    const seenArgs: unknown[] = [];
    const plugin: Plugin = {
      name: "p",
      predicates: {
        commitsAhead: (args, _ctx) => {
          seenArgs.push(args);
          return true;
        },
      },
    };
    const rule: Rule = {
      name: "p-rule",
      tool: "bash",
      command: "git",
      reason: "p",
      when: { commitsAhead: { wrt: "origin/main", eq: 1 } },
    };
    const evaluator = buildEvaluator(
      { rules: [rule] },
      resolve([plugin]),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res);
    assert.deepEqual(seenArgs, [{ wrt: "origin/main", eq: 1 }]);
  });

  it("rejects an unknown when.<key> at load naming rule + key (issue #75 layer 1)", async () => {
    // UnknownPredicateError used to escape the dispatcher into the
    // per-rule catch-and-skip (warn + "rule did not fire" — silent
    // fail-open). Since #75 the key check runs at config-resolve time:
    // static configs can no longer reach the runtime projection.
    const rule: Rule = {
      name: "bad-when",
      tool: "bash",
      command: "git",
      reason: "bad",
      when: { totallyMadeUp: /whatever/ } as unknown as NonNullable<
        Rule["when"]
      >,
    };
    assert.throws(
      () => buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
      /rule "bad-when"\.when names unknown predicate "totallyMadeUp".*Install the plugin that provides "totallyMadeUp"/,
    );
  });

  it("rejects unknown keys inside not: blocks and exemption clauses at load", async () => {
    const nested: Rule = {
      name: "bad-not",
      tool: "bash",
      command: "git",
      reason: "bad",
      when: { not: { totallyMadeUp: true } } as unknown as NonNullable<
        Rule["when"]
      >,
    };
    assert.throws(
      () => buildEvaluator({ rules: [nested] }, resolve(), makeHost()),
      /rule "bad-not"\.when\.not names unknown predicate "totallyMadeUp"/,
    );
    const guard: Rule = {
      name: "guarded",
      tool: "bash",
      command: "git",
      reason: "guard",
      when: { subcommand: "push" },
    };
    assert.throws(
      () =>
        buildEvaluator(
          {
            rules: [guard],
            exemptions: [
              {
                rule: "guarded",
                when: { totallyMadeUp: true } as unknown as NonNullable<
                  Rule["when"]
                >,
              },
            ],
          },
          resolve(),
          makeHost(),
        ),
      /exemption for rule "guarded"\.when names unknown predicate "totallyMadeUp"/,
    );
  });

  it("rejects unknown keys in plugin-shipped rules naming the owning plugin", async () => {
    const badPlugin: Plugin = {
      name: "bad-plugin",
      rules: [
        {
          name: "shipped-bad",
          tool: "bash",
          command: "git",
          reason: "bad",
          when: { totallyMadeUp: true } as unknown as NonNullable<Rule["when"]>,
        },
      ],
    };
    assert.throws(
      () => buildEvaluator({ rules: [] }, resolve([badPlugin]), makeHost()),
      /rule "shipped-bad"\.when names unknown predicate "totallyMadeUp".*in plugin "bad-plugin"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Rule.onFire side-effect hook
// ---------------------------------------------------------------------------

describe("buildEvaluator: Rule.onFire", () => {
  it("runs when the rule fires and before the block verdict is returned", async () => {
    const host = makeHost();
    const order: string[] = [];
    const rule: Rule = {
      name: "f",
      tool: "bash",
      command: "echo",
      reason: "f",
      onFire: (ctx) => {
        order.push("onFire");
        ctx.appendEntry("marker", { saw: ctx.cwd });
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    const res = await evaluator.evaluate(
      bashEvent("echo hi"),
      makeCtx("/r"),
      3,
    );
    assert.ok(res && res.block === true);
    assert.deepEqual(order, ["onFire"]);
    const marker = host.appended.find((e) => e.type === "marker");
    assert.ok(marker);
    // Auto-tag from item 4 stays in effect: writes inside onFire get
    // the current agentLoopIndex merged in.
    assert.deepEqual(marker.data, { saw: "/r", _agentLoopIndex: 3 });
  });

  it("does NOT run when a predicate (when.cwd) fails", async () => {
    let called = false;
    const rule: Rule = {
      name: "f",
      tool: "bash",
      command: "git",
      reason: "f",
      when: { cwd: "/mainline/" },
      onFire: () => {
        called = true;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("cd /feature/x && git push"), // cwd = /feature/x, no match
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
    assert.equal(called, false);
  });

  it("does NOT run when the rule is overridden (noOverride: false + comment)", async () => {
    let called = false;
    const rule: Rule = {
      name: "f",
      tool: "bash",
      command: "git",
      reason: "f",
      noOverride: false,
      onFire: () => {
        called = true;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push # steering-override: f — need to"),
      makeCtx("/r"),
      0,
    );
    assert.equal(res, undefined);
    assert.equal(called, false);
  });

  it("runs on fail-closed rules that actually block (even with bogus override comment)", async () => {
    // noOverride defaults to true — the override comment is ignored,
    // rule blocks, onFire runs.
    let called = false;
    const rule: Rule = {
      name: "f",
      tool: "bash",
      command: "git",
      reason: "f",
      onFire: () => {
        called = true;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push # steering-override: f — ignored"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(called, true);
  });

  it("awaits async onFire before returning the block verdict", async () => {
    const host = makeHost();
    let awaited = false;
    const rule: Rule = {
      name: "f",
      tool: "bash",
      command: "echo",
      reason: "f",
      onFire: async (ctx) => {
        await new Promise((r) => setImmediate(r));
        awaited = true;
        ctx.appendEntry("after-await", { ok: true });
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    const res = await evaluator.evaluate(
      bashEvent("echo hi"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(awaited, true);
    const after = host.appended.find((e) => e.type === "after-await");
    assert.ok(after);
  });

  it("sync-throwing onFire is caught, warn is logged, rule still blocks (F4 / G1)", async () => {
    const host = makeHost();
    const rule: Rule = {
      name: "bad-onfire-sync",
      tool: "bash",
      command: "echo",
      reason: "bad",
      onFire: () => {
        throw new Error("boom-sync");
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...a) => {
      warns.push(a);
    };
    try {
      const res = await evaluator.evaluate(
        bashEvent("echo hi"),
        makeCtx("/r"),
        0,
      );
      assert.ok(res && res.block === true);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warns.length, 1);
    assert.match(
      String(warns[0]![0]),
      /onFire for rule "bad-onfire-sync" threw:.*boom-sync/s,
    );
  });

  it("rejected-promise onFire is caught, warn is logged, rule still blocks (F4 / G1)", async () => {
    const host = makeHost();
    const rule: Rule = {
      name: "bad-onfire-async",
      tool: "bash",
      command: "echo",
      reason: "bad",
      onFire: async () => {
        await Promise.resolve();
        throw new Error("boom-async");
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...a) => {
      warns.push(a);
    };
    try {
      const res = await evaluator.evaluate(
        bashEvent("echo hi"),
        makeCtx("/r"),
        0,
      );
      assert.ok(res && res.block === true);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warns.length, 1);
    assert.match(
      String(warns[0]![0]),
      /onFire for rule "bad-onfire-async" threw:.*boom-async/s,
    );
  });

  it("throwing onFire on the first-matching rule does not abort the verdict (F4)", async () => {
    // First-match-wins: rule A fires first, its onFire throws, the
    // verdict still returns, rule B is never consulted. This pins
    // that the throw didn't propagate up to pi OR cause fallthrough
    // to later rules.
    const host = makeHost();
    let bCalled = false;
    const ruleA: Rule = {
      name: "a",
      tool: "bash",
      command: "echo",
      reason: "ra",
      onFire: () => {
        throw new Error("a-boom");
      },
    };
    const ruleB: Rule = {
      name: "b",
      tool: "bash",
      command: "echo",
      reason: "rb",
      onFire: () => {
        bCalled = true;
      },
    };
    const evaluator = buildEvaluator(
      { rules: [ruleA, ruleB] },
      resolve(),
      host,
    );
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const res = await evaluator.evaluate(
        bashEvent("echo hi"),
        makeCtx("/r"),
        0,
      );
      assert.ok(res && res.block === true);
      assert.match(res!.reason!, /\[steering:a@user\]/);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(
      bCalled,
      false,
      "first-match-wins — rule B's onFire must not run",
    );
  });

  it("runs when rule is overridable but no override comment present (G7)", async () => {
    // Branch not covered by the existing onFire suite: overridable
    // rule (noOverride: false) + no override comment. Semantically
    // equivalent to the fail-closed + no-override case but goes
    // through a different code path — `extractOverride` returns null,
    // falls through to onFire.
    let called = false;
    const rule: Rule = {
      name: "f",
      tool: "bash",
      command: "git",
      reason: "f",
      noOverride: false,
      onFire: () => {
        called = true;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(called, true);
  });
});

// ---------------------------------------------------------------------------
// Rule.reason as a ReasonFn (D3 of Tier B / PR #5)
// ---------------------------------------------------------------------------

describe("buildEvaluator: Rule.reason function form", () => {
  it("invokes the function with the PredicateContext and prefixes the result", async () => {
    let invoked = false;
    let seenCwd: string | undefined;
    const rule: Rule = {
      name: "dyn-reason",
      tool: "bash",
      command: "rm",
      reason: (ctx) => {
        invoked = true;
        seenCwd = ctx.cwd;
        return `cannot rm at ${ctx.cwd}`;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work/proj"),
      0,
    );
    assert.ok(invoked, "reason function must be invoked");
    assert.equal(seenCwd, "/work/proj", "ctx.cwd passed through");
    assert.ok(res);
    assert.equal(
      (res as { reason: string }).reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:dyn-reason@user] cannot rm at /work/proj`,
    );
  });

  it("awaits async function reasons", async () => {
    const rule: Rule = {
      name: "async-reason",
      tool: "bash",
      command: "rm",
      reason: async (ctx) => {
        await new Promise((r) => setTimeout(r, 1));
        return `async at ${ctx.cwd}`;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.ok(res);
    assert.equal(
      (res as { reason: string }).reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:async-reason@user] async at /work`,
    );
  });

  it("appends override hint when the rule is overridable", async () => {
    const rule: Rule = {
      name: "overridable-dyn",
      tool: "bash",
      command: "rm",
      reason: () => "dynamic body",
      noOverride: false,
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("rm foo"), makeCtx("/x"), 0);
    assert.ok(res);
    const reason = (res as { reason: string }).reason;
    assert.match(
      reason,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:overridable-dyn@user\\] dynamic body`,
      ),
    );
    assert.match(
      reason,
      /To override, include a comment: `# steering-override: overridable-dyn/,
    );
  });

  it("throwing function: logs console.warn and emits fail-safe fallback", async () => {
    const warnings = captureWarnings();
    try {
      const rule: Rule = {
        name: "broken-reason",
        tool: "bash",
        command: "rm",
        reason: () => {
          throw new Error("boom");
        },
      };
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const res = await evaluator.evaluate(
        bashEvent("rm foo"),
        makeCtx("/x"),
        0,
      );
      // Block must still fire — the reason failure doesn't release the
      // rule's guard.
      assert.ok(res, "block verdict preserved even when reason fn throws");
      assert.equal(
        (res as { reason: string }).reason,
        `${BLOCK_REASON_PREAMBLE}\n\n[steering:broken-reason@user] (reason failed to format; see log)`,
      );
      // Warn message format pinned so tests can detect the throw in CI
      // output.
      const hit = warnings.find((w) => /reason function threw/.test(w));
      assert.ok(
        hit,
        `expected a 'reason function threw' warning; got: ${warnings.join("\n")}`,
      );
      assert.match(
        hit!,
        /\[pi-steering\] Rule "broken-reason"@user: reason function threw: boom/,
      );
      assert.match(hit!, /at /, "warning includes the stack");
    } finally {
      warnings.restore();
    }
  });

  it("rejecting async function: also triggers fallback + console.warn", async () => {
    const warnings = captureWarnings();
    try {
      const rule: Rule = {
        name: "async-broken",
        tool: "bash",
        command: "rm",
        reason: async () => {
          throw new Error("async boom");
        },
      };
      const evaluator = buildEvaluator(
        { rules: [rule] },
        resolve(),
        makeHost(),
      );
      const res = await evaluator.evaluate(
        bashEvent("rm foo"),
        makeCtx("/x"),
        0,
      );
      assert.ok(res);
      assert.equal(
        (res as { reason: string }).reason,
        `${BLOCK_REASON_PREAMBLE}\n\n[steering:async-broken@user] (reason failed to format; see log)`,
      );
      assert.ok(
        warnings.some((w) => /reason function threw: async boom/.test(w)),
      );
    } finally {
      warnings.restore();
    }
  });

  it("reason fn reads ctx.walkerState.cwd — the canonical use case", async () => {
    // Lock in the RDS-migration-findings workflow: a rule reads the
    // walker-resolved cwd to produce a contextual block message.
    // Uses `cd $(pwd)` to push cwd into 'unknown'; reason fn reports
    // that to the agent so they know the chain was intractable.
    const rule: Rule = {
      name: "cwd-reporter",
      tool: "bash",
      command: "rm",
      reason: (ctx) => {
        const cwd = ctx.walkerState?.["cwd"] as string;
        return cwd === "unknown"
          ? "walker could not resolve cwd statically"
          : `rm blocked at ${cwd}`;
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("cd $(pwd) && rm foo"),
      makeCtx("/orig"),
      0,
    );
    assert.ok(res);
    assert.equal(
      (res as { reason: string }).reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:cwd-reporter@user] walker could not resolve cwd statically`,
    );
  });
});

// ---------------------------------------------------------------------------
// formatReason: paragraph-aware tag separator
// ---------------------------------------------------------------------------

describe("buildEvaluator: formatReason paragraph-aware tag separator", () => {
  it("renders single-line body with single-space tag separator", async () => {
    const rule: Rule = {
      name: "single-line",
      tool: "bash",
      command: "rm",
      reason: "a single-line body",
      noOverride: true,
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.ok(res);
    assert.equal(
      (res as { reason: string }).reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:single-line@user] a single-line body`,
    );
  });

  it("renders multi-paragraph body with `\\n\\n` separator (tag on its own line)", async () => {
    const rule: Rule = {
      name: "multi-para",
      tool: "bash",
      command: "rm",
      reason: "first paragraph.\n\nsecond paragraph.",
      noOverride: true,
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.ok(res);
    assert.equal(
      (res as { reason: string }).reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:multi-para@user]\n\nfirst paragraph.\n\nsecond paragraph.`,
    );
  });

  it("treats single-newline-only body as single-paragraph (no `\\n\\n` trigger)", async () => {
    // Pin the trigger as double-newline specifically: a single `\n` between
    // two lines does NOT activate the paragraph-aware separator.
    const rule: Rule = {
      name: "single-newline",
      tool: "bash",
      command: "rm",
      reason: "line one\nline two",
      noOverride: true,
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.ok(res);
    assert.equal(
      (res as { reason: string }).reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:single-newline@user] line one\nline two`,
    );
  });

  it("appends override hint after multi-paragraph body as its own paragraph when rule is overridable", async () => {
    // Override hint mirrors the body's paragraph structure: multi-
    // paragraph bodies get the hint as a standalone paragraph (`\n\n`
    // separator), so the safety paragraph stays visually standalone
    // rather than running on with the override sentence.
    const rule: Rule = {
      name: "multi-para-overridable",
      tool: "bash",
      command: "rm",
      reason: "first.\n\nsecond.",
      noOverride: false,
    };
    const evaluator = buildEvaluator(
      { defaultNoOverride: false, rules: [rule] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.ok(res);
    const reason = (res as { reason: string }).reason;
    assert.match(
      reason,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:multi-para-overridable@user\\]\\n\\nfirst\\.\\n\\nsecond\\.`,
      ),
    );
    assert.match(reason, /\n\nTo override, include a comment: /);
  });

  it("renders CRLF multi-paragraph body (`\\r\\n\\r\\n`) with `\\n\\n` separator (defensive against Windows line endings)", async () => {
    // Body imported from a CRLF source (Windows line endings, CRLF
    // templating layer, hand-typed Windows-IDE string) should render
    // the same way as `\n\n`-encoded multi-paragraph bodies. Cheap
    // defensive trigger extension; emitted separator is normalized
    // to `\n\n` regardless of which form triggered it.
    const rule: Rule = {
      name: "crlf-multi-para",
      tool: "bash",
      command: "rm",
      reason: "first paragraph.\r\n\r\nsecond paragraph.",
      noOverride: true,
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("rm foo"),
      makeCtx("/work"),
      0,
    );
    assert.ok(res);
    const reason = (res as { reason: string }).reason;
    // Tag promoted to its own line (the `\n\n` separator) even though
    // the body's paragraph break is CRLF-encoded. Body content stays
    // CRLF-encoded; only the tag separator is normalized.
    assert.match(
      reason,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:crlf-multi-para@user\\]\\n\\nfirst paragraph\\.\\r\\n\\r\\nsecond paragraph\\.`,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Override comments + noOverride
// ---------------------------------------------------------------------------

describe("buildEvaluator: override comments", () => {
  it("consumes override comment, appends audit entry, skips block", async () => {
    const host = makeHost();
    const evaluator = buildEvaluator(
      // defaultNoOverride: false so the rule is overridable by default.
      { defaultNoOverride: false, rules: [NO_FORCE_PUSH] },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      bashEvent(
        "git push --force # steering-override: no-force-push \u2014 coordinated rewrite",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
    assert.equal(host.appended.length, 1);
    assert.equal(host.appended[0]!.type, "steering-override");
    assert.deepEqual(
      (host.appended[0]!.data as { rule: string; reason: string }).rule,
      "no-force-push",
    );
    assert.equal(
      (host.appended[0]!.data as { reason: string }).reason,
      "coordinated rewrite",
    );
  });

  it("rule.noOverride:true blocks even with override comment", async () => {
    const host = makeHost();
    const rule: Rule = { ...NO_FORCE_PUSH, noOverride: true };
    const evaluator = buildEvaluator(
      { defaultNoOverride: false, rules: [rule] },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      bashEvent(
        "git push --force # steering-override: no-force-push \u2014 I promise",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(host.appended.length, 0);
    // Golden-string: noOverride:true must OMIT the override hint tail.
    // Tighter than a `doesNotMatch(/To override/)` — pins the whole
    // reason including the engine preamble, the `[steering:…]` prefix
    // and lack of trailing punctuation.
    assert.equal(
      res!.reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:no-force-push@user] no force push`,
    );
  });

  it("defaultNoOverride=true (default) blocks even with override comment", async () => {
    const host = makeHost();
    const evaluator = buildEvaluator(
      // No defaultNoOverride → defaults to true per ADR.
      { rules: [NO_FORCE_PUSH] },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      bashEvent(
        "git push --force # steering-override: no-force-push \u2014 nope",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(host.appended.length, 0);
  });

  it("rule.noOverride:false wins over defaultNoOverride:true", async () => {
    const host = makeHost();
    const rule: Rule = { ...NO_FORCE_PUSH, noOverride: false };
    const evaluator = buildEvaluator(
      { defaultNoOverride: true, rules: [rule] },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      bashEvent(
        "git push --force # steering-override: no-force-push \u2014 ok",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
    assert.equal(host.appended.length, 1);
  });

  it("block reason is a stable golden string (overridable vs not)", async () => {
    // Golden-string assertions instead of fuzzy regex: pin the
    // leader character (`#` for bash), the em dash, the backticks,
    // and the trailing period. These shapes are part of the public
    // block-reason contract with pi's agent — drift in any
    // character is an observable behaviour change.
    const evNoOverride = buildEvaluator(
      { rules: [NO_FORCE_PUSH] }, // defaultNoOverride defaults to true
      resolve(),
      makeHost(),
    );
    const evOverridable = buildEvaluator(
      { defaultNoOverride: false, rules: [NO_FORCE_PUSH] },
      resolve(),
      makeHost(),
    );
    const r1 = await evNoOverride.evaluate(
      bashEvent("git push --force"),
      makeCtx("/r"),
      0,
    );
    const r2 = await evOverridable.evaluate(
      bashEvent("git push --force"),
      makeCtx("/r"),
      0,
    );
    // Not overridable → no hint tail.
    assert.equal(
      r1!.reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:no-force-push@user] no force push`,
    );
    // Overridable → hint tail uses the `#` bash leader, em dash, and
    // backticked comment template.
    assert.equal(
      r2!.reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:no-force-push@user] no force push To override, ` +
        "include a comment: `# steering-override: no-force-push \u2014 <reason>`.",
    );
  });

  it("override for rule-A does NOT apply to rule-B (name-specific lookup)", async () => {
    // Two rules, both firing on the same bash command. The override
    // comment targets only rule-a by name. The evaluator's
    // first-match-wins loop surfaces rule-a first → the override is
    // consumed → rule-a logs + yields. The loop then moves to
    // rule-b, whose name is not mentioned in the override text, so
    // rule-b should still block.
    const host = makeHost();
    const ruleA: Rule = {
      name: "rule-a",
      tool: "bash",
      command: "git",
      reason: "a",
    };
    const ruleB: Rule = {
      name: "rule-b",
      tool: "bash",
      command: "git",
      reason: "b",
    };
    const evaluator = buildEvaluator(
      { defaultNoOverride: false, rules: [ruleA, ruleB] },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      bashEvent("git push # steering-override: rule-a \u2014 docs say so"),
      makeCtx("/r"),
      0,
    );
    // rule-b still blocks.
    assert.ok(res && res.block === true);
    assert.match(res!.reason!, /\[steering:rule-b@[^\]]+\]/);
    // rule-a's override was recorded as consumed; rule-b was NOT
    // overridden (exactly one audit entry, keyed to rule-a).
    assert.equal(host.appended.length, 1);
    assert.equal(host.appended[0]!.type, "steering-override");
    assert.equal((host.appended[0]!.data as { rule: string }).rule, "rule-a");
  });

  it("audit entry carries the current _agentLoopIndex (F3)", async () => {
    // Override entries go through `shared.appendEntry` (the wrapped
    // path) so rules using `when.missing: { event:
    // "steering-override", in: "agent_loop" }` can see them. This
    // test just pins the shape — the agent_loop / session behaviours
    // follow.
    const host = makeHost();
    const evaluator = buildEvaluator(
      { defaultNoOverride: false, rules: [NO_FORCE_PUSH] },
      resolve(),
      host,
    );
    await evaluator.evaluate(
      bashEvent("git push --force # steering-override: no-force-push \u2014 r"),
      makeCtx("/r"),
      11,
    );
    assert.equal(host.appended.length, 1);
    const data = host.appended[0]!.data as Record<string, unknown>;
    assert.equal(data["_agentLoopIndex"], 11);
    assert.equal(data["rule"], "no-force-push");
  });

  it('when.missing { event: "steering-override", in: "agent_loop" } filters overrides by current loop (F3)', async () => {
    // Loop 7: override is consumed for no-force-push. A DIFFERENT rule
    // gates on `missing: { steering-override, agent_loop }` — after the
    // override lands in loop 7 it should observe "missing" in loop 7
    // (predicate returns false → rule skips) but NOT in loop 8
    // (predicate returns true → rule fires).
    const host = makeHost();
    const overridableRule: Rule = {
      name: "no-force-push",
      tool: "bash",
      command: "git",
      reason: "no force",
      noOverride: false,
    };
    // "Canary" rule fires on `echo hi` only when NO override-audit
    // entry exists in the current agent loop.
    const canaryRule: Rule = {
      name: "canary",
      tool: "bash",
      command: "echo",
      reason: "canary",
      when: {
        missing: { event: "steering-override", in: "agent_loop" },
      },
    };
    const evaluator = buildEvaluator(
      { defaultNoOverride: false, rules: [overridableRule, canaryRule] },
      resolve(),
      host,
    );
    // Loop 7: consume the override.
    const r1 = await evaluator.evaluate(
      bashEvent("git push --force # steering-override: no-force-push \u2014 r"),
      makeCtx("/r", host.entries),
      7,
    );
    assert.equal(r1, undefined, "override accepted, no block");

    // Loop 7: canary sees the override → "missing" is true → predicate
    // returns false → rule skips.
    const r2 = await evaluator.evaluate(
      bashEvent("echo hi"),
      makeCtx("/r", host.entries),
      7,
    );
    assert.equal(r2, undefined, "canary skipped in same loop as override");

    // Loop 8: same entries array, but agent_loop scope filters by
    // tag → the loop-7-tagged override is invisible → canary fires.
    const r3 = await evaluator.evaluate(
      bashEvent("echo hi"),
      makeCtx("/r", host.entries),
      8,
    );
    assert.ok(
      r3 && r3.block === true,
      "canary fires in new loop because override is tagged to loop 7",
    );
  });

  it('when.missing { event: "steering-override", in: "session" } sees overrides across loops (F3)', async () => {
    // Session scope ignores the `_agentLoopIndex` tag — any override
    // ever consumed in the session suppresses the canary regardless
    // of which loop produced it.
    const host = makeHost();
    const overridableRule: Rule = {
      name: "no-force-push",
      tool: "bash",
      command: "git",
      reason: "no force",
      noOverride: false,
    };
    const canaryRule: Rule = {
      name: "canary",
      tool: "bash",
      command: "echo",
      reason: "canary",
      when: { missing: { event: "steering-override", in: "session" } },
    };
    const evaluator = buildEvaluator(
      { defaultNoOverride: false, rules: [overridableRule, canaryRule] },
      resolve(),
      host,
    );
    await evaluator.evaluate(
      bashEvent("git push --force # steering-override: no-force-push \u2014 r"),
      makeCtx("/r", host.entries),
      7,
    );
    const r = await evaluator.evaluate(
      bashEvent("echo hi"),
      makeCtx("/r", host.entries),
      99,
    );
    assert.equal(
      r,
      undefined,
      "session scope: override seen regardless of agent_loop",
    );
  });
});

// ---------------------------------------------------------------------------
// Write / edit tools
// ---------------------------------------------------------------------------

describe("buildEvaluator: write / edit", () => {
  it("fires on write content matching pattern", async () => {
    const rule: Rule = {
      name: "no-private-key",
      tool: "write",
      field: "content",
      pattern: "BEGIN RSA PRIVATE KEY",
      reason: "no private keys",
    };
    const evaluator = buildEvaluator(
      // Overridable so the block reason carries the override hint.
      // Lets us pin the write/edit `//` leader variant as a golden
      // string (leader + em dash + backticks + trailing period).
      { defaultNoOverride: false, rules: [rule] },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      writeEvent("/r/k.pem", "-----BEGIN RSA PRIVATE KEY-----"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.equal(
      res!.reason,
      `${BLOCK_REASON_PREAMBLE}\n\n[steering:no-private-key@user] no private keys To override, ` +
        "include a comment: `// steering-override: no-private-key \u2014 <reason>`.",
    );
  });

  it("field:path scans path instead of content", async () => {
    const rule: Rule = {
      name: "no-node-modules-write",
      tool: "write",
      field: "path",
      pattern: "/node_modules/",
      reason: "no node_modules writes",
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      writeEvent("/r/node_modules/foo.js", "// content"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
  });

  it("edit joins newText across edits", async () => {
    const rule: Rule = {
      name: "no-console-log",
      tool: "edit",
      field: "content",
      pattern: "console\\.log",
      reason: "no console.log",
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      editEvent("/r/a.ts", [
        { oldText: "const x = 1;", newText: "const x = 1;\nconsole.log(x);" },
      ]),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
  });

  it("edit field:path scans path instead of joined newText", async () => {
    // Mirrors the write+path test above for the edit tool. Proves
    // the field="path" dispatch in evaluateWriteEditRule picks
    // `event.input.path` as the pattern target — independent of the
    // edits array's joined newText, which could have been the
    // naive default carried over from the edit-content branch.
    const rule: Rule = {
      name: "no-node-modules-edit",
      tool: "edit",
      field: "path",
      pattern: "/node_modules/",
      reason: "no node_modules edits",
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      editEvent("/r/node_modules/foo.js", [
        // newText has NO `/node_modules/` token — proving the rule
        // would miss if field:path were silently ignored and the
        // evaluator fell back to the joined-newText default.
        { oldText: "a", newText: "b" },
      ]),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
  });

  it("write override comment is honored (// leader)", async () => {
    const host = makeHost();
    const rule: Rule = {
      name: "no-todo",
      tool: "write",
      field: "content",
      pattern: "TODO",
      reason: "no todos",
    };
    const evaluator = buildEvaluator(
      { defaultNoOverride: false, rules: [rule] },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      writeEvent(
        "/r/note.ts",
        "// steering-override: no-todo \u2014 doc-only\nTODO: remove later",
      ),
      makeCtx("/r"),
      0,
    );
    assert.equal(res, undefined);
    assert.equal(host.appended.length, 1);
    assert.equal(host.appended[0]!.type, "steering-override");
    assert.deepEqual(
      (host.appended[0]!.data as { path: string }).path,
      "/r/note.ts",
    );
  });
});

// ---------------------------------------------------------------------------
// Rule ordering + walker reuse + exec memoization
// ---------------------------------------------------------------------------

describe("buildEvaluator: rule ordering (config before plugin)", () => {
  it("config rule fires first when both would fire", async () => {
    const userRule: Rule = {
      name: "user-rule",
      tool: "bash",
      command: "git",
      reason: "user",
    };
    const pluginRule: Rule = {
      name: "plugin-rule",
      tool: "bash",
      command: "git",
      reason: "plugin",
    };
    const plugin: Plugin = { name: "p", rules: [pluginRule] };
    const evaluator = buildEvaluator(
      { rules: [userRule] },
      resolve([plugin]),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res);
    assert.match(res!.reason!, /\[steering:user-rule@[^\]]+\]/);
  });
});

describe("buildEvaluator: walker reuse + exec cache", () => {
  it("evaluates N rules against the SAME walker output (no re-parse)", async () => {
    // Smoke test: three bash rules firing against one tool_call all
    // see consistent cwd resolution — the walker runs once. We can't
    // directly observe `parseBash` calls without mocking, so we use
    // the test that all three rules independently resolve the same
    // per-ref cwd as evidence.
    const rules: Rule[] = [
      {
        name: "r1",
        tool: "bash",
        command: "ls",
        reason: "1",
        when: { cwd: "^/tmp/A$" },
      },
      {
        name: "r2",
        tool: "bash",
        command: "ls",
        reason: "2",
        when: { cwd: "^/tmp/B$" },
      },
      {
        name: "r3",
        tool: "bash",
        command: "echo",
        reason: "3",
        when: { cwd: "^/tmp/B$" },
      },
    ];
    const evaluator = buildEvaluator({ rules }, resolve(), makeHost());
    // `ls` runs at /tmp/A, `echo` runs at /tmp/B. r1 should fire (ls in A)
    // and short-circuits further evaluation.
    const res = await evaluator.evaluate(
      bashEvent("cd /tmp/A && ls && cd /tmp/B && echo hi"),
      makeCtx("/home"),
      0,
    );
    assert.ok(res);
    assert.match(res!.reason!, /\[steering:r1@[^\]]+\]/);
  });

  it("memoizes exec by (cmd, args, cwd) within one tool_call", async () => {
    const host = makeHost();
    let callCount = 0;
    const trackingHost: EvaluatorHost = {
      exec: async (cmd, args, opts) => {
        callCount++;
        return host.exec(cmd, args, opts);
      },
      appendEntry: host.appendEntry,
    };
    // Two rules hit the same exec() query inside their `condition`.
    const r1: Rule = {
      name: "r1",
      tool: "bash",
      command: "git",
      reason: "r1",
      when: {
        condition: async (ctx) => {
          await ctx.exec("git", ["status"], { cwd: "/repo" });
          return false; // don't fire — let the second rule run
        },
      },
    };
    const r2: Rule = {
      name: "r2",
      tool: "bash",
      command: "git",
      reason: "r2",
      when: {
        condition: async (ctx) => {
          await ctx.exec("git", ["status"], { cwd: "/repo" });
          return true;
        },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [r1, r2] },
      resolve(),
      trackingHost,
    );
    const res = await evaluator.evaluate(
      bashEvent("git status"),
      makeCtx("/home"),
      0,
    );
    assert.ok(res);
    assert.match(res!.reason!, /\[steering:r2@[^\]]+\]/);
    // Both rules asked for the same (cmd, args, cwd): memoized → 1 call.
    assert.equal(callCount, 1);
  });

  it("does NOT memoize across tool_calls (fresh cache each time)", async () => {
    let callCount = 0;
    const host: EvaluatorHost = {
      exec: async () => {
        callCount++;
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
      appendEntry: () => {},
    };
    const rule: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: {
        condition: async (ctx) => {
          await ctx.exec("git", ["status"], { cwd: "/repo" });
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    await evaluator.evaluate(bashEvent("git status"), makeCtx("/r"), 0);
    await evaluator.evaluate(bashEvent("git status"), makeCtx("/r"), 0);
    assert.equal(callCount, 2);
  });

  it("ctx.exec returns schema-shape ExecResult (exitCode, not code)", async () => {
    // The evaluator owns an adapter (toSchemaExecResult in
    // context.ts) that renames pi's `code` to the schema's
    // `exitCode` and drops `killed`. This test pins the boundary:
    // a host returning pi's shape must surface as the schema
    // shape inside the predicate context.
    const host: EvaluatorHost = {
      exec: async () => ({
        stdout: "x",
        stderr: "y",
        code: 42,
        killed: false,
      }),
      appendEntry: () => {},
    };
    let observed: { hasExitCode: boolean; hasCode: boolean } | null = null;
    const rule: Rule = {
      name: "exec-shape",
      tool: "bash",
      command: "git",
      reason: "shape",
      when: {
        condition: async (ctx) => {
          const r = await ctx.exec("git", ["status"]);
          observed = {
            hasExitCode: (r as { exitCode?: number }).exitCode === 42,
            // Adapter drops `code` — accessing it returns undefined.
            hasCode: (r as unknown as { code?: number }).code !== undefined,
          };
          // Rule fires only when exitCode === 42, which
          // implicitly proves the rename took effect.
          return r.exitCode === 42;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    const res = await evaluator.evaluate(
      bashEvent("git status"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.ok(observed, "condition should have been invoked");
    const obs = observed as unknown as {
      hasExitCode: boolean;
      hasCode: boolean;
    };
    assert.equal(obs.hasExitCode, true, "exitCode should equal 42");
    assert.equal(obs.hasCode, false, "adapter must drop pi's `code` field");
  });

  it("exec cache keys cwd — different cwd triggers a second call", async () => {
    // Contrast with the "memoizes by (cmd, args, cwd)" test above,
    // which reuses one cwd and expects a single call. Here the same
    // (cmd, args) query runs twice with DIFFERENT cwd values; the
    // cache key must differ so the host sees two invocations.
    let callCount = 0;
    const host: EvaluatorHost = {
      exec: async () => {
        callCount++;
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
      appendEntry: () => {},
    };
    const rule: Rule = {
      name: "cwd-key",
      tool: "bash",
      command: "git",
      reason: "cwd-key",
      when: {
        condition: async (ctx) => {
          await ctx.exec("git", ["status"], { cwd: "/repo-a" });
          await ctx.exec("git", ["status"], { cwd: "/repo-b" });
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    await evaluator.evaluate(bashEvent("git status"), makeCtx("/home"), 0);
    assert.equal(callCount, 2, "different cwds must not collide in cache");
  });
});

// ---------------------------------------------------------------------------
// findEntries reading session entries
// ---------------------------------------------------------------------------

describe("buildEvaluator: findEntries", () => {
  it("reads customType-filtered session entries, timestamps in epoch ms", async () => {
    const rule: Rule = {
      name: "turn-state-rule",
      tool: "bash",
      command: "git",
      reason: "must have read-first",
      when: {
        condition: (ctx) => {
          const entries = ctx.findEntries<{ note: string }>("marker");
          assert.equal(entries.length, 1);
          assert.equal(entries[0]!.data.note, "hi");
          assert.equal(
            typeof entries[0]!.timestamp,
            "number",
            "timestamp is epoch ms",
          );
          assert.ok(entries[0]!.timestamp > 0);
          return true;
        },
      },
    };
    const ctx = makeCtx("/r", [
      {
        type: "custom",
        customType: "marker",
        data: { note: "hi" },
        timestamp: "2026-01-01T00:00:00.000Z",
        id: "e1",
        parentId: null,
      },
      {
        type: "custom",
        customType: "other",
        data: { ignore: true },
        timestamp: "2026-01-01T00:00:01.000Z",
        id: "e2",
        parentId: null,
      },
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(bashEvent("git push"), ctx, 0);
    assert.ok(res);
  });

  it("memoizes findEntries by customType within one tool_call (stable reference)", async () => {
    // createFindEntries caches per-customType, per-closure. Within a
    // single tool_call two reads of the SAME customType must return
    // the exact same array reference — otherwise predicate chains
    // that dedupe or diff entry lists would get a fresh array every
    // call and wrongly believe state changed.
    let observed: {
      first: ReadonlyArray<unknown>;
      second: ReadonlyArray<unknown>;
    } | null = null;
    const rule: Rule = {
      name: "memo-ref",
      tool: "bash",
      command: "git",
      reason: "memo-ref",
      when: {
        condition: (ctx) => {
          const a = ctx.findEntries<{ note: string }>("marker");
          const b = ctx.findEntries<{ note: string }>("marker");
          observed = { first: a, second: b };
          return true;
        },
      },
    };
    const ctx = makeCtx("/r", [
      {
        type: "custom",
        customType: "marker",
        data: { note: "hi" },
        timestamp: "2026-01-01T00:00:00.000Z",
        id: "e1",
        parentId: null,
      },
    ]);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    await evaluator.evaluate(bashEvent("git push"), ctx, 0);
    assert.ok(observed, "condition should have run");
    const obs = observed as unknown as {
      first: ReadonlyArray<unknown>;
      second: ReadonlyArray<unknown>;
    };
    assert.strictEqual(
      obs.first,
      obs.second,
      "findEntries must return the same array reference on repeat calls",
    );
  });

  it("invalidates the cache on appendEntry so later reads see the write (S2/E1)", async () => {
    // Within a single rule: read X, write X, read X — the second read
    // must reflect the write. Pre-S2 the cache held the pre-write list
    // and masked the write within one phase.
    let before: number | null = null;
    let after: number | null = null;
    const rule: Rule = {
      name: "s2-single-rule",
      tool: "bash",
      command: "echo",
      reason: "s2 single",
      when: {
        condition: (ctx) => {
          before = ctx.findEntries("marker").length;
          ctx.appendEntry("marker", { note: "added" });
          after = ctx.findEntries("marker").length;
          return false; // don't fire; we only care about the reads
        },
      },
    };
    const host = makeHost();
    const ctx = makeCtx("/r", host.entries);
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    await evaluator.evaluate(bashEvent("echo x"), ctx, 0);
    assert.equal(before, 0, "pre-write read must see zero entries");
    assert.equal(after, 1, "post-write read must see the new entry");
  });

  it("cross-rule: rule A's onFire write is visible to rule B's when.missing (S2/E1)", async () => {
    // Rule A fires and writes "A-fired" via onFire. Rule B's
    // when.missing reads "A-fired" with `in: "agent_loop"` and fires
    // only when the write is NOT present (the built-in `missing`
    // semantics). Pre-S2 the cached read in rule B saw the pre-write
    // snapshot and wrongly fired.
    const ruleA: Rule = {
      name: "a",
      tool: "bash",
      command: "echo",
      reason: "a fires",
      writes: ["A-fired"],
      onFire: (ctx) => ctx.appendEntry("A-fired", {}),
    };
    const ruleB: Rule = {
      name: "b",
      tool: "bash",
      command: "echo",
      reason: "b fires only if A has not fired this loop",
      when: { missing: { event: "A-fired", in: "agent_loop" } },
    };
    const host = makeHost();
    const ctx = makeCtx("/r", host.entries);
    const evaluator = buildEvaluator(
      { rules: [ruleA, ruleB], defaultNoOverride: false },
      resolve(),
      host,
    );
    const result = await evaluator.evaluate(bashEvent("echo x"), ctx, 7);
    // Rule A fires first (first-match-wins). Its block verdict is
    // returned; rule B doesn't get to evaluate on this single event.
    assert.ok(result && result.block === true);
    assert.ok(
      /\[steering:a@user\]/.test(result.reason ?? ""),
      `expected rule A to fire; got: ${result.reason}`,
    );
    // The onFire wrote an "A-fired" entry tagged with the current
    // agentLoopIndex. Verify it landed — the cross-rule visibility
    // consequence is demonstrated by the next test.
    assert.equal(host.appended.length, 1);
    assert.equal(host.appended[0]!.type, "A-fired");
  });

  it("the override-audit write in an earlier rule is visible to a later rule's when.missing (S2/E1)", async () => {
    // A rule-level `noOverride: false` rule writes a
    // `steering-override` audit entry when the agent supplies an
    // override comment. A later rule can gate on that via
    // `when.missing: { event: "steering-override", in: "agent_loop" }`.
    // Pre-S2, the later rule's cached findEntries read from before the
    // override wrote would miss the audit entry.
    const overridable: Rule = {
      name: "overridable",
      tool: "bash",
      command: "git",
      reason: "overridable",
      noOverride: false,
    };
    // A second rule that fires ONLY when no steering-override has
    // been recorded in this agent loop. With S2 in place, the override
    // written by `overridable` invalidates the cache — so this rule
    // sees the fresh entry and its `when.missing` returns false.
    // Pre-S2, the cached read would miss the override write and this
    // rule would wrongly fire.
    const gate: Rule = {
      name: "override-gate",
      tool: "bash",
      command: "git",
      reason: "gate",
      when: {
        missing: { event: "steering-override", in: "agent_loop" },
      },
    };
    const host = makeHost();
    const ctx = makeCtx("/r", host.entries);
    const evaluator = buildEvaluator(
      { rules: [overridable, gate] },
      resolve(),
      host,
    );
    // Send a command that matches both rules AND carries an override
    // comment addressing `overridable`. The evaluator:
    //   1. Evaluates `overridable` → fires → override comment accepted
    //      → writes steering-override audit entry → returns "overridden".
    //   2. Continues to `gate` → when.missing reads steering-override
    //      — with S2, sees the fresh audit entry → predicate returns
    //      false → rule does NOT fire.
    const result = await evaluator.evaluate(
      bashEvent(
        "git push # steering-override: overridable — shipping a hotfix",
      ),
      ctx,
      3,
    );
    assert.equal(
      result,
      undefined,
      "second rule should not fire after the override audit is visible",
    );
  });
});

// ---------------------------------------------------------------------------
// Default fail-closed defaultNoOverride (sanity)
// ---------------------------------------------------------------------------

describe("buildEvaluator: appendEntry auto-tags with _agentLoopIndex", () => {
  it("object payload gets _agentLoopIndex merged in", async () => {
    const host = makeHost();
    const rule: Rule = {
      name: "tag-object",
      tool: "bash",
      command: "echo",
      reason: "tag-object",
      when: {
        condition: (ctx) => {
          ctx.appendEntry("pred-write", { foo: "bar" });
          return false; // never fires; only side effect matters
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    await evaluator.evaluate(bashEvent("echo hi"), makeCtx("/r"), 5);
    const found = host.appended.find((e) => e.type === "pred-write");
    assert.ok(found);
    assert.deepEqual(found.data, { foo: "bar", _agentLoopIndex: 5 });
  });

  it("primitive / undefined payloads wrap as { value, _agentLoopIndex }", async () => {
    const host = makeHost();
    const rule: Rule = {
      name: "tag-prim",
      tool: "bash",
      command: "echo",
      reason: "tag-prim",
      when: {
        condition: (ctx) => {
          ctx.appendEntry("no-data");
          ctx.appendEntry("num", 7);
          ctx.appendEntry("str", "hi");
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    await evaluator.evaluate(bashEvent("echo hi"), makeCtx("/r"), 2);
    const pred = host.appended.filter((e) =>
      ["no-data", "num", "str"].includes(e.type),
    );
    assert.equal(pred.length, 3);
    assert.deepEqual(pred[0]!.data, {
      value: undefined,
      _agentLoopIndex: 2,
    });
    assert.deepEqual(pred[1]!.data, { value: 7, _agentLoopIndex: 2 });
    assert.deepEqual(pred[2]!.data, { value: "hi", _agentLoopIndex: 2 });
  });

  it("non-plain-object payloads wrap as { value, _agentLoopIndex } (F2 / G3)", async () => {
    // The naive spread (`{ ...data, ... }`) silently corrupts arrays,
    // Dates, Maps, Sets, Errors, and class instances. Every such
    // input must wrap under `value` with the original reference
    // preserved, same as a primitive.
    const host = makeHost();
    const date = new Date("2020-01-01T00:00:00Z");
    const map = new Map<string, number>([["a", 1]]);
    const set = new Set<number>([1, 2, 3]);
    const err = new Error("boom");
    const fn = () => 42;
    class Box {
      readonly n: number;
      constructor(n: number) {
        this.n = n;
      }
    }
    const box = new Box(7);
    const rule: Rule = {
      name: "tag-nonplain",
      tool: "bash",
      command: "echo",
      reason: "tag-nonplain",
      when: {
        condition: (ctx) => {
          ctx.appendEntry("arr", [1, 2, 3]);
          ctx.appendEntry("date", date);
          ctx.appendEntry("map", map);
          ctx.appendEntry("set", set);
          ctx.appendEntry("err", err);
          ctx.appendEntry("fn", fn);
          ctx.appendEntry("box", box);
          ctx.appendEntry("nil", null);
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
    await evaluator.evaluate(bashEvent("echo hi"), makeCtx("/r"), 5);
    const byType = new Map(
      host.appended
        .filter((e) =>
          ["arr", "date", "map", "set", "err", "fn", "box", "nil"].includes(
            e.type,
          ),
        )
        .map((e) => [e.type, e.data] as const),
    );
    assert.deepEqual(byType.get("arr"), {
      value: [1, 2, 3],
      _agentLoopIndex: 5,
    });
    assert.deepEqual(byType.get("date"), {
      value: date,
      _agentLoopIndex: 5,
    });
    assert.deepEqual(byType.get("map"), {
      value: map,
      _agentLoopIndex: 5,
    });
    assert.deepEqual(byType.get("set"), {
      value: set,
      _agentLoopIndex: 5,
    });
    assert.deepEqual(byType.get("err"), {
      value: err,
      _agentLoopIndex: 5,
    });
    assert.deepEqual(byType.get("fn"), {
      value: fn,
      _agentLoopIndex: 5,
    });
    assert.deepEqual(byType.get("box"), {
      value: box,
      _agentLoopIndex: 5,
    });
    assert.deepEqual(byType.get("nil"), {
      value: null,
      _agentLoopIndex: 5,
    });
  });
});

describe("buildEvaluator: defaults", () => {
  it("omitted defaultNoOverride coerces to true (fail-closed)", async () => {
    // Same as the noOverride:true case above, but without any rule
    // flag or config flag. Both should block — pure default path.
    const rule: Rule = {
      name: "f",
      tool: "bash",
      command: "git",
      reason: "f",
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push # steering-override: f \u2014 please let me through"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
  });
});

// ---------------------------------------------------------------------------
// empty config (nothing to evaluate)
// ---------------------------------------------------------------------------

describe("buildEvaluator: no rules", () => {
  it("returns undefined when neither config.rules nor plugin rules present", async () => {
    const evaluator = buildEvaluator({}, resolve(), makeHost());
    assert.equal(
      await evaluator.evaluate(bashEvent("rm -rf /"), makeCtx("/r"), 0),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin-shipped rule evaluation (smoke)
// ---------------------------------------------------------------------------

describe("buildEvaluator: plugin-shipped rules", () => {
  it("fires a plugin rule when no user rule matches", async () => {
    const plugin: Plugin = {
      name: "p",
      rules: [NO_FORCE_PUSH],
    };
    const evaluator = buildEvaluator({}, resolve([plugin]), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push --force"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res!.reason!, /\[steering:no-force-push@[^\]]+\]/);
  });

  it("block reason is source-tagged with the originating plugin name", async () => {
    const plugin: Plugin = {
      name: "git-plugin",
      rules: [NO_FORCE_PUSH],
    };
    const evaluator = buildEvaluator({}, resolve([plugin]), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push --force"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res!.reason!,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:no-force-push@git-plugin\\]`,
      ),
    );
  });

  it("user rules get @user source tag", async () => {
    const rule: Rule = {
      name: "my-rule",
      tool: "bash",
      command: "git",
      reason: "user said so",
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res!.reason!,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:my-rule@user\\]`,
      ),
    );
  });

  it("honors config.disabledRules to skip plugin rule", async () => {
    const plugin: Plugin = {
      name: "p",
      rules: [NO_FORCE_PUSH],
    };
    const cfg: SteeringConfig = { disabledRules: ["no-force-push"] };
    // `resolvePlugins` applies `disabledRules` to plugin rules at merge time.
    const evaluator = buildEvaluator(
      cfg,
      resolvePlugins([plugin], cfg),
      makeHost(),
    );
    assert.equal(
      await evaluator.evaluate(bashEvent("git push --force"), makeCtx("/r"), 0),
      undefined,
    );
  });

  it("user rule shadows plugin rule with the same name — @user source wins (G4)", async () => {
    // Both rules named "same". User rule is first in `allRules` so
    // first-match-wins returns it. Source-tag must be `@user` — the
    // evaluator keys source-lookup by Rule object identity, not name,
    // so the plugin rule's presence in the list never contaminates
    // the user rule's tag.
    const pluginRule: Rule = {
      name: "same",
      tool: "bash",
      command: "git",
      reason: "plugin",
    };
    const userRule: Rule = {
      name: "same",
      tool: "bash",
      command: "git",
      reason: "user",
    };
    const plugin: Plugin = { name: "p", rules: [pluginRule] };
    const evaluator = buildEvaluator(
      { rules: [userRule] },
      resolve([plugin]),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res!.reason!,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:same@user\\]`,
      ),
    );
    assert.match(res!.reason!, /user/); // pins which reason text won
  });

  it("disabled plugin rule + user rule with same name → @user still wins (G4)", async () => {
    // Plugin rule is filtered out by `resolvePlugins(... { disable })`.
    // The user rule remains — source tag `@user`.
    const pluginRule: Rule = {
      name: "same",
      tool: "bash",
      command: "git",
      reason: "plugin",
    };
    const userRule: Rule = {
      name: "same",
      tool: "bash",
      command: "git",
      reason: "user",
    };
    const plugin: Plugin = { name: "p", rules: [pluginRule] };
    const cfg: SteeringConfig = {
      rules: [userRule],
      disabledRules: ["same"],
    };
    // resolvePlugins honors config.disabledRules for plugin rules.
    // User rules come through `config.rules` directly — buildEvaluator
    // does NOT filter them on `disabledRules`, so the user rule survives.
    const evaluator = buildEvaluator(
      cfg,
      resolvePlugins([plugin], cfg),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res!.reason!,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:same@user\\]`,
      ),
    );
  });

  it("plugin-vs-plugin collision — surviving rule tags with the winning plugin name (G4)", async () => {
    // First-registered plugin wins on name collision (merger emits a
    // soft `rule-collision` warning). Source tag must be the winning
    // plugin's name.
    const p1: Plugin = {
      name: "first",
      rules: [
        {
          name: "dup",
          tool: "bash",
          command: "git",
          reason: "first",
        },
      ],
    };
    const p2: Plugin = {
      name: "second",
      rules: [
        {
          name: "dup",
          tool: "bash",
          command: "git",
          reason: "second",
        },
      ],
    };
    // `resolvePlugins` warns on rule-name collision; swallow the
    // warning output so the test's stdout stays clean.
    const origWarn = console.warn;
    console.warn = () => {};
    let resolved: ResolvedPluginState;
    try {
      resolved = resolvePlugins([p1, p2], {});
    } finally {
      console.warn = origWarn;
    }
    const evaluator = buildEvaluator({}, resolved, makeHost());
    const res = await evaluator.evaluate(
      bashEvent("git push"),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res!.reason!,
      new RegExp(
        `^${escapeRegExp(BLOCK_REASON_PREAMBLE)}\n\n\\[steering:dup@first\\]`,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// PredicateToolInput bash-only fields: basename + args
// ---------------------------------------------------------------------------

describe("buildEvaluator: PredicateToolInput.basename + args", () => {
  it("bash refs populate basename and args (Word[]) per extracted ref", async () => {
    const seen: PredicateContext[] = [];
    const rule: Rule = {
      name: "peek",
      tool: "bash",
      command: "git",
      reason: "peek",
      when: {
        condition: (ctx) => {
          seen.push(ctx);
          return false; // never fires; only capture the ctx
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    await evaluator.evaluate(
      bashEvent("git commit -m 'conventional: subject'"),
      makeCtx("/r"),
      0,
    );
    assert.equal(seen.length, 1);
    const input = seen[0]!.input as {
      tool: "bash";
      command?: string;
      basename?: string;
      args?: ReadonlyArray<{ value?: string; text?: string }>;
    };
    assert.equal(input.basename, "git");
    assert.ok(Array.isArray(input.args));
    assert.equal(input.args!.length, 3);
    // First suffix word = "commit", second = "-m", third = the quoted msg
    assert.equal(input.args![0]!.value ?? input.args![0]!.text, "commit");
    assert.equal(input.args![1]!.value ?? input.args![1]!.text, "-m");
    // Quote-aware: the Word[] preserves the unquoted lexical value
    // rather than munging it into the whitespace-split `command`.
    assert.equal(
      input.args![2]!.value ?? input.args![2]!.text,
      "conventional: subject",
    );
  });

  it("multiple refs each get their own basename + args", async () => {
    const seen: Array<{
      basename?: string | undefined;
      args?: readonly unknown[] | undefined;
    }> = [];
    const rule: Rule = {
      name: "multi",
      tool: "bash",
      command: ["git", "ls"],
      reason: "multi",
      when: {
        condition: (ctx) => {
          const i = ctx.input as {
            basename?: string;
            args?: readonly unknown[];
          };
          seen.push({ basename: i.basename, args: i.args });
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    await evaluator.evaluate(bashEvent("git push && ls -la"), makeCtx("/r"), 0);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.basename, "git");
    assert.equal(seen[1]!.basename, "ls");
    assert.equal(seen[0]!.args!.length, 1);
    assert.equal(seen[1]!.args!.length, 1);
  });

  it("write / edit rules leave basename + args undefined", async () => {
    const seenWrite: PredicateContext[] = [];
    const seenEdit: PredicateContext[] = [];
    const writeRule: Rule = {
      name: "w",
      tool: "write",
      field: "content",
      pattern: /./,
      reason: "w",
      when: {
        condition: (ctx) => {
          seenWrite.push(ctx);
          return false;
        },
      },
    };
    const editRule: Rule = {
      name: "e",
      tool: "edit",
      field: "content",
      pattern: /./,
      reason: "e",
      when: {
        condition: (ctx) => {
          seenEdit.push(ctx);
          return false;
        },
      },
    };
    const evaluator = buildEvaluator(
      { rules: [writeRule, editRule] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      {
        type: "tool_call",
        toolName: "write",
        input: { path: "/tmp/x", content: "hi" },
      } as unknown as ToolCallEvent,
      makeCtx("/r"),
      0,
    );
    await evaluator.evaluate(
      {
        type: "tool_call",
        toolName: "edit",
        input: {
          path: "/tmp/x",
          edits: [{ oldText: "a", newText: "b" }],
        },
      } as unknown as ToolCallEvent,
      makeCtx("/r"),
      0,
    );
    assert.equal(seenWrite.length, 1);
    assert.equal(seenEdit.length, 1);
    const w = seenWrite[0]!.input as {
      basename?: string;
      args?: readonly unknown[];
    };
    const e = seenEdit[0]!.input as {
      basename?: string;
      args?: readonly unknown[];
    };
    assert.equal(w.basename, undefined);
    assert.equal(w.args, undefined);
    assert.equal(e.basename, undefined);
    assert.equal(e.args, undefined);
  });

  it("wrapper-expanded refs get their INNER basename + args (G8)", async () => {
    // sh -c 'git commit -m hi' — the outer wrapper ref is `sh`, but
    // the walker expands the inner command. The INNER ref must see
    // basename="git" + quote-aware args [commit, -m, hi], not stay
    // parsed as sh's arguments.
    const seen: Array<{
      basename?: string | undefined;
      args?: readonly unknown[] | undefined;
    }> = [];
    const rule: Rule = {
      name: "peek",
      tool: "bash",
      command: "git",
      reason: "peek",
      when: {
        condition: (ctx) => {
          const i = ctx.input as {
            basename?: string;
            args?: readonly unknown[];
          };
          seen.push({ basename: i.basename, args: i.args });
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    await evaluator.evaluate(
      bashEvent("sh -c 'git commit -m hi'"),
      makeCtx("/r"),
      0,
    );
    // After wrapper expansion we expect the inner git ref to be
    // present with its own basename / args (the outer sh ref may or
    // may not still be in `seen` depending on the walker's
    // expansion strategy — what matters is that the inner ref's
    // basename + args are exposed).
    const git = seen.find((s) => s.basename === "git");
    assert.ok(git, "expected a git ref after wrapper expansion");
    assert.equal(git!.args!.length, 3);
    const argValues = (
      git!.args as ReadonlyArray<{ value?: string; text?: string }>
    ).map((w) => w.value ?? w.text);
    assert.deepEqual(argValues, ["commit", "-m", "hi"]);
  });

  it("absolute-path command has basename stripped (G8)", async () => {
    // ADR §9: /usr/bin/git push → basename "git", args [push].
    const seen: Array<{
      basename?: string | undefined;
      args?: readonly unknown[] | undefined;
    }> = [];
    const rule: Rule = {
      name: "peek",
      tool: "bash",
      command: "git",
      reason: "peek",
      when: {
        condition: (ctx) => {
          const i = ctx.input as {
            basename?: string;
            args?: readonly unknown[];
          };
          seen.push({ basename: i.basename, args: i.args });
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    await evaluator.evaluate(bashEvent("/usr/bin/git push"), makeCtx("/r"), 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.basename, "git");
    assert.equal(seen[0]!.args!.length, 1);
    const argValues = (
      seen[0]!.args as ReadonlyArray<{ value?: string; text?: string }>
    ).map((w) => w.value ?? w.text);
    assert.deepEqual(argValues, ["push"]);
  });
});

// ---------------------------------------------------------------------------
// PredicateToolInput bash-only field: envAssignments (Phase 1a / I1)
// ---------------------------------------------------------------------------

describe("buildEvaluator: PredicateToolInput.envAssignments", () => {
  function captureInput(seen: PredicateContext[]): Rule {
    return {
      name: "peek-env",
      tool: "bash",
      command: ["git", "aws", "run-me", "sudo"],
      reason: "peek-env",
      when: {
        condition: (ctx) => {
          seen.push(ctx);
          return false;
        },
      },
    };
  }

  it("bash with no env prefix → envAssignments is []", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInput(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(bashEvent("git status"), makeCtx("/r"), 0);
    assert.equal(seen.length, 1);
    const input = seen[0]!.input;
    assert.ok(Array.isArray(input.envAssignments));
    assert.equal(input.envAssignments!.length, 0);
  });

  it("bash with one env prefix AWS_PROFILE=dev → envAssignments has that word", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInput(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent("AWS_PROFILE=dev aws s3 ls"),
      makeCtx("/r"),
      0,
    );
    assert.equal(seen.length, 1);
    const input = seen[0]!.input;
    assert.ok(Array.isArray(input.envAssignments));
    assert.equal(input.envAssignments!.length, 1);
    assert.equal(input.envAssignments![0]!.text, "AWS_PROFILE=dev");
    // args should NOT include the env assignment — only the suffix.
    assert.equal(input.basename, "aws");
    const argVals = (
      input.args as ReadonlyArray<{ value?: string; text?: string }>
    ).map((w) => w.value ?? w.text);
    assert.deepEqual(argVals, ["s3", "ls"]);
  });

  it("bash with multiple env prefixes A=1 B=2 → envAssignments preserves order", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInput(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(bashEvent("A=1 B=2 run-me"), makeCtx("/r"), 0);
    assert.equal(seen.length, 1);
    const input = seen[0]!.input;
    assert.equal(input.envAssignments!.length, 2);
    assert.equal(input.envAssignments![0]!.text, "A=1");
    assert.equal(input.envAssignments![1]!.text, "B=2");
  });

  it("wrapper's own shell prefix stays on the outer ref (A=1 sudo cmd)", async () => {
    // `A=1 sudo aws s3 ls` — the shell-level prefix `A=1` belongs to
    // `sudo` (that's where the shell binds env assignments). After
    // wrapper expansion the walker surfaces both the outer `sudo` ref
    // AND an inner `aws` ref; envAssignments must reflect the scoping
    // the shell does — i.e. `A=1` on the outer ref, not smuggled onto
    // the inner ref.
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInput(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(bashEvent("A=1 sudo aws s3 ls"), makeCtx("/r"), 0);
    const sudoInput = seen
      .map((s) => s.input)
      .find((i) => i.basename === "sudo");
    const awsInput = seen.map((s) => s.input).find((i) => i.basename === "aws");
    assert.ok(sudoInput, "expected a sudo ref");
    assert.ok(awsInput, "expected an aws ref after wrapper expansion");
    assert.deepEqual(
      sudoInput.envAssignments!.map((w) => w.text),
      ["A=1"],
    );
    // Inner ref gets its own (empty) prefix — the walker does not
    // smuggle the outer's shell prefix down to the inner ref.
    assert.deepEqual(
      awsInput.envAssignments!.map((w) => w.text),
      [],
    );
  });

  it("dynamic value A=$VAR is preserved verbatim in the Word.text", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInput(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(bashEvent("A=$VAR run-me"), makeCtx("/r"), 0);
    assert.equal(seen.length, 1);
    const input = seen[0]!.input;
    assert.equal(input.envAssignments!.length, 1);
    assert.equal(input.envAssignments![0]!.text, "A=$VAR");
  });

  it("write tool → envAssignments is []", async () => {
    const seen: PredicateContext[] = [];
    const rule: Rule = {
      name: "w",
      tool: "write",
      field: "content",
      pattern: /./,
      reason: "w",
      when: {
        condition: (ctx) => {
          seen.push(ctx);
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    await evaluator.evaluate(writeEvent("/tmp/x", "hi"), makeCtx("/r"), 0);
    assert.equal(seen.length, 1);
    assert.ok(Array.isArray(seen[0]!.input.envAssignments));
    assert.equal(seen[0]!.input.envAssignments!.length, 0);
  });

  it("edit tool → envAssignments is []", async () => {
    const seen: PredicateContext[] = [];
    const rule: Rule = {
      name: "e",
      tool: "edit",
      field: "content",
      pattern: /./,
      reason: "e",
      when: {
        condition: (ctx) => {
          seen.push(ctx);
          return false;
        },
      },
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    await evaluator.evaluate(
      editEvent("/tmp/x", [{ oldText: "a", newText: "b" }]),
      makeCtx("/r"),
      0,
    );
    assert.equal(seen.length, 1);
    assert.ok(Array.isArray(seen[0]!.input.envAssignments));
    assert.equal(seen[0]!.input.envAssignments!.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildEvaluator: PredicateContext.walkerState.env (Tier B end-to-end)
// ---------------------------------------------------------------------------

describe("buildEvaluator: PredicateContext.walkerState.env", () => {
  function envCapture(seen: PredicateContext[]): Rule {
    return {
      name: "peek-env",
      tool: "bash",
      command: ["cmd", "git"],
      reason: "peek-env",
      when: {
        condition: (ctx) => {
          seen.push(ctx);
          return false; // never block; we only want to observe ctx
        },
      },
    };
  }

  it("bare assignment earlier in chain surfaces in walkerState.env on the later ref's condition", async () => {
    // End-to-end evidence that envTracker + walker + buildEvaluator wire
    // the env snapshot through to PredicateContext for predicates
    // (not just the testing mockContext harness).
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [envCapture(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(bashEvent('WS="/ws"; cmd'), makeCtx("/r"), 0);
    // The condition fires against every extracted ref; the `cmd` ref is
    // the one whose walker-state reflects the threaded env from WS="/ws".
    const cmdCtx = seen.find(
      (c) => c.input.tool === "bash" && c.input.basename === "cmd",
    );
    assert.ok(cmdCtx, "cmd ref should have fired the condition");
    assert.ok(cmdCtx.walkerState, "walkerState should be populated");
    assert.ok(cmdCtx.walkerState.env instanceof Map);
    assert.equal(
      (cmdCtx.walkerState.env as ReadonlyMap<string, string>).get("WS"),
      "/ws",
    );
  });

  it("walkerState.env is an empty map when no env-modifying commands ran", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [envCapture(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(bashEvent("git status"), makeCtx("/r"), 0);
    assert.equal(seen.length, 1);
    const firstCtx = seen[0];
    assert.ok(firstCtx);
    assert.ok(firstCtx.walkerState, "walkerState should be populated");
    const env = firstCtx.walkerState.env as ReadonlyMap<string, string>;
    assert.ok(env instanceof Map);
    // Seeded from process.env at module load — may contain HOME/USER/PWD.
    // Assertion: does NOT contain names that were never assigned.
    assert.equal(env.get("WS"), undefined);
    assert.equal(env.get("SOMETHING_UNSET"), undefined);
  });
});

// ---------------------------------------------------------------------------
// S1: top-level engine fail-closed + per-predicate isolation coverage
// ---------------------------------------------------------------------------

describe("buildEvaluator: top-level engine failures (S1)", () => {
  it("returns an engine-error block when evaluator scaffolding throws", async () => {
    // Force the engine scaffolding to throw by handing it a ctx whose
    // `cwd` getter throws — createExecCache dereferences `ctx.cwd`
    // SYNCHRONOUSLY at the top of evaluateEventInner, so the throw lands
    // in the outer try/catch (not the per-rule one).
    const rule: Rule = {
      name: "irrelevant",
      tool: "bash",
      command: "git",
      reason: "n/a",
    };
    const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
    const boomCtx = {
      get cwd(): string {
        throw new Error("boom: ctx.cwd read failed");
      },
      sessionManager: {
        getEntries: () => [],
      } as unknown as ReturnType<typeof makeCtx>["sessionManager"],
    } as unknown as ReturnType<typeof makeCtx>;

    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const result = await evaluator.evaluate(
        bashEvent("git status"),
        boomCtx,
        0,
      );
      // Fail-closed: return a block with the engine@internal tag so
      // the LLM sees it's an engine-level failure, not a rule match.
      assert.ok(result && result.block === true);
      assert.ok(
        result.reason?.startsWith(
          `${ENGINE_ERROR_PREAMBLE}\n\n[steering:engine@internal]`,
        ),
        `expected engine-error preamble + engine@internal tag; got: ${result.reason}`,
      );
      assert.ok(
        /safety measure/.test(result.reason ?? ""),
        `expected safety-measure phrasing; got: ${result.reason}`,
      );
      assert.ok(
        errors.some((e) =>
          /steering engine threw.*boom: ctx\.cwd read failed/.test(e),
        ),
        `no matching console.error in:\n${errors.join("\n")}`,
      );
    } finally {
      console.error = originalError;
    }
  });

  it("a throwing condition: fires the rule fail-CLOSED with no leaked error message", async () => {
    // Rule A's `condition:` throws. Under the symmetric outer/inner
    // `condition:` throw treatment, the throw is caught locally and
    // projected via the leaf-level `onUnknown:` policy (default
    // `"block"` — fail-CLOSED). Rule A fires; the secret in the
    // thrown error message is NOT in the block reason (the warning
    // log carries it for operators, but the LLM-facing reason uses
    // the rule's static `reason:` text).
    //
    // Mirrors the plugin-handler exception contract in
    // {@link evaluateLeafTrinary}; the inner not-block branch in
    // {@link evaluateNotBlock} applies the same treatment for
    // `condition:` inside `not:`.
    const ruleA: Rule = {
      name: "a-throws",
      tool: "bash",
      command: "git",
      reason: "a-throws",
      when: {
        condition: () => {
          throw new Error("leaked secret: db-password=hunter2");
        },
      },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        { rules: [ruleA] },
        resolve(),
        makeHost(),
      );
      const result = await evaluator.evaluate(
        bashEvent("git push"),
        makeCtx("/r"),
        0,
      );
      // Rule A fires fail-CLOSED.
      assert.ok(result && result.block === true);
      assert.ok(
        /\[steering:a-throws@user\]/.test(result.reason ?? ""),
        `expected a-throws reason; got: ${result.reason}`,
      );
      // The secret from the error message is NOT in the block reason
      // (rule's static `reason:` is what reaches the LLM). The warning
      // log carries it for operators.
      assert.ok(
        !/hunter2/.test(result.reason ?? ""),
        `block reason leaked the error message: ${result.reason}`,
      );
      assert.ok(
        warnings.some((w) =>
          /Rule "a-throws"@user.*when\.condition threw.*hunter2/.test(w),
        ),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it("surfaces the plugin source in BOTH the warning channel and the block-reason tag", async () => {
    // Plugin rule's `condition:` throws — caught locally,
    // projected via the default `"block"` policy (outer `condition:`
    // has no leaf-level `onUnknown:` opt-in), rule fires fail-CLOSED.
    // Both the LLM-facing block reason AND the operator-facing warning
    // log carry the `@<plugin-name>` source tag, matching the S1
    // wrapper format `predicate threw for rule "<name>"@<source>` in
    // {@link runPredicateChain} and the plugin-handler exception
    // channel in {@link evaluateLeafTrinary}. Operators can grep
    // either channel by source tag to triage plugin-introduced bugs.
    const pluginRule: Rule = {
      name: "bad-plugin-rule",
      tool: "bash",
      command: "anything",
      reason: "bad",
      when: {
        condition: () => {
          throw new Error("plugin predicate bug");
        },
      },
    };
    const plugin: Plugin = {
      name: "my-plugin",
      rules: [pluginRule],
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator({}, resolve([plugin]), makeHost());
      const result = await evaluator.evaluate(
        bashEvent("anything"),
        makeCtx("/r"),
        0,
      );
      // Block-reason channel: source-tagged with plugin name.
      assert.ok(result && result.block === true);
      assert.ok(
        /\[steering:bad-plugin-rule@my-plugin\]/.test(result.reason ?? ""),
        `expected plugin-source tag in block reason; got: ${result.reason}`,
      );
      // Warning channel: same `@<plugin-name>` tag, anchored.
      assert.ok(
        warnings.some((w) =>
          /Rule "bad-plugin-rule"@my-plugin.*when\.condition threw.*plugin predicate bug/.test(
            w,
          ),
        ),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// S3: name validation (user-authored rules via buildEvaluator)
// ---------------------------------------------------------------------------

describe("buildEvaluator: user rule-name validation (S3)", () => {
  it("throws when a user-authored rule name contains disallowed chars", () => {
    const rule: Rule = {
      name: "phony] ALL CLEAR [real",
      tool: "bash",
      command: "git",
      reason: "bad",
    };
    assert.throws(
      () => buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
      /rule name "phony\] ALL CLEAR \[real".*disallowed/,
    );
  });

  it("accepts rule names with digits, dashes, underscores", () => {
    const rule: Rule = {
      name: "2026-critical_rule",
      tool: "bash",
      command: "git",
      reason: "ok",
    };
    assert.doesNotThrow(() =>
      buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
    );
  });
});

describe("buildEvaluator: when.missing.notIn (scope subtraction)", () => {
  const sessionEntry = (
    customType: string,
    data: Record<string, unknown>,
    ts = "2026-01-01T00:00:00.000Z",
    id = "e1",
  ) => ({
    type: "custom" as const,
    customType,
    data,
    timestamp: ts,
    id,
    parentId: null,
  });

  const DESC_READ_EVENT = "desc-read" as const;

  const descObserver: Observer = {
    name: "desc-reader",
    writes: [DESC_READ_EVENT],
    watch: {
      toolName: "bash",
      inputMatches: { command: /^diff\b/ },
      exitCode: "success",
    },
    onResult: () => {},
  };

  const descCheck: Rule = {
    name: "cr-desc-check",
    tool: "bash",
    command: "cr",
    reason: "diff first, in a prior tool_call",
    when: {
      missing: {
        event: DESC_READ_EVENT,
        in: "agent_loop",
        notIn: "tool_call",
      },
    },
  };

  // ----- Group 1: primary use case (agent_loop \ tool_call) -----

  it("fires when no real entries exist in current agent_loop", async () => {
    const evaluator = buildEvaluator(
      { rules: [descCheck], observers: [descObserver] },
      resolve(),
      makeHost(),
    );
    const fires = await evaluator.evaluate(
      bashEvent("cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(fires, "no diff in any prior tool_call → rule fires");
  });

  it("allows when event is present in a prior tool_call in same agent loop", async () => {
    const evaluator = buildEvaluator(
      { rules: [descCheck], observers: [descObserver] },
      resolve(),
      makeHost(),
    );
    const ctx = makeCtx("/r", [
      sessionEntry(DESC_READ_EVENT, { _agentLoopIndex: 5 }),
    ]);
    const skips = await evaluator.evaluate(bashEvent("cr --review"), ctx, 5);
    assert.equal(skips, undefined, "real entry present → rule passes");
  });

  it("blocks same-tool_call same-tool_call speculative bypass (diff && cr)", async () => {
    // WITHOUT `notIn: "tool_call"`, the chain would allow via
    // speculative synthesis. WITH the subtraction, speculative
    // entries are excluded and the rule fires.
    const evaluator = buildEvaluator(
      { rules: [descCheck], observers: [descObserver] },
      resolve(),
      makeHost(),
    );
    const fires = await evaluator.evaluate(
      bashEvent("diff && cr --review"),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      fires,
      "same-tool_call speculative entries don't count under notIn:tool_call",
    );
  });

  it("fires when only entries from a PRIOR agent loop exist", async () => {
    const evaluator = buildEvaluator(
      { rules: [descCheck], observers: [descObserver] },
      resolve(),
      makeHost(),
    );
    const ctx = makeCtx("/r", [
      sessionEntry(DESC_READ_EVENT, { _agentLoopIndex: 3 }),
    ]);
    const fires = await evaluator.evaluate(bashEvent("cr --review"), ctx, 5);
    assert.ok(
      fires,
      "real entry from loop 3 != ctx.agentLoopIndex 5 → rule fires",
    );
  });

  // ----- Group 2: session \ agent_loop (prior-loop filter) -----

  const priorLoopRule: Rule = {
    name: "prior-loop-needed",
    tool: "bash",
    command: "cr",
    reason: "must have been recorded in a prior loop",
    when: {
      missing: {
        event: DESC_READ_EVENT,
        in: "session",
        notIn: "agent_loop",
      },
    },
  };

  it("session \\ agent_loop: fires when event only in current agent_loop", async () => {
    const evaluator = buildEvaluator(
      { rules: [priorLoopRule] },
      resolve(),
      makeHost(),
    );
    const ctx = makeCtx("/r", [
      sessionEntry(DESC_READ_EVENT, { _agentLoopIndex: 5 }),
    ]);
    const fires = await evaluator.evaluate(bashEvent("cr --review"), ctx, 5);
    assert.ok(fires, "current-loop entries subtracted → empty → rule fires");
  });

  it("session \\ agent_loop: allows when event from PRIOR agent_loop", async () => {
    const evaluator = buildEvaluator(
      { rules: [priorLoopRule] },
      resolve(),
      makeHost(),
    );
    const ctx = makeCtx("/r", [
      sessionEntry(DESC_READ_EVENT, { _agentLoopIndex: 3 }),
    ]);
    const skips = await evaluator.evaluate(bashEvent("cr --review"), ctx, 5);
    assert.equal(
      skips,
      undefined,
      "prior-loop real entry present → rule passes",
    );
  });

  // ----- Group 3: since interaction -----

  it("notIn:tool_call with since: real event + real invalidator behave correctly", async () => {
    const INVAL = "invalidator";
    const ruleWithSince: Rule = {
      name: "cr-desc-check-since",
      tool: "bash",
      command: "cr",
      reason: "stale after invalidator",
      when: {
        missing: {
          event: DESC_READ_EVENT,
          in: "agent_loop",
          since: INVAL,
          notIn: "tool_call",
        },
      },
    };
    // Event BEFORE invalidator: event stale → rule fires.
    const ctxStale = makeCtx("/r", [
      sessionEntry(
        DESC_READ_EVENT,
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:00.000Z",
        "e1",
      ),
      sessionEntry(
        INVAL,
        { _agentLoopIndex: 5 },
        "2026-01-01T00:00:05.000Z",
        "i1",
      ),
    ]);
    const ev = buildEvaluator(
      { rules: [ruleWithSince] },
      resolve(),
      makeHost(),
    );
    const fires = await ev.evaluate(bashEvent("cr --review"), ctxStale, 5);
    assert.ok(fires, "event older than invalidator → stale → rule fires");
  });

  // ----- Group 4: invalid-shape runtime errors -----
  // Errors thrown inside predicate evaluation are caught by the
  // evaluator's per-rule try/catch (so the LLM never sees them).
  // Tests capture the console.warn to verify the error was surfaced.

  const mkBadRule = (notIn: unknown): Rule =>
    ({
      name: "bad-rule",
      tool: "bash",
      command: "cr",
      reason: "x",
      when: {
        missing: {
          event: DESC_READ_EVENT,
          in: "agent_loop",
          notIn: notIn as never,
        },
      },
    }) as Rule;

  async function assertWarnMatches(rule: Rule, pattern: RegExp): Promise<void> {
    const warnings = captureWarnings();
    try {
      const ev = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
      const res = await ev.evaluate(bashEvent("cr --review"), makeCtx("/r"), 5);
      assert.equal(
        res,
        undefined,
        "predicate threw → rule does not fire (fail-open)",
      );
      assert.ok(
        warnings.some((w) => pattern.test(w)),
        `no warning matched ${pattern} in:\n${warnings.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  }

  it("throws when notIn is a superset of in", async () => {
    // in: agent_loop, notIn: session → session ⊃ agent_loop → error.
    await assertWarnMatches(mkBadRule("session"), /superset/);
  });

  it("throws when notIn is identical to in", async () => {
    await assertWarnMatches(mkBadRule("agent_loop"), /identical/);
  });

  it('treats legacy "turn" as unknown-scope inside notIn', async () => {
    await assertWarnMatches(
      mkBadRule("turn"),
      /when\.missing\.notIn must be.*"agent_loop", "session", or "tool_call"/,
    );
  });

  it("throws when notIn is a non-string (e.g. JSON config passes an object)", async () => {
    // Pre-v0.1.0 the shape was `not: { in: "tool_call" }` (nested
    // object). Authors passing that shape get a clear error.
    await assertWarnMatches(
      mkBadRule({ in: "tool_call" }),
      /when\.missing\.notIn must be.*"agent_loop", "session", or "tool_call"/,
    );
  });
});

// Keep `Observer` import referenced — downstream tests in
// observer-dispatcher.test.ts exercise it directly; keeping the symbol
// used here avoids "unused import" diagnostics if this file is refactored.
const _obsTypeKeepalive = null as unknown as Observer | null;
void _obsTypeKeepalive;
// And pull in ToolCallEvent for the narrow type echo below so unused-
// import linting stays green even if test helpers are slimmed.
const _eventTypeKeepalive = null as unknown as ToolCallEvent | null;
void _eventTypeKeepalive;

// ---------------------------------------------------------------------------
// Exemption registry (issue #26)
// ---------------------------------------------------------------------------

describe("buildEvaluator: exemption registry", () => {
  const COMMIT_RULE: Rule = {
    name: "no-main-commit",
    tool: "bash",
    command: "git",
    reason: "no commit",
    when: { subcommand: "commit" },
  };

  it("exempted rule does not fire; evaluation continues to the next rule", async () => {
    const pushRule: Rule = {
      name: "no-push",
      tool: "bash",
      command: "git",
      reason: "no push",
      when: { subcommand: "push" },
    };
    const evaluator = buildEvaluator(
      {
        rules: [COMMIT_RULE, pushRule],
        exemptions: [{ rule: "no-main-commit", when: { cwd: "/vault/" } }],
      },
      resolve(),
      makeHost(),
    );
    // Exempt cwd: the commit rule does not fire — and evaluation
    // continues, so the push rule can still block its own commands.
    const exempt = await evaluator.evaluate(
      bashEvent("cd /vault/notes && git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(exempt, undefined);
    const nextRuleBlocks = await evaluator.evaluate(
      bashEvent("git push origin main"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(nextRuleBlocks && nextRuleBlocks.block === true);
    assert.match((nextRuleBlocks as { reason: string }).reason, /no-push/);
    // Non-exempt cwd: the rule still blocks.
    const stillBlocks = await evaluator.evaluate(
      bashEvent("cd /work && git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(stillBlocks && stillBlocks.block === true);
    assert.match((stillBlocks as { reason: string }).reason, /no-main-commit/);
  });

  it("multiple exemptions for the same rule are OR-ed (any match exempts)", async () => {
    const evaluator = buildEvaluator(
      {
        rules: [COMMIT_RULE],
        exemptions: [
          { rule: "no-main-commit", when: { cwd: "/a/" } },
          { rule: "no-main-commit", when: { cwd: "/b/" } },
        ],
      },
      resolve(),
      makeHost(),
    );
    assert.equal(
      await evaluator.evaluate(
        bashEvent("cd /b/x && git commit -m x"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
      "second exemption clause matches -> exempt",
    );
    const blocks = await evaluator.evaluate(
      bashEvent("cd /c/x && git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(blocks, "neither clause matches -> still blocks");
  });

  it("walker-unknown cwd does NOT exempt (fail-closed allow-default projection)", async () => {
    const evaluator = buildEvaluator(
      {
        rules: [COMMIT_RULE],
        exemptions: [{ rule: "no-main-commit", when: { cwd: "/vault/" } }],
      },
      resolve(),
      makeHost(),
    );
    // `cd $(pwd)` is statically intractable — the walker emits the
    // cwdTracker's `unknown` sentinel. The exemption clause projects
    // unknown via the "allow"-default (unknown -> false -> no match),
    // so the guard still fires. With the stock rule-side "block"
    // default this would silently fail-OPEN the guard.
    const res = await evaluator.evaluate(
      bashEvent("cd $(pwd) && git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match((res as { reason: string }).reason, /no-main-commit/);
  });

  it("explicit onUnknown:'block' smuggled into an exemption clause is IGNORED (strict — unknown never exempts)", async () => {
    // STRICT fail-closed (design review: NO escape hatch). The
    // exemption evaluation path passes `ignoreExplicitModifiers: true`
    // so even an `as any`-smuggled `onUnknown: "block"` projects
    // unknown to "does not match" — the guard still fires.
    //
    // Pinned here directly against `evaluateWhen` (not end-to-end)
    // because `validateExemptionWhenClauseShape` rejects the smuggled
    // clause at load time — this is the defense-in-depth level 3
    // (evaluation ignores explicit modifiers regardless).
    const clause = {
      cwd: { pattern: "/vault/", onUnknown: "block" },
    } as unknown as TopLevelWhenClause<string>;
    // Exemption flags: "allow"-default projection + explicit
    // modifiers ignored → unknown must NOT match.
    assert.equal(
      await evaluateWhen(
        clause,
        { cwd: "unknown" },
        {} as unknown as PredicateContext,
        {},
        "no-main-commit",
        "exemption",
        "allow",
        true,
      ),
      false,
      "explicit onUnknown:'block' must NOT turn unknown into a match under exemption evaluation (hard allow projection)",
    );
    // Rule path unchanged: the SAME clause with rule-side defaults
    // ("block" default + explicit modifiers honored) still projects
    // unknown to match — rules keep today's onUnknown semantics
    // byte-identical; the strict flag only affects exemption eval.
    assert.equal(
      await evaluateWhen(
        clause,
        { cwd: "unknown" },
        {} as unknown as PredicateContext,
        {},
        "no-main-commit",
        "user",
      ),
      true,
      "rule-path onUnknown:'block' must still project unknown to match (rule behavior unchanged)",
    );
  });

  it("exemption when with a top-level onUnknown is REJECTED at load (as any)", () => {
    assert.throws(
      () =>
        buildEvaluator(
          {
            rules: [COMMIT_RULE],
            exemptions: [
              {
                rule: "no-main-commit",
                when: {
                  cwd: "/vault/",
                  onUnknown: "block",
                } as unknown as TopLevelWhenClause<string>,
              },
            ],
          },
          resolve(),
          makeHost(),
        ),
      /exemption for rule "no-main-commit".*onUnknown/,
    );
  });

  it("exemption when with onUnknown inside not: is REJECTED at load (as any)", () => {
    assert.throws(
      () =>
        buildEvaluator(
          {
            rules: [COMMIT_RULE],
            exemptions: [
              {
                rule: "no-main-commit",
                when: {
                  not: { cwd: "/vault/", onUnknown: "block" },
                } as unknown as TopLevelWhenClause<string>,
              },
            ],
          },
          resolve(),
          makeHost(),
        ),
      /exemption for rule "no-main-commit".*onUnknown/,
    );
  });

  it("exemption when with onUnknown in a leaf object form (cwd { pattern, onUnknown }) is REJECTED at load (as any)", () => {
    assert.throws(
      () =>
        buildEvaluator(
          {
            rules: [COMMIT_RULE],
            exemptions: [
              {
                rule: "no-main-commit",
                when: {
                  cwd: { pattern: "/vault/", onUnknown: "block" },
                } as unknown as TopLevelWhenClause<string>,
              },
            ],
          },
          resolve(),
          makeHost(),
        ),
      /exemption for rule "no-main-commit".*onUnknown/,
    );
  });

  it("a throwing exemption condition does not exempt (S1); warn labels the exemption", async () => {
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        {
          rules: [COMMIT_RULE],
          exemptions: [
            {
              rule: "no-main-commit",
              when: {
                condition: () => {
                  throw new Error("boom");
                },
              },
            },
          ],
        },
        resolve(),
        makeHost(),
      );
      const res = await evaluator.evaluate(
        bashEvent("git commit -m x"),
        makeCtx("/repo"),
        0,
      );
      assert.ok(res && res.block === true, "guard still fires");
      // `condition:` throws are swallowed INSIDE evaluateWhen with
      // the source tag set to "exemption" — the warn labels the
      // exemption context, not a rule source like `@git` / `@user`.
      assert.ok(
        warnings.some((w) => /@exemption: when\.condition threw/.test(w)),
        `expected a warn log labelling the exemption, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it("an exemption whose predicate throws does not exempt (per-exemption catch)", async () => {
    // Unknown KEYS never reach the exemption catch anymore (issue #75
    // layer 1 rejects them at load); the per-exemption catch still
    // guards THROWING handlers — pinned here with a registered
    // predicate that throws.
    const throwingPlugin: Plugin = {
      name: "throwing",
      predicates: {
        alwaysThrows: () => {
          throw new Error("boom");
        },
      },
    };
    const warnings = captureWarnings();
    try {
      const evaluator = buildEvaluator(
        {
          rules: [COMMIT_RULE],
          exemptions: [
            {
              rule: "no-main-commit",
              when: {
                alwaysThrows: true,
              } as unknown as TopLevelWhenClause<string>,
            },
          ],
        },
        resolve([throwingPlugin]),
        makeHost(),
      );
      const res = await evaluator.evaluate(
        bashEvent("git commit -m x"),
        makeCtx("/repo"),
        0,
      );
      assert.ok(res && res.block === true, "guard still fires");
      assert.ok(
        warnings.some((w) =>
          /Rule "no-main-commit"@exemption: when\.alwaysThrows handler threw/.test(
            w,
          ),
        ),
        `expected a warn log labelling the exemption, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it("plugin-registered predicate exemptions work (isNapkinVault style)", async () => {
    const plugin: Plugin = {
      name: "napkin",
      predicates: {
        isNapkinVault: (args: unknown, ctx: PredicateContext) =>
          typeof args === "boolean" && args === true
            ? ctx.cwd.startsWith("/vault")
            : false,
      },
      exemptions: [
        {
          rule: "no-main-commit",
          when: {
            isNapkinVault: true,
          } as unknown as TopLevelWhenClause<string>,
        },
      ],
    };
    const evaluator = buildEvaluator(
      { plugins: [plugin], rules: [COMMIT_RULE] },
      resolve([plugin]),
      makeHost(),
    );
    assert.equal(
      await evaluator.evaluate(
        bashEvent("cd /vault/goldmine && git commit -m x"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
      "plugin predicate matches -> exempt",
    );
    const blocks = await evaluator.evaluate(
      bashEvent("git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(blocks, "predicate does not match -> still blocks");
  });

  it("config + plugin exemptions stack (accumulation across buckets)", async () => {
    const plugin: Plugin = {
      name: "napkin",
      predicates: {
        isNapkinVault: (_args: unknown, ctx: PredicateContext) =>
          ctx.cwd.startsWith("/vault"),
      },
      exemptions: [
        {
          rule: "no-main-commit",
          when: {
            isNapkinVault: true,
          } as unknown as TopLevelWhenClause<string>,
        },
      ],
    };
    const evaluator = buildEvaluator(
      {
        plugins: [plugin],
        rules: [COMMIT_RULE],
        exemptions: [{ rule: "no-main-commit", when: { cwd: "/scratch/" } }],
      },
      resolve([plugin]),
      makeHost(),
    );
    // Plugin bucket matches.
    assert.equal(
      await evaluator.evaluate(
        bashEvent("cd /vault/goldmine && git commit -m x"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
    );
    // Config bucket matches.
    assert.equal(
      await evaluator.evaluate(
        bashEvent("cd /scratch/tmp && git commit -m x"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
    );
    // Neither matches -> blocks.
    const blocks = await evaluator.evaluate(
      bashEvent("git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(blocks);
  });

  it("exemption wins over an override comment: no block, no audit entry, no onFire", async () => {
    const host = makeHost();
    let onFireRan = false;
    const rule: Rule = {
      ...COMMIT_RULE,
      onFire: () => {
        onFireRan = true;
      },
    };
    const evaluator = buildEvaluator(
      {
        defaultNoOverride: false,
        rules: [rule],
        exemptions: [{ rule: "no-main-commit", when: { cwd: "/vault/" } }],
      },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      bashEvent(
        "cd /vault/x && git commit -m x # steering-override: no-main-commit \u2014 I know",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
    assert.equal(host.appended.length, 0, "no steering-override audit entry");
    assert.equal(onFireRan, false, "onFire must not run for an exempted rule");
    // Same command OUTSIDE the exempt cwd keeps today's behavior:
    // override accepted, audit entry written, no block.
    const res2 = await evaluator.evaluate(
      bashEvent(
        "git commit -m x # steering-override: no-main-commit \u2014 I know",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res2, undefined);
    assert.equal(host.appended.length, 1);
    assert.equal(host.appended[0]!.type, "steering-override");
    assert.equal(onFireRan, false);
  });

  it("missing-leaf exemption: matches when the event is missing (built-in inversion)", async () => {
    const prior = [
      {
        type: "custom" as const,
        customType: "vault-ready",
        data: { _agentLoopIndex: 0 },
        timestamp: "2026-01-01T00:00:00.000Z",
        id: "e1",
        parentId: null,
      },
    ];
    const evaluator = buildEvaluator(
      {
        rules: [COMMIT_RULE],
        exemptions: [
          {
            rule: "no-main-commit",
            when: { missing: { event: "vault-ready", in: "session" } },
          },
        ],
      },
      resolve(),
      makeHost(),
    );
    // No prior entry: `missing` is true (event is missing) ->
    // exemption matches -> no block.
    assert.equal(
      await evaluator.evaluate(
        bashEvent("git commit -m x"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
    );
    // Prior entry present: `missing` is false -> exemption does not
    // match -> rule blocks.
    const blocks = await evaluator.evaluate(
      bashEvent("git commit -m x"),
      makeCtx("/repo", prior),
      0,
    );
    assert.ok(blocks && blocks.block === true);
  });

  it("cross-bucket same-name rule: exemption-by-name applies to BOTH buckets", async () => {
    // `config.rules` and `resolved.rules` are never deduped against
    // each other — a same-named rule can exist in both buckets and
    // exemption-by-name applies to both (documented; no winner
    // assumption).
    const plugin: Plugin = {
      name: "p",
      rules: [
        {
          name: "dup",
          tool: "bash",
          command: "rm",
          reason: "plugin dup",
        },
      ],
    };
    const evaluator = buildEvaluator(
      {
        plugins: [plugin],
        rules: [
          {
            name: "dup",
            tool: "bash",
            command: "git",
            reason: "user dup",
          },
        ],
        exemptions: [{ rule: "dup", when: { cwd: "/vault/" } }],
      },
      resolve([plugin]),
      makeHost(),
    );
    assert.equal(
      await evaluator.evaluate(
        bashEvent("cd /vault/x && git commit -m x"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
      "user-bucket dup exempted",
    );
    assert.equal(
      await evaluator.evaluate(
        bashEvent("cd /vault/x && rm foo"),
        makeCtx("/repo"),
        0,
      ),
      undefined,
      "plugin-bucket dup exempted",
    );
    const blocks = await evaluator.evaluate(
      bashEvent("git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(blocks);
  });

  it("empty exemption when clause is rejected at build time (validateWhenClauseShape)", async () => {
    assert.throws(
      () =>
        buildEvaluator(
          {
            rules: [COMMIT_RULE],
            exemptions: [
              {
                rule: "no-main-commit",
                when: {} as TopLevelWhenClause<string>,
              },
            ],
          },
          resolve(),
          makeHost(),
        ),
      /no predicate leaves/,
    );
  });

  it("exemption target names pass S3 name validation at build time", async () => {
    assert.throws(
      () =>
        buildEvaluator(
          {
            rules: [COMMIT_RULE],
            exemptions: [{ rule: "no main commit", when: { cwd: "/vault/" } }],
          },
          resolve(),
          makeHost(),
        ),
      /contains disallowed characters/,
    );
  });

  it("exemptions are inert when the target rule never fires (disabled-target case)", async () => {
    // An exemption targeting a rule that exists but is disabled is
    // inert and silent: the rule never fires, the exemption never
    // needs to match. No error, no diagnostic — just no block for
    // the disabled rule's commands.
    const host = makeHost();
    const evaluator = buildEvaluator(
      {
        disabledRules: ["no-main-commit"],
        rules: [COMMIT_RULE],
        exemptions: [{ rule: "no-main-commit", when: { cwd: "/vault/" } }],
      },
      resolve(),
      host,
    );
    const res = await evaluator.evaluate(
      bashEvent("cd /vault/x && git commit -m x"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });
});

// ---------------------------------------------------------------------------
// Resolved-by-default Word.text (issue #51) — predicates validate what executes
// ---------------------------------------------------------------------------

describe("buildEvaluator: resolved-by-default Word.text (issue #51)", () => {
  function captureInputRule(seen: PredicateContext[]): Rule {
    return {
      name: "peek-resolved",
      tool: "bash",
      command: ["echo", "gh", "git", "run-me"],
      reason: "peek-resolved",
      when: {
        condition: (ctx) => {
          seen.push(ctx);
          return false; // never fires; only capture the ctx
        },
      },
    };
  }

  /** Narrow a captured ctx's input args to the shape the tests read. */
  function argsOf(
    seen: PredicateContext[],
    basename: string,
  ): ReadonlyArray<{
    text?: string;
    value?: string;
    rawText?: string;
    parts?: ReadonlyArray<{ type: string; text?: string }>;
  }> {
    const input = seen.map((s) => s.input).find((i) => i.basename === basename);
    assert.ok(input, `expected a ${basename} ref`);
    return (input.args ?? []) as ReadonlyArray<{
      text?: string;
      value?: string;
      rawText?: string;
      parts?: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  }

  it("acceptance e2e: chain-assigned BODY + process substitution resolve in args", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent(
        'BODY=/vault/repo/prs/note.md && gh pr create --title "feat: x (closes #12)" --body-file=<(perl -0777 -pe \'<BODY_STRIP>\' "$BODY")',
      ),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "gh");
    assert.equal(args.length, 6);
    // --title: text quote-preserving, value unquoted — both resolved.
    const title = args[3]!;
    assert.equal(title.text, '"feat: x (closes #12)"');
    assert.equal(title.value, "feat: x (closes #12)");
    // --body-file= is its own word (the process substitution parses
    // as a separate word) — static, unchanged.
    assert.equal(args[4]!.text, "--body-file=");
    assert.equal(args[4]!.value, "--body-file=");
    // The process-substitution word: inner $BODY expanded, quotes
    // preserved; value stays the lexical token (fd path unknowable).
    const ps = args[5]!;
    assert.equal(
      ps.text,
      "<(perl -0777 -pe '<BODY_STRIP>' \"/vault/repo/prs/note.md\")",
    );
    assert.equal(ps.value, "<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")");
    assert.equal(ps.rawText, "<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")");
  });

  // Test-local: does the ref's resolved `--title` value contain
  // `closes #N`? Reads `.text` (TEXT-mode resolved surface) so the
  // assertions below pin resolution, not raw source.
  function resolvedTitleCloses(ctx: PredicateContext): boolean {
    const args = ctx.input.args;
    if (!Array.isArray(args)) return false;
    for (let i = 0; i < args.length; i++) {
      if ((args[i]?.value ?? "") === "--title") {
        const next = args[i + 1];
        return /closes #\d+/.test(next?.text ?? "");
      }
    }
    return false;
  }

  it("acceptance e2e: condition fires on the resolved --title value", async () => {
    // The title is written literally, so the condition fires on the
    // resolved args surface (see the chain-assigned variant below for
    // the resolution-dependent case).
    const evaluator = buildEvaluator(
      {
        rules: [
          {
            name: "title-keyword",
            tool: "bash",
            command: "gh",
            reason: "title keyword",
            when: { condition: (ctx) => resolvedTitleCloses(ctx) },
          },
        ],
      },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent(
        'BODY=/vault/repo/prs/note.md && gh pr create --title "feat: x (closes #12)" --body-file=<(perl -0777 -pe \'<BODY_STRIP>\' "$BODY")',
      ),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res!.reason!, /\[steering:title-keyword@user\]/);
  });

  it("rawText exposes the raw source when text is resolved", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent('BODY=/vault/note.md && echo "$BODY"'),
      makeCtx("/r"),
      0,
    );
    // `echo` is the ref NAME — the suffix holds just the word.
    const args = argsOf(seen, "echo");
    assert.equal(args.length, 1);
    assert.equal(args[0]!.text, '"/vault/note.md"');
    assert.equal(args[0]!.value, "/vault/note.md");
    assert.equal(args[0]!.rawText, '"$BODY"');
  });

  it("unresolvable words stay raw: text === raw source, value === lexical", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent(
        'gh pr create --title "$UNDEF" --body-file="$(cmd)" --body "${X:-d}"',
      ),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "gh");
    const undef = args[3]!;
    assert.equal(undef.text, '"$UNDEF"');
    assert.equal(undef.value, "$UNDEF");
    const cmdSub = args[4]!;
    assert.equal(cmdSub.text, '--body-file="$(cmd)"');
    assert.equal(cmdSub.value, "--body-file=$(cmd)");
    const modifier = args[6]!;
    assert.equal(modifier.text, '"${X:-d}"');
    assert.equal(modifier.value, "${X:-d}");
  });

  it("~ resolves via seeded HOME (chain-assigned)", async () => {
    // Chain form — the bare assignment persists into the next ref's
    // walker env (bash-faithful: `HOME=/x && echo ~` → `/x`), so the
    // result is deterministic on any host. (Prefix form would resolve
    // `~` against the RUNNING process HOME on CI — `/home/runner` /
    // `/Users/runner` — so the old prefix-form fixture was a CI trap.)
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent("HOME=/home/pier && gh pr create --body-file ~/note.md"),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "gh");
    assert.equal(args[3]!.text, "/home/pier/note.md");
    assert.equal(args[3]!.value, "/home/pier/note.md");
    assert.equal(args[3]!.rawText, "~/note.md");
  });

  it("chain-assigned VAULT=~/x stores the HOME-expanded path (walker bump pin, issue #13)", async () => {
    // Regression pin for the walker 0.1.0-20260827.0 bump: the
    // assignment-RHS tilde fix (unbash-walker#13, fcbdc61) now stores
    // the HOME-expanded value for `VAULT=~/x` (was the literal
    // `~/x`). This is the exact closure the pi-steering-github `$BODY`
    // note (issue #14, closed-deferred) was parked on — the walker env
    // snapshot must carry the expanded path so downstream predicates
    // (missingVaultBodyFile) resolve against the real path.
    //
    // Fails on 0.1.0-20260816.0 (env.get("VAULT") === "~/vault/...",
    // args text keeps the literal) — passes on 0.1.0-20260827.0.
    //
    // The explicit `HOME=` chain-assignment makes the expansion
    // deterministic on any host (CI HOME is /home/runner or
    // /Users/runner) — same technique as the seeded-HOME test above.
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent(
        'HOME=/home/pier && VAULT=~/vault/repo/prs && gh pr create --title "feat: x (closes #12)" --body-file=<(perl -0777 -pe \'<BODY_STRIP>\' "$VAULT/note.md")',
      ),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "gh");
    // --body-file= is its own word; the process substitution is the
    // next one — its inner `$VAULT/note.md` must resolve against the
    // HOME-expanded VAULT.
    const ps = args[5]!;
    assert.equal(
      ps.text,
      "<(perl -0777 -pe '<BODY_STRIP>' \"/home/pier/vault/repo/prs/note.md\")",
    );
    assert.equal(
      ps.value,
      "<(perl -0777 -pe '<BODY_STRIP>' \"$VAULT/note.md\")",
    );
    // The walker env snapshot carries the expanded path — the surface
    // the missingVaultBodyFile predicate resolves against.
    const ghCtx = seen.find(
      (c) => c.input.tool === "bash" && c.input.basename === "gh",
    );
    assert.ok(ghCtx, "gh ref should have fired the condition");
    assert.ok(ghCtx.walkerState, "walkerState should be populated");
    assert.ok(ghCtx.walkerState.env instanceof Map);
    assert.equal(
      (ghCtx.walkerState.env as ReadonlyMap<string, string>).get("VAULT"),
      "/home/pier/vault/repo/prs",
    );
  });

  it("same-ref prefix assignments do NOT resolve the ref's words (bash-faithful)", async () => {
    // bash manual §3.7.1: command WORDS expand against the PRE-command
    // environment; a prefix assignment (`NAME=value cmd …`) binds for
    // the DIRECT CHILD's env only. BODY is absent from the walker's
    // per-ref env snapshot, so the word stays raw — fail-closed.
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent('BODY=/vault/note.md gh pr create --body-file="$BODY"'),
      makeCtx("/r"),
      0,
    );
    let args = argsOf(seen, "gh");
    const bodyFile = args[2]!;
    assert.equal(bodyFile.text, '--body-file="$BODY"');
    assert.equal(bodyFile.value, "--body-file=$BODY");
    assert.equal(bodyFile.rawText, '--body-file="$BODY"');

    // `$(cmd)` RHS variant — same raw outcome under the env snapshot.
    seen.length = 0;
    await evaluator.evaluate(
      bashEvent('BODY=$(cmd) gh pr create --body-file="$BODY"'),
      makeCtx("/r"),
      0,
    );
    args = argsOf(seen, "gh");
    const bodyFile2 = args[2]!;
    assert.equal(bodyFile2.text, '--body-file="$BODY"');
    assert.equal(bodyFile2.value, "--body-file=$BODY");
  });

  it('snapshot wins over prefix: BODY=old; BODY=new echo "$BODY" prints old', async () => {
    // bash ground truth: `echo $BODY` prints the OLD value — the
    // semicolon-assignment persists into the chain env, while the
    // prefix `BODY=new` binds only for the direct child's env, not
    // for the same command's word expansion (§3.7.1). Kills the
    // public-surface disagreement: `walkerState.env` says `old` AND
    // `args` say `old`.
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent('BODY=old; BODY=new echo "$BODY"'),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "echo");
    assert.equal(args[0]!.value, "old");
    assert.equal(args[0]!.text, '"old"');
    assert.equal(args[0]!.rawText, '"$BODY"');
  });

  it("fail-closed: procsub inner of a prefix-referencing word stays raw", async () => {
    // Real bash forks the process substitution BEFORE the prefix
    // assignment applies (the procsub child inherits the PRE-command
    // env), so perl would get an empty arg and the failure would be
    // swallowed. Keeping the word raw means the predicate sees the
    // failure truth instead of a resolved fiction.
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent(
        "BODY=/vault/note.md gh pr create --body-file=<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")",
      ),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "gh");
    const ps = args[3]!;
    assert.match(ps.text!, /\$BODY/);
    assert.doesNotMatch(ps.text!, /\/vault\/note\.md/);
    assert.equal(ps.value, "<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")");
    assert.equal(ps.rawText, "<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")");
  });

  it("command field resolves: condition fires on a chain-assigned $T title", async () => {
    // Resolution-dependent: the RAW command text contains `"$T"` —
    // the condition only matches because the args surface carries the
    // resolved title value. Chain form: the bare
    // assignment persists into the next ref's walker env (prefix form
    // would NOT — one-shot for the direct child's env only — so this
    // pin must stay in chain shape to test what its name claims).
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      {
        rules: [
          {
            name: "title-keyword-resolved",
            tool: "bash",
            command: "gh",
            reason: "title keyword",
            when: {
              condition: (ctx) => {
                seen.push(ctx);
                return resolvedTitleCloses(ctx);
              },
            },
          },
        ],
      },
      resolve(),
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent('T="feat: x (closes #12)" && gh pr create --title "$T"'),
      makeCtx("/r"),
      0,
    );
    assert.ok(res && res.block === true);
    const ghCtx = seen.find((s) => s.input.basename === "gh");
    assert.ok(ghCtx, "predicate ran for the gh ref");
    assert.equal(
      ghCtx.input.command,
      "gh pr create --title feat: x (closes #12)",
    );
  });

  it("parts stay RAW even when text/value are resolved", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent('BODY=/vault/note.md && echo "$BODY"'),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "echo");
    assert.equal(args[0]!.text, '"/vault/note.md"', "text resolved");
    assert.equal(args[0]!.value, "/vault/note.md", "value resolved");
    // Raw AST parts: a DoubleQuoted part whose source still contains
    // the unexpanded `$BODY`.
    assert.equal(args[0]!.parts?.length, 1);
    assert.equal(args[0]!.parts![0]!.type, "DoubleQuoted");
    assert.equal(args[0]!.parts![0]!.text, '"$BODY"');
  });

  it("static words unchanged: existing value ?? text contract holds", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(
      bashEvent("git commit -m 'conventional: subject'"),
      makeCtx("/r"),
      0,
    );
    const args = argsOf(seen, "git");
    assert.equal(args[0]!.value ?? args[0]!.text, "commit");
    assert.equal(args[1]!.value ?? args[1]!.text, "-m");
    assert.equal(args[2]!.value ?? args[2]!.text, "conventional: subject");
    assert.equal(args[2]!.rawText, "'conventional: subject'");
    assert.equal(args[2]!.text, "'conventional: subject'");
  });

  it("envAssignments stay RAW (A=$VAR verbatim) — unchanged contract", async () => {
    const seen: PredicateContext[] = [];
    const evaluator = buildEvaluator(
      { rules: [captureInputRule(seen)] },
      resolve(),
      makeHost(),
    );
    await evaluator.evaluate(bashEvent("A=$VAR run-me"), makeCtx("/r"), 0);
    const input = seen[0]!.input;
    assert.equal(input.envAssignments!.length, 1);
    assert.equal(input.envAssignments![0]!.text, "A=$VAR");
  });
});

// ---------------------------------------------------------------------------
// Issue #54 — speculative synthesis keeps parity with plugin env trackers
// ---------------------------------------------------------------------------
//
// The speculative-allow path (synthesizeSpeculativeEntries) feeds the
// evaluator's rule-side RESOLVED text (computed with the full plugin
// walk registry) into the shared matchesWatch. Chain-masking must not
// regress when a plugin env tracker is present: a producer `&&` ref
// that only matches its observer in RESOLVED form must still grant a
// speculative entry.

describe("buildEvaluator: speculative allow with plugin env tracker (issue #54)", () => {
  const PROBE = "PI_STEERING_PARITY_PROBE_FOO" as const;
  const PROBE_SEEN = "probe-seen" as const;

  function pluginEnvTracker(): Tracker<EnvState> {
    return {
      initial: new Map([[PROBE, "plugin-only"]]),
      unknown: new Map(),
      modifiers: {},
      subshellSemantics: "isolated",
    };
  }

  const resolvedWithPlugin = resolvePlugins(
    [
      {
        name: "env-owner",
        trackers: { env: pluginEnvTracker() },
        // Explicit strict: this suite pins the walk-registry path,
        // not argv arity (issue #107 loudness).
        cliDescriptors: { echo: {}, finalize: {} },
      },
    ],
    {},
    EVALUATOR_BUILTIN_TRACKERS,
  );

  function producer(pat: RegExp, name: string): Observer {
    return {
      name,
      writes: [PROBE_SEEN],
      watch: { toolName: "bash", inputMatches: { command: pat } },
      onResult: () => {
        /* the reverse-index only reads metadata in the evaluator */
      },
    };
  }

  const needsSeen: Rule = {
    name: "needs-probe-seen",
    tool: "bash",
    command: "finalize",
    reason: "probe first",
    when: { missing: { event: PROBE_SEEN, in: "agent_loop" } },
  };

  it("resolved producer ref grants the speculative allow (chain registered plugin env)", async () => {
    // `$PROBE` resolves to plugin-only ONLY via the plugin env tracker
    // (the built-in env tracker has no such var). The evaluator's
    // resolvedTexts carry the full-registry resolution into the
    // synthesized event → the resolved-form observer matches → the
    // `finalize` ref sees the speculative entry as present → allow.
    const evaluator = buildEvaluator(
      {
        rules: [needsSeen],
        observers: [producer(/echo plugin-only/, "resolved-producer")],
      },
      resolvedWithPlugin,
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent(`echo "$PI_STEERING_PARITY_PROBE_FOO" && finalize`),
      makeCtx("/r"),
      5,
    );
    assert.equal(
      res,
      undefined,
      "chain must be ALLOWED: the resolved producer ref was seen speculatively",
    );
  });

  it("control: raw-form watch on the producer → no speculative entry → chain blocked", async () => {
    // A watch written for the raw `$VAR` shape cannot match the
    // rule-side resolved text (`echo plugin-only` no longer carries the
    // raw token) → no speculative entry → the requirement gate fires.
    // Pins that raw-form observers do NOT grant spurious allows
    // (rule-resolves-more direction on the speculative surface).
    const evaluator = buildEvaluator(
      {
        rules: [needsSeen],
        observers: [
          producer(/echo \$PI_STEERING_PARITY_PROBE_FOO/, "raw-producer"),
        ],
      },
      resolvedWithPlugin,
      makeHost(),
    );
    const res = await evaluator.evaluate(
      bashEvent(`echo "$PI_STEERING_PARITY_PROBE_FOO" && finalize`),
      makeCtx("/r"),
      5,
    );
    assert.ok(
      res && res.block === true,
      "raw-form producer can't match resolved text → no speculative entry → BLOCK",
    );
  });
});

describe("arityOf hoisting (issue #110)", () => {
  it("per-tool_call shared derivation: multi-ref && chain resolves glue on both refs", async () => {
    const { loadHarness, expectBlocks } = await import("./testing/index.ts");
    const h = loadHarness({
      config: {
        plugins: [
          {
            name: "gh-facts",
            cliDescriptors: {
              gh: {
                flags: {
                  repo: { aliases: ["-R", "--repo"], takesValue: true },
                },
              },
            },
          },
        ],
        rules: [
          {
            name: "no-gh-r",
            tool: "bash",
            command: "gh",
            reason: "no gh R",
            when: {
              flag: {
                anyOf: [{ aliases: ["-R"], takesValue: true }],
              },
            },
          },
        ],
      },
    });
    // Both refs carry glued -R values; hoisted arityOf resolves each
    // ref through the per-tool_call cache (O(distinct basenames)).
    await expectBlocks(
      h,
      { command: "gh -Rfoo pr list && gh -Rbar pr list" },
      { rule: "no-gh-r" },
    );
  });

  it("absent→throw rule-tagged block preserved through entries", async () => {
    const { loadHarness, expectBlocks } = await import("./testing/index.ts");
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-foo",
            tool: "bash",
            command: "foo",
            reason: "no foo",
            when: {
              flag: {
                anyOf: [{ aliases: ["--bar"], takesValue: false }],
              },
            },
          },
        ],
      },
    });
    await expectBlocks(h, { command: "foo --bar" }, { rule: "no-foo" });
  });
});
