// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * End-to-end integration tests for the git plugin.
 *
 * These are the most valuable tests in Phase 4: they exercise the
 * full wire-up from plugin registration through `resolvePlugins`,
 * `buildEvaluator`, walker tracker composition, predicate dispatch,
 * and override handling. Unit tests pin individual pieces; this
 * suite pins that the pieces fit together.
 *
 * Scenarios covered:
 *
 *   1. Plugin resolution - predicates, rules, trackers, and
 *      trackerExtensions land in the resolved state.
 *   2. The migrated `no-force-push` rail (ex-engine-default, issue #72)
 *      still blocks basic force-push when declared explicitly.
 *   3. Branch predicate against a fake git `exec` - fires on main,
 *      allows on feature.
 *   4. `-C /other` cwd extension doesn't accidentally bypass the rule.
 *   5. The WALKER-DRIVEN branch case: `git checkout main && git
 *      commit` - the branch tracker folds the checkout into the
 *      commit's state, so `no-main-commit` fires on the commit even
 *      though `exec` would see whatever the fake session is on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BashToolCallEvent,
  ExecResult as PiExecResult,
} from "@earendil-works/pi-coding-agent";
import { makeCtx, makeTrackedHost } from "../../__test-helpers__.ts";
import { buildEvaluator } from "../../evaluator.ts";
import { resolvePlugins } from "../../plugin-merger.ts";
import type { SteeringConfig } from "../../schema.ts";
import gitPlugin from "./index.ts";

// ---------------------------------------------------------------------------
// Builders
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
 * Build an evaluator that mirrors the realistic wiring: the git
 * plugin + any extra user rules. Uses `makeTrackedHost` for a
 * controllable `exec` stub.
 */
