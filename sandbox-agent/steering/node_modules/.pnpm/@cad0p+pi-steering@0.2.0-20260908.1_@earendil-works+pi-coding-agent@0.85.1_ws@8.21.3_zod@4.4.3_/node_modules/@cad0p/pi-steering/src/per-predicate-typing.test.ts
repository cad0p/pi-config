// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Type-level pinning for the per-predicate typing scaffold introduced
 * alongside the not-block onUnknown semantics.
 *
 * Runtime assertions are minimal — the value of these tests is the
 * compile-time pinning of the registry-driven mapped types
 * ({@link TopLevelWhenClause}, {@link TopLevelWhenClauseNoRecurse},
 * {@link OuterValue}, {@link InnerValue}). If a future change widens
 * a type incorrectly (e.g. accepting a leaf-level `onUnknown:` inside
 * `not:`, or adding `not: not:` recursion), the `// @ts-expect-error`
 * directives here surface the regression at typecheck time.
 *
 * Plugin-author registry shape: the `gitPlugin` module augments
 * `PiSteeringPredicates` with `branch:`, `upstream:`, `remote:`,
 * `isClean:`, `hasStagedChanges:`, `commitsAhead:` (see
 * `plugins/git/index.ts`). `cwd:` is a built-in non-registry leaf on
 * {@link BuiltInWhenLeaves} and is tested via
 * {@link TopLevelWhenClause} directly. This test file imports
 * gitPlugin so the augmentation is in scope before the type-level
 * pins below.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Importing gitPlugin pulls in its `declare global { interface
// PiSteeringPredicates { ... } }` augmentation; without this import
// the registry would be empty and `PluginPredicateKey` would be
// `never`, collapsing every mapped type to `{}` with the operator
// field. The reference below keeps the import live for the
// type-system without triggering unused-import diagnostics.
import gitPlugin from "./plugins/git/index.ts";
import type {
  CommitsAheadArgs,
  commitsAhead,
} from "./plugins/git/predicates/commits-ahead.ts";
import type { hasStagedChanges } from "./plugins/git/predicates/has-staged-changes.ts";
import type { isClean } from "./plugins/git/predicates/is-clean.ts";
import type {
  BuiltInWhenLeaves,
  InnerValue,
  OuterValue,
  PluginPredicateKey,
  PredicateHandler,
  TopLevelWhenClause,
  TopLevelWhenClauseNoRecurse,
} from "./schema.ts";

const _gitPluginRegistered: typeof gitPlugin = gitPlugin;
void _gitPluginRegistered;

// ---------------------------------------------------------------------------
// Positive cases — must typecheck
// ---------------------------------------------------------------------------

