// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `no-main-commit` rule
 * (`./no-main-commit.ts`).
 *
 * These verify the rule definition itself - pattern shape, `when`
 * wiring, `noOverride` semantics, dynamic reason text - against the
 * evaluator pipeline. Each test constructs a minimal config with the
 * plugin loaded and runs a bash tool_call through `buildEvaluator`.
 *
 * End-to-end wiring (walker branch state driving predicate behavior,
 * plugin registration) is in `../integration.test.ts`; the
 * github-flavored specialization lives in `./no-main-commit-github.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BashToolCallEvent,
  ExecResult as PiExecResult,
} from "@earendil-works/pi-coding-agent";
import { makeCtx, makeTrackedHost } from "../../../__test-helpers__.ts";
import { buildEvaluator } from "../../../evaluator.ts";
import { resolvePlugins } from "../../../plugin-merger.ts";
import { PROTECTED_BRANCH_PATTERN } from "../helpers/patterns.ts";
import gitPlugin from "../index.ts";
import { noMainCommit } from "./no-main-commit.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

/**
 * Build an evaluator that includes the git plugin with a stub `exec`
 * returning the given fake branch on `git branch --show-current`.
 * Every other `git` call (including `git config --get
 * remote.origin.url`) returns exit 1, so predicates fall back to
 * their `onUnknown` policy. The github-flavored
 * `noMainCommitGithub` specialization (more specific via
 * `remote: { pattern: ..., onUnknown: "allow" }`) skips on the
 * resulting no-origin signal, and tests in this scope cleanly
 * exercise the generic `noMainCommit` rule.
 *
 * Tests that need to exercise the github-flavored rule (or the
 * non-github fall-through path) use {@link buildWithBranchAndRemote}
 * in `./no-main-commit-github.test.ts` — it parameterizes the origin
 * URL.
 */
function buildWithBranch(branchName: string) {
  const host = makeTrackedHost({
    exec: async (cmd, args): Promise<PiExecResult> => {
      if (
        cmd === "git" &&
        args[0] === "branch" &&
        args[1] === "--show-current"
      ) {
        return {
          stdout: `${branchName}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
  });
  const resolved = resolvePlugins([gitPlugin], {});
  const evaluator = buildEvaluator({}, resolved, host);
  return { evaluator, host };
}

// ---------------------------------------------------------------------------
// no-main-commit
// ---------------------------------------------------------------------------