function buildRuntime(
  config: SteeringConfig,
  execStub?: (cmd: string, args: string[]) => Promise<PiExecResult>,
) {
  const host = makeTrackedHost({
    exec: async (cmd, args) => {
      if (execStub) return execStub(cmd, args);
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
  });
  const plugins = config.plugins ?? [];
  // Pass `["cwd"]` as the known built-in tracker name so the git
  // plugin's cwd extension (`--git-dir=` / `--work-tree=`) doesn't
  // trigger an orphan warning and is preserved for the evaluator to
  // compose onto the built-in `cwdTracker`. The pi extension runtime
  // (`src/index.ts`) passes the same list.
  const resolved = resolvePlugins(plugins, config, ["cwd"]);
  const evaluator = buildEvaluator(
    { ...config, rules: config.rules ?? [] },
    resolved,
    host,
  );
  return { evaluator, host, resolved };
}

/**
 * Stub exec that reports a given branch name for `git branch
 * --show-current`. Every other `git` call (including `git config
 * --get remote.origin.url`) returns exit 1, so predicates fall back
 * to their `onUnknown` policy. The github-flavored
 * `noMainCommitGithub` specialization is more specific via
 * `remote: { pattern: ..., onUnknown: "allow" }`; on the resulting
 * no-origin signal the github rule skips and the engine cleanly
 * falls through to the generic `noMainCommit` for tests in this
 * scope.
 *
 * Tests that need to exercise the github-flavored rule (or its
 * non-github fall-through) construct their own exec stub that
 * additionally returns a github URL on the `git config` call.
 */
function branchExec(name: string) {
  return async (cmd: string, args: string[]): Promise<PiExecResult> => {
    if (cmd === "git" && args[0] === "branch" && args[1] === "--show-current") {
      return { stdout: `${name}\n`, stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
}

// ---------------------------------------------------------------------------
// 1. Plugin resolution
// ---------------------------------------------------------------------------

describe("git plugin: registration + resolution", () => {
  it("resolvePlugins surfaces all four plugin surfaces", () => {
    const resolved = resolvePlugins([gitPlugin], {}, ["cwd"]);
    // Predicates registered.
    assert.ok("branch" in resolved.predicates);
    assert.ok("upstream" in resolved.predicates);
    assert.ok("commitsAhead" in resolved.predicates);
    assert.ok("hasStagedChanges" in resolved.predicates);
    assert.ok("isClean" in resolved.predicates);
    assert.ok("remote" in resolved.predicates);
    // Rules registered.
    assert.ok(resolved.rules.some((r) => r.name === "no-main-commit"));
    // Branch tracker registered.
    assert.ok("branch" in resolved.trackers);
    // Cwd extension captured: when the caller declares `"cwd"` as a
    // known built-in tracker name, the merger keeps the extension in
    // `trackerModifiers` (rather than dropping it as orphan) so the
    // evaluator can compose it onto the built-in cwdTracker.
    assert.ok("cwd" in resolved.trackerModifiers);
    assert.ok(resolved.trackerModifiers["cwd"]?.["git"] !== undefined);
  });

  it("without the knownBuiltinTrackers hint, cwd extension falls through with an orphan warning", () => {
    // Callers that DON'T declare cwd as a built-in see an orphan
    // warning + the extension is dropped. Pin this behavior so the
    // semantic doesn't silently drift: the merger trusts the caller's
    // declaration, not implicit knowledge of built-in trackers.
    const resolved = resolvePlugins([gitPlugin], {});
    assert.ok(
      resolved.diagnostics.some((w) => w.kind === "extension-orphan"),
      "expected orphan warning when cwd isn't declared as built-in",
    );
    assert.ok(
      !("cwd" in resolved.trackerModifiers),
      "expected the cwd extension to be dropped",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The migrated no-force-push rail works with the plugin loaded
// ---------------------------------------------------------------------------

describe("git plugin: migrated no-force-push rail (issue #72)", () => {
  it("`git push --force` blocks via no-force-push", async () => {
    const { evaluator } = buildRuntime({
      plugins: [gitPlugin],
      rules: [], // only plugin-shipped rules; nothing is engine-injected
    });
    const res = await evaluator.evaluate(
      bashEvent("git push --force origin main"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /\[steering:no-force-push@[^\]]+\]/);
  });
});

// ---------------------------------------------------------------------------
// 3. Branch predicate via fake exec
// ---------------------------------------------------------------------------

describe("git plugin: no-main-commit via branch predicate", () => {
  it("fires on main", async () => {
    const { evaluator } = buildRuntime(
      {
        plugins: [gitPlugin],
        rules: [], // only plugin-shipped rules; nothing is engine-injected
      },
      branchExec("main"),
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /\[steering:no-main-commit@[^\]]+\]/);
  });

  it("allows on feature", async () => {
    const { evaluator } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("feature-x"),
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. `-C /other` doesn't bypass the rule
// ---------------------------------------------------------------------------

describe("git plugin: -C routing does not bypass no-main-commit", () => {
  it("`git -C /other commit` still evaluates branch and fires on main", async () => {
    // Stub reports main regardless of cwd - the predicate queries
    // git at `ctx.cwd`, which for the `-C /other` ref is `/other`
    // (walker cwd). Either way the stubbed branch is main.
    const { evaluator } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("main"),
    );
    const res = await evaluator.evaluate(
      bashEvent("git -C /other commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
  });

  it("when.branch doesn't fire if predicate resolves non-main", async () => {
    // Pair of the above: `-C /other commit` with exec reporting
    // feature -> allow. Pins that branch predicate reads the stub
    // every tool_call (not cached from a previous call).
    const { evaluator } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("feature"),
    );
    const res = await evaluator.evaluate(
      bashEvent("git -C /other commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });

  it("`git --git-dir=/other commit` forwards effective cwd through to the branch predicate", async () => {
    // This pins the cwd-tracker-extension wire-up end-to-end: the
    // `--git-dir=/other` flag is parsed by the plugin's cwd extension,
    // producing walker cwd `/other` for that command ref. The branch
    // predicate then runs `git branch --show-current` with `cwd:
    // "/other"`. We assert that cwd on the exec call to pin the
    // extension reached the evaluator (via the `knownBuiltinTrackers`
    // hint and `internal/walk-registry.ts`'s `composeBuiltinCwd`
    // helper, which builds the evaluator + observer dispatcher's
    // shared walk registry).
    const { evaluator, host } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("main"),
    );
    await evaluator.evaluate(
      bashEvent("git --git-dir=/other commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    const branchCall = host.execCalls.find(
      (c) =>
        c.cmd === "git" &&
        c.args[0] === "branch" &&
        c.args[1] === "--show-current",
    );
    assert.ok(
      branchCall !== undefined,
      "expected a `git branch --show-current` call",
    );
    assert.equal(
      branchCall.cwd,
      "/other",
      "branch predicate should run in the cwd produced by the --git-dir= extension",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. THE KEY TEST: walker-driven branch state
// ---------------------------------------------------------------------------

describe("git plugin: walker-driven branch state (the KEY test)", () => {
  it("`git checkout main && git commit` - the second command is evaluated on branch=main", async () => {
    // The fake session "current branch" is `feature-x` - a
    // naive session-state predicate would see that and let the
    // commit through. The branch TRACKER folds the in-chain
    // `git checkout main` into the walker state seen by the
    // second ref (`git commit`), so `no-main-commit` fires.
    //
    // The predicate prefers `ctx.walkerState.branch` over a shell
    // call; the walker-resolved `main` wins over the stubbed
    // `feature-x`. The `exec` stub is effectively unreachable
    // here - if the predicate ever shelled out for this case it
    // would incorrectly allow.
    const { evaluator, host } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("feature-x"),
    );
    const res = await evaluator.evaluate(
      bashEvent("git checkout main && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /\[steering:no-main-commit@[^\]]+\]/);
    // Regression guard: the branch predicate MUST NOT shell out
    // when the walker already provided a concrete branch value.
    assert.equal(
      host.execCalls.filter(
        (c) =>
          c.cmd === "git" &&
          c.args[0] === "branch" &&
          c.args[1] === "--show-current",
      ).length,
      0,
      "branch predicate must read walkerState, not shell out",
    );
  });

  it("`git checkout feature && git commit` - evaluated on branch=feature, allows", async () => {
    // Pair test: walker folds the checkout in, lands on feature,
    // rule skips. Exec stub would say `main` here - again
    // walker-state wins.
    const { evaluator } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("main"),
    );
    const res = await evaluator.evaluate(
      bashEvent("git checkout feature && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });

  it("checkout in a subshell does NOT escape - outer `git commit` allowed on feature", async () => {
    // `(git checkout main)` is subshell-isolated; the outer
    // `git commit` inherits the pre-subshell branch state. No
    // branch-changing modifier fired in the outer scope, so the
    // walker threads the tracker's `NO_CHECKOUT_IN_CHAIN` initial
    // sentinel (distinct from the `"unknown"` sentinel that
    // signals a dynamic checkout). The predicate reads this as
    // `missing` -> exec fallback to `git branch --show-current`,
    // which the stub reports as `feature`. Rule doesn't fire.
    const { evaluator } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("feature"),
    );
    const res = await evaluator.evaluate(
      bashEvent("(git checkout main) && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });

  it("`git checkout $VAR && git commit` - walker unknown short-circuits to onUnknown, no exec fallback", async () => {
    // When $VAR is not statically resolvable, the branch tracker
    // collapses to its "unknown" sentinel. The predicate MUST
    // short-circuit on this signal: a `git branch --show-current`
    // exec fallback here would return the PRE-checkout branch,
    // which is exactly the case the walker's in-chain tracking
    // exists to catch. The predicate's `onUnknown: "block"`
    // default then fires the rule.
    //
    // This pins U1: the exec stub reports "feature" (a non-
    // protected branch). Pre-U1 the predicate treated walker
    // "unknown" as "absent" and fell through to exec -> the rule
    // would INCORRECTLY allow, defeating fail-closed. Post-U1:
    // exec is not consulted, the rule correctly fires.
    const { evaluator, host } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      branchExec("feature"),
    );
    const res = await evaluator.evaluate(
      bashEvent("git checkout $VAR && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "unresolvable branch must fail-closed and fire no-main-commit",
    );
    // Regression guard: walker-unknown must NOT fall through to
    // `git branch --show-current`. If this count is ever > 0 the
    // U1 short-circuit has been re-broken.
    assert.equal(
      host.execCalls.filter(
        (c) =>
          c.cmd === "git" &&
          c.args[0] === "branch" &&
          c.args[1] === "--show-current",
      ).length,
      0,
      "walker-unknown short-circuits to onUnknown; predicate must not shell out",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. no-main-commit-github + walker-unknown cwd
//
// The github-flavored specialization's reason fn has a dedicated
// walker-unknown branch — under `cd "$VAR" && git commit`, the engine
// Walker-unknown cwd: github-flavored rule has
// `remote: { pattern, onUnknown: "allow" }`. Under the trinary
// engine, `onUnknown: "allow"` at the leaf level genuinely means
// "skip the predicate when the value is unresolvable" — the
// `remote:` leaf surfaces trinary `"unknown"` (via the inline
// walker-unknown guard at the top of the handler body) and the
// engine's leaf adapter projects it to `false` (rule skips).
// The github-flavored rule therefore correctly defers to the
// generic `noMainCommit` rule under walker-unknown cwd, which
// consumes only the `branch:` predicate (no walker-unknown guard;
// stub returns "main\n") and fires fail-CLOSED via its default
// leaf-level `onUnknown: "block"`.
//
// What this test exercises (counterfactual rationale):
//
//   1. The `branch:` predicate matches `main` via the test stub
//      (the stub returns "main\n" for `git branch --show-current`
//      regardless of the runtime cwd that gets passed to it; in
//      production the same exec at `cwd === "unknown"` would fail
//      and the predicate would fall back to its `onUnknown:
//      "block"` default — same firing verdict, different code
//      path).
//   2. The `remote:` predicate inlines a walker-unknown-cwd guard
//      at the top of its body and surfaces trinary `"unknown"`
//      under `walkerState.cwd === "unknown"`. The leaf-level
//      `onUnknown: "allow"` on the github rule's `remote:` arg
//      then projects unknown → `false` — the github rule SKIPS.
//   3. The generic `noMainCommit` rule (with only `branch:`)
//      fires next via its default `onUnknown: "block"`. Block
//      verdict lands; the reason text is the generic
//      protected-branch reason, not the github-specific one.
//
// Pinned: the steering tag is rendered, a block verdict lands,
// and the rule that fires is `no-main-commit` (generic), not
// `no-main-commit-github` — the github-flavored rule cleanly
// declines under walker-unknown cwd because its `remote:` leaf
// opts into "allow" semantics there.
// ---------------------------------------------------------------------------

describe("git plugin: no-main-commit-github walker-unknown cwd", () => {
  it('`cd "$VAR" && git commit` on main + github remote → generic rule fires (github rule allows on walker-unknown via `onUnknown: "allow"` on its `remote:` leaf)', async () => {
    // Explicit exec stubs make the test deterministic regardless
    // of the runner's actual git state. Without the stubs, the
    // `branch:` predicate (which has no inline walker-unknown-cwd
    // guard — it tries the branch tracker first, then shells out)
    // would shell out at the test runner's cwd — the test outcome
    // would depend on whatever branch / remote that workspace
    // happens to be on (flaky).
    const { evaluator } = buildRuntime(
      { plugins: [gitPlugin], rules: [] },
      async (cmd: string, args: string[]): Promise<PiExecResult> => {
        if (
          cmd === "git" &&
          args[0] === "branch" &&
          args[1] === "--show-current"
        ) {
          return {
            stdout: "main\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        if (
          cmd === "git" &&
          args[0] === "config" &&
          args[1] === "--get" &&
          args[2] === "remote.origin.url"
        ) {
          return {
            stdout: "https://github.com/cad0p/repo.git\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
    );
    const res = await evaluator.evaluate(
      bashEvent("cd \"$VAR\" && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res && res.block === true,
      'walker-unknown cwd must still fire a block (generic no-main-commit, after github-flavored rule allows via its `onUnknown: "allow"` on `remote:`)',
    );
    assert.match(
      res.reason!,
      /\[steering:no-main-commit@[^\]]+\]/,
      'generic protected-branch rule fires (the github-flavored rule cleanly declines under walker-unknown via its `onUnknown: "allow"` on `remote:`)',
    );
    assert.doesNotMatch(
      res.reason!,
      /\[steering:no-main-commit-github@/,
      'github-flavored rule must NOT fire when its `remote:` leaf opts into `onUnknown: "allow"` and walker can\'t resolve cwd',
    );
    // The reason text should be the generic protected-branch reason,
    // not github-flavored PR-flow guidance, and must not contain
    // walker-unknown-branch error text (the github-flavored rule's
    // bespoke "could not verify the current branch" line lives
    // behind its bespoke reason fn — it's the github rule, not the
    // generic, that handles walker-unknown branch).
    assert.doesNotMatch(
      res.reason!,
      /walker.*unknown/i,
      "generic rule's reason text doesn't mention walker-unknown (that's the github rule's domain, and the github rule didn't fire here)",
    );
    assert.doesNotMatch(
      res.reason!,
      /open a PR|pull request/i,
      "generic rule's reason text doesn't carry github-flavored PR-flow guidance",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. isClean spread-form engine end-to-end
//
// Pins the engine's leaf-onUnknown read + handler-dispatch contract
// for boolean predicates: the spread form `{ value: false,
// onUnknown: "allow" }` flows verbatim to the handler; the engine's
// `readLeafOnUnknown` reads the modifier and `projectVerdict` projects
// the handler's `"unknown"` returns under that policy. The handler
// itself treats `onUnknown:` as an opaque sibling field. This drives
// `evaluateWhen` → `readLeafOnUnknown` → `isClean` handler end-to-end.
// ---------------------------------------------------------------------------

describe("git plugin: isClean spread form drives through readLeafOnUnknown", () => {
  it('`isClean: { value: false, onUnknown: "allow" }` fires when working tree is dirty (handler unwraps `value:` and ignores `onUnknown:`)', async () => {
    // Stub `git status --porcelain` to report a dirty tree.
    const { evaluator } = buildRuntime(
      {
        plugins: [
          gitPlugin,
          // Explicit strict: these suites pin isClean behavior, not
          // npm argv arity (issue #107 loudness).
          { name: "npm-facts", cliDescriptors: { npm: {} } },
        ],
        rules: [
          {
            name: "deploy-requires-clean",
            tool: "bash",
            command: "npm",
            reason: "Working tree dirty.",
            when: { isClean: { value: false, onUnknown: "allow" } },
          },
        ],
      },
      async (cmd: string, args: string[]): Promise<PiExecResult> => {
        if (
          cmd === "git" &&
          args[0] === "status" &&
          args[1] === "--porcelain"
        ) {
          return {
            stdout: " M file.ts\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
    );
    const res = await evaluator.evaluate(
      bashEvent("npm run deploy"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "engine reads `onUnknown: 'allow'` via `readLeafOnUnknown`; handler receives the raw `{ value, onUnknown }` arg, unwraps `value: false`, sees dirty tree (boolean returns from a dirty tree are concrete false/true so `onUnknown` plays no role on this path), returns true → rule fires",
    );
    assert.match(res.reason!, /\[steering:deploy-requires-clean@[^\]]+\]/);
  });

  it('`isClean: { value: false, onUnknown: "allow" }` skips on walker-unknown cwd (handler surfaces `"unknown"` → leaf `"allow"` → false)', async () => {
    // Pins the walker-unknown-cwd path: the inline guard at the
    // handler's top surfaces `"unknown"`; the engine's leaf-level
    // `onUnknown: "allow"` projects unknown → false, the rule skips.
    const { evaluator } = buildRuntime(
      {
        plugins: [
          gitPlugin,
          // Explicit strict: these suites pin isClean behavior, not
          // npm argv arity (issue #107 loudness).
          { name: "npm-facts", cliDescriptors: { npm: {} } },
        ],
        rules: [
          {
            name: "deploy-requires-clean",
            tool: "bash",
            command: "npm",
            reason: "Working tree dirty.",
            when: { isClean: { value: false, onUnknown: "allow" } },
          },
        ],
      },
      async (): Promise<PiExecResult> => ({
        stdout: " M file.ts\n",
        stderr: "",
        code: 0,
        killed: false,
      }),
    );
    const res = await evaluator.evaluate(
      bashEvent('cd "$VAR" && npm run deploy'),
      makeCtx("/repo"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "walker-unknown cwd → handler returns 'unknown' → leaf-level 'allow' projects to false → rule skips",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. isClean: false vs not: { isClean: true } — README equivalence pin
//
// The dynamic-reason-runtime-cwd example README documents that
// `isClean: false` and `not: { isClean: true }` agree on every truth-
// table row EXCEPT `walker-known + git fails`, where they diverge:
//   - `isClean: false`: handler returns `false` on git failure → leaf
//     verdict false → rule skips.
//   - `not: { isClean: true }`: handler returns `false` → inner
//     verdict false → Kleene-AND-false-absorbs → not-flip yields true
//     → rule fires.
// This test pins both arms of the divergence so future engine drift
// trips the test alongside the README — the cross-link in the
// describe / test descriptions is intentional.
// ---------------------------------------------------------------------------

describe("git plugin: README equivalence — isClean: false vs not: { isClean: true } (walker-known + git fails row)", () => {
  const gitFailsExec = async (
    cmd: string,
    args: string[],
  ): Promise<PiExecResult> => {
    // `git status --porcelain` exits non-zero (git failure path the
    // handler treats as `null` → boolean `false`).
    if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
      return {
        stdout: "",
        stderr: "fatal: not a git repository",
        code: 128,
        killed: false,
      };
    }
    return { stdout: "", stderr: "", code: 1, killed: false };
  };

  it("`when: { isClean: false }` does NOT fire on git failure (handler returns false → leaf false → rule skips)", async () => {
    const { evaluator } = buildRuntime(
      {
        plugins: [
          gitPlugin,
          // Explicit strict: these suites pin isClean behavior, not
          // npm argv arity (issue #107 loudness).
          { name: "npm-facts", cliDescriptors: { npm: {} } },
        ],
        rules: [
          {
            name: "deploy-requires-clean-positive",
            tool: "bash",
            command: "npm",
            reason: "Working tree must be clean.",
            when: { isClean: false },
          },
        ],
      },
      gitFailsExec,
    );
    const res = await evaluator.evaluate(
      bashEvent("npm run deploy"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "git failure → handler returns false → leaf verdict false → rule skips",
    );
  });

  it("`when: { not: { isClean: true } }` FIRES on git failure (handler returns false → Kleene-AND-false-absorbs → not-flip = true)", async () => {
    const { evaluator } = buildRuntime(
      {
        plugins: [
          gitPlugin,
          // Explicit strict: these suites pin isClean behavior, not
          // npm argv arity (issue #107 loudness).
          { name: "npm-facts", cliDescriptors: { npm: {} } },
        ],
        rules: [
          {
            name: "deploy-requires-clean-not",
            tool: "bash",
            command: "npm",
            reason: "Working tree must be clean.",
            when: { not: { isClean: true } },
          },
        ],
      },
      gitFailsExec,
    );
    const res = await evaluator.evaluate(
      bashEvent("npm run deploy"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "git failure → handler returns false → inner verdict false → Kleene-AND false absorbs → not(false) = true → rule fires",
    );
  });
});