describe("per-predicate typing: positive cases", () => {
  it("registry pins gitPlugin's 6 predicate keys after `declare global`", () => {
    // Type-level assertion: every gitPlugin predicate key is a
    // member of `PluginPredicateKey`. A regression that drops one
    // of the augmented entries surfaces here as a type error.
    // `cwd` is NOT in this set — it's a built-in non-registry leaf
    // on BuiltInWhenLeaves (covered by the `BuiltInWhenLeaves`
    // shape pin in not-block-onunknown.test.ts).
    const keys: PluginPredicateKey[] = [
      "branch",
      "upstream",
      "remote",
      "isClean",
      "hasStagedChanges",
      "commitsAhead",
    ];
    assert.equal(keys.length, 6);
  });

  it("TopLevelWhenClause: bare leaf forms (Pattern, boolean, number)", () => {
    const w: TopLevelWhenClause = {
      cwd: /work/,
      branch: "main",
      isClean: true,
      commitsAhead: 1,
    };
    assert.ok(w.cwd !== undefined);
  });

  it("TopLevelWhenClause: spread leaf forms with leaf-level onUnknown:", () => {
    const w: TopLevelWhenClause = {
      cwd: { pattern: /work/, onUnknown: "allow" },
      isClean: { value: true, onUnknown: "allow" },
      commitsAhead: { eq: 0, onUnknown: "allow" },
    };
    assert.ok(w.cwd !== undefined);
  });

  it("TopLevelWhenClause: not?: with bare inner leaves + block-level onUnknown:", () => {
    const w: TopLevelWhenClause = {
      not: {
        cwd: /github/,
        onUnknown: "block",
      },
    };
    assert.ok(w.not?.cwd !== undefined);
  });

  it("TopLevelWhenClauseNoRecurse: spreadBase form (no modifiers) inside not:", () => {
    const w: TopLevelWhenClause = {
      not: {
        commitsAhead: { lt: 5 },
        cwd: { pattern: /github/ },
        onUnknown: "block",
      },
    };
    assert.ok(w.not?.commitsAhead !== undefined);
  });

  it("OuterValue<K>: bare OR (spreadBase + modifiers) (built-in cwd via BuiltInWhenLeaves)", () => {
    // `cwd:` is a built-in leaf on {@link BuiltInWhenLeaves}, not a
    // registry-driven key, so its type pin uses the interface field
    // directly rather than `OuterValue<"cwd">`. Registry-key version
    // uses `branch:` (gitPlugin-augmented), with the same
    // bare-or-spread+modifiers shape contract.
    const bareCwd: NonNullable<BuiltInWhenLeaves["cwd"]> = /pattern/;
    const spreadCwd: NonNullable<BuiltInWhenLeaves["cwd"]> = {
      pattern: /pattern/,
      onUnknown: "allow",
    };
    const bareBranch: OuterValue<"branch"> = /pattern/;
    const spreadBranch: OuterValue<"branch"> = {
      pattern: /pattern/,
      onUnknown: "allow",
    };
    assert.ok(bareCwd !== undefined);
    assert.ok(spreadCwd !== undefined);
    assert.ok(bareBranch !== undefined);
    assert.ok(spreadBranch !== undefined);
  });

  it("InnerValue<K>: bare OR spreadBase (NO modifiers) (built-in cwd inside not: via BuiltInWhenLeaves)", () => {
    // Inside `not:`, `cwd:` retains its built-in shape (Pattern |
    // Pattern[] | { pattern, onUnknown? }) —
    // {@link TopLevelWhenClauseNoRecurse} intersects
    // {@link BuiltInWhenLeaves} verbatim. Registry-key version uses
    // `branch:` to pin the bare-or-spreadBase (no modifiers) contract.
    const bareBranch: InnerValue<"branch"> = /pattern/;
    const spreadBranch: InnerValue<"branch"> = { pattern: /pattern/ };
    assert.ok(bareBranch !== undefined);
    assert.ok(spreadBranch !== undefined);
  });

  it('InnerValue<"upstream">: bare OR spreadBase (NO modifiers)', () => {
    // Mirrors the `branch` pin above for the other Pattern-leaf
    // registry-driven predicates so a future shape regression on
    // any one of them surfaces independently.
    const bare: InnerValue<"upstream"> = /origin\/main/;
    const spread: InnerValue<"upstream"> = { pattern: /origin\/main/ };
    assert.ok(bare !== undefined);
    assert.ok(spread !== undefined);
  });

  it('InnerValue<"remote">: bare OR spreadBase (NO modifiers)', () => {
    const bare: InnerValue<"remote"> = /github\.com/;
    const spread: InnerValue<"remote"> = { pattern: /github\.com/ };
    assert.ok(bare !== undefined);
    assert.ok(spread !== undefined);
  });

  it('InnerValue<"hasStagedChanges">: bare boolean OR { value: boolean } (NO modifiers)', () => {
    const bare: InnerValue<"hasStagedChanges"> = true;
    const spread: InnerValue<"hasStagedChanges"> = { value: true };
    assert.ok(bare !== undefined);
    assert.ok(spread !== undefined);
  });

  it("upstream: bare + spread + leaf-level onUnknown:", () => {
    const bare: OuterValue<"upstream"> = /origin\/main/;
    const spread: OuterValue<"upstream"> = {
      pattern: /origin\/main/,
      onUnknown: "allow",
    };
    assert.ok(bare !== undefined);
    assert.ok(spread !== undefined);
  });

  it("remote: bare + spread + leaf-level onUnknown:", () => {
    const bare: OuterValue<"remote"> = /github\.com/;
    const spread: OuterValue<"remote"> = {
      pattern: /github\.com/,
      onUnknown: "allow",
    };
    assert.ok(bare !== undefined);
    assert.ok(spread !== undefined);
  });

  it("hasStagedChanges: bare boolean + spread { value, onUnknown? }", () => {
    const bare: OuterValue<"hasStagedChanges"> = true;
    const spread: OuterValue<"hasStagedChanges"> = {
      value: true,
      onUnknown: "allow",
    };
    assert.ok(bare !== undefined);
    assert.ok(spread !== undefined);
  });
});

// ---------------------------------------------------------------------------
// Negative cases — must NOT typecheck (// @ts-expect-error guards)
// ---------------------------------------------------------------------------