describe("rules: no-main-commit shape", () => {
  it("exists on the plugin with the expected routing + strict flag", () => {
    const rule = gitPlugin.rules?.find((r) => r.name === "no-main-commit");
    assert.ok(rule);
    assert.equal(rule.tool, "bash");
    if (rule.tool !== "bash") throw new Error("narrow");
    assert.equal(rule.command, "git");
    assert.equal(rule.noOverride, true);
    const when = rule.when as Record<string, unknown>;
    assert.equal(when["subcommand"], "commit");
    assert.ok("branch" in when);
  });

  it("fires on `git commit` when branch predicate resolves to main", async () => {
    const { evaluator } = buildWithBranch("main");
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /\[steering:no-main-commit@[^\]]+\]/);
  });

  it("allows `git commit` on a feature branch", async () => {
    const { evaluator } = buildWithBranch("feat-login");
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });

  it("fires on each protected-branch alias (master / mainline / trunk)", async () => {
    for (const branchName of ["master", "mainline", "trunk"]) {
      const { evaluator } = buildWithBranch(branchName);
      const res = await evaluator.evaluate(
        bashEvent("git commit -m 'x'"),
        makeCtx("/repo"),
        0,
      );
      assert.ok(
        res && res.block === true,
        `expected block for branch=${branchName}`,
      );
    }
  });

  it("does NOT fire on git log (non-commit subcommand) even on main", async () => {
    const { evaluator } = buildWithBranch("main");
    const res = await evaluator.evaluate(
      bashEvent("git log --oneline"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });

  it("catches `git -C /other commit` via pre-subcommand flag slot", async () => {
    const { evaluator } = buildWithBranch("main");
    const res = await evaluator.evaluate(
      bashEvent("git -C /other commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
  });

  it("ignores `# steering-override: no-main-commit` comment — rule is strict", async () => {
    // noOverride: true on the rule (issue #79) — an inline override
    // comment no longer suppresses the block. The command still
    // blocks with the standard reason, no steering-override audit
    // entry is recorded, and the message carries no "To override"
    // hint.
    const { evaluator, host } = buildWithBranch("main");
    const res = await evaluator.evaluate(
      bashEvent(
        "git commit -m 'release' # steering-override: no-main-commit - release bump",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /\[steering:no-main-commit@[^\]]+\]/);
    assert.doesNotMatch(res.reason!, /To override/);
    assert.ok(
      !host.appended.some((e) => e.type === "steering-override"),
      "strict rule must not record a steering-override audit entry",
    );
  });
});

// ---------------------------------------------------------------------------
// no-main-commit: dynamic reason (Item 1 of PR #5 scope expansion)
//
// When the branch tracker has resolved the current branch statically
// (from a `git checkout <name>` earlier in the chain), the rule's
// reason text injects the branch name so the agent sees
// "You are on 'main'" instead of a generic reminder. When tracker
// state is missing (no checkout in chain, exec fallback) or the value
// is the walker's `"unknown"` sentinel (dynamic checkout), the
// dynamic clause is omitted — the static actionable tail still
// guides the agent to a feature branch.
// ---------------------------------------------------------------------------

describe("rules: no-main-commit dynamic reason", () => {
  it("`git checkout main && git commit` - reason injects 'You are on main'", async () => {
    // Walker folds the checkout into the branch state seen by the
    // commit ref; the ReasonFn reads `ctx.walkerState.branch` and
    // sees the concrete value `main`.
    const { evaluator } = buildWithBranch("feature");
    const res = await evaluator.evaluate(
      bashEvent("git checkout main && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res.reason!,
      /You are on 'main'/,
      "reason must include the walker-resolved branch name",
    );
    // Prefix and static tail still present - the dynamic clause
    // is additive, not a replacement.
    assert.match(res.reason!, /\[steering:no-main-commit@[^\]]+\]/);
    assert.match(res.reason!, /Create a feature branch first/);
  });

  it("`git checkout master && git commit` - injects the concrete protected branch name", async () => {
    // Pin that the injected name is the tracker-resolved value,
    // not a hardcoded "main" — master / trunk / mainline all get
    // the same dynamic treatment.
    const { evaluator } = buildWithBranch("feature");
    const res = await evaluator.evaluate(
      bashEvent("git checkout master && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /You are on 'master'/);
  });

  it("no in-chain checkout + exec fallback - reason omits the dynamic clause", async () => {
    // Exec reports `main` via `git branch --show-current`, so the
    // rule fires — but the BRANCH TRACKER didn't see an in-chain
    // checkout, so `ctx.walkerState.branch` is the tracker's
    // `NO_CHECKOUT_IN_CHAIN` sentinel (not a real branch name).
    // The ReasonFn must NOT leak that sentinel into the reason
    // text; it falls back to the static form.
    const { evaluator } = buildWithBranch("main");
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.doesNotMatch(
      res.reason!,
      /You are on '/,
      "reason must not include the dynamic clause when walker state is missing",
    );
    // Static tail still present.
    assert.match(res.reason!, /Create a feature branch first/);
  });

  it("`git checkout $VAR && git commit` - walker-unknown branch - reason omits the dynamic clause", async () => {
    // The branch tracker collapses `checkout $VAR` to its
    // `"unknown"` sentinel. The predicate's onUnknown="block"
    // default still fires, and the ReasonFn treats `"unknown"`
    // as a non-concrete value — the dynamic clause is omitted
    // rather than leaking the sentinel string into the message.
    const { evaluator } = buildWithBranch("feature");
    const res = await evaluator.evaluate(
      bashEvent("git checkout $VAR && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.doesNotMatch(
      res.reason!,
      /You are on '/,
      "reason must not include the dynamic clause when walker state is 'unknown'",
    );
    assert.doesNotMatch(
      res.reason!,
      /unknown/,
      "reason must not leak the walker sentinel string",
    );
  });
});