describe("per-predicate typing: negative cases (compile-time)", () => {
  it("rule-level onUnknown: is forbidden on TopLevelWhenClause", () => {
    const w: TopLevelWhenClause = {
      cwd: /work/,
      // @ts-expect-error — rule-level onUnknown: is not on TopLevelWhenClause's type.
      onUnknown: "block",
    };
    assert.ok(w.cwd !== undefined);
  });

  it("leaf-level onUnknown: inside not: is forbidden (modifiers live at block level)", () => {
    const w: TopLevelWhenClause = {
      not: {
        // @ts-expect-error — InnerValue<"branch"> is bare | spreadBase, no modifiers.
        branch: { pattern: "main", onUnknown: "allow" },
      },
    };
    assert.ok(w.not !== undefined);
  });

  it("leaf-level onUnknown: inside not: is forbidden for boolean predicates too", () => {
    const w: TopLevelWhenClause = {
      not: {
        // @ts-expect-error — InnerValue<"isClean"> is boolean | { value: boolean }, no modifiers.
        isClean: { value: true, onUnknown: "allow" },
      },
    };
    assert.ok(w.not !== undefined);
  });

  it("leaf-level onUnknown: inside not: is forbidden for object-shaped predicates too", () => {
    const w: TopLevelWhenClause = {
      not: {
        // @ts-expect-error — InnerValue<"commitsAhead"> is number | spreadBase, no modifiers.
        commitsAhead: { lt: 5, onUnknown: "allow" },
      },
    };
    assert.ok(w.not !== undefined);
  });

  it("not: not: recursion is forbidden", () => {
    const w: TopLevelWhenClause = {
      not: {
        // @ts-expect-error — TopLevelWhenClauseNoRecurse has no `not?:` field.
        not: { cwd: "/" },
      },
    };
    assert.ok(w.not !== undefined);
  });
});

// ---------------------------------------------------------------------------
// PredicateShape auto-detect via DefaultSpreadBase
// ---------------------------------------------------------------------------

describe("PredicateShape: DefaultSpreadBase auto-detection", () => {
  it("PredicateShape<Patterns> auto-detects spreadBase to { pattern: Patterns }", () => {
    // Type-only assertion via assignability. If the auto-detect
    // breaks (e.g. tuple-wrap removed and union distributes), this
    // fails to typecheck. `branch:` carries the same Patterns-bare
    // shape as the built-in `cwd:` leaf and lives in the registry,
    // so it's the right registry-side anchor for this pin.
    type BranchShape = PiSteeringPredicates["branch"];
    const _spread: BranchShape["spreadBase"] = { pattern: /work/ };
    void _spread;
    assert.ok(true);
  });

  it("PredicateShape<boolean> auto-detects spreadBase to { value: boolean }", () => {
    type IsCleanShape = PiSteeringPredicates["isClean"];
    const _spread: IsCleanShape["spreadBase"] = { value: true };
    void _spread;
    assert.ok(true);
  });

  it("PredicateShape<number, ExplicitSpreadBase> uses the explicit override", () => {
    // commitsAhead has explicit SpreadBase = { eq?, gt?, lt?, wrt? }
    // (auto-detect from `number` would give { value: number }).
    type CAShape = PiSteeringPredicates["commitsAhead"];
    const _spread: CAShape["spreadBase"] = { eq: 1, wrt: "origin/main" };
    void _spread;
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// PluginPredicateKey reserved-key filter
// ---------------------------------------------------------------------------

describe("PluginPredicateKey: reserved-key filter", () => {
  it("filters out reserved names (`not`, `onUnknown`)", () => {
    // Belt-and-suspenders type-only check. The runtime guard in
    // `plugin-merger.ts` is the authoritative gate (it throws at
    // config-resolve time when a plugin attempts to register a
    // reserved key); this assertion pins the type-level filter that
    // drops reserved names from the registry-driven mapped types
    // (`TopLevelWhenClause`, `TopLevelWhenClauseNoRecurse`) so an IDE
    // hover never suggests a key the runtime would reject.
    type ContainsNot = "not" extends PluginPredicateKey ? true : false;
    type ContainsOnUnknown = "onUnknown" extends PluginPredicateKey
      ? true
      : false;
    const _a: ContainsNot = false;
    const _b: ContainsOnUnknown = false;
    void _a;
    void _b;
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// gitPlugin handler signatures (named exports vs registry shapes)
// ---------------------------------------------------------------------------

describe("gitPlugin handler signatures: named-export type pins", () => {
  it("`commitsAhead` is `PredicateHandler<number | CommitsAheadArgs>`", () => {
    // Pins the named export against the registry shape. If a future
    // change widens the handler arg (e.g., adding a new union member
    // without updating the registry's `PredicateShape<number,
    // CommitsAheadArgs>` SpreadBase), the conditional collapses to
    // `false` and the assignment fails to typecheck.
    type _CommitsAheadSig =
      typeof commitsAhead extends PredicateHandler<number | CommitsAheadArgs>
        ? true
        : false;
    const _checkCommitsAhead: _CommitsAheadSig = true;
    void _checkCommitsAhead;
    assert.ok(true);
  });

  it("`isClean` is `PredicateHandler<boolean | { value: boolean }>`", () => {
    type _IsCleanSig =
      typeof isClean extends PredicateHandler<boolean | { value: boolean }>
        ? true
        : false;
    const _checkIsClean: _IsCleanSig = true;
    void _checkIsClean;
    assert.ok(true);
  });

  it("`hasStagedChanges` is `PredicateHandler<boolean | { value: boolean }>`", () => {
    type _HasStagedSig =
      typeof hasStagedChanges extends PredicateHandler<
        boolean | { value: boolean }
      >
        ? true
        : false;
    const _checkHasStaged: _HasStagedSig = true;
    void _checkHasStaged;
    assert.ok(true);
  });
});
