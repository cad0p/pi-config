// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Type + runtime tests for the not-block onUnknown semantics +
 * per-predicate typing introduced alongside the trinary
 * `PredicateHandler` widening.
 *
 * Two surfaces under test:
 *
 *   1. Reserved-key registration error \u2014 plugin-merger throws at
 *      config-resolve time when a plugin attempts to register a
 *      predicate with a name reserved by the schema (currently
 *      `"not"`, `"onUnknown"` \u2014 the runtime mirror of
 *      {@link ReservedPredicateKey}).
 *
 *   2. Type-vs-runtime sync \u2014 the runtime constant
 *      `RESERVED_PREDICATE_KEYS` and the type-level
 *      `ReservedPredicateKey` derive lockstep from
 *      `OperatorField | keyof PredicateModifiers`. A future maintainer
 *      who adds a modifier key (or operator field) without updating
 *      both surfaces is caught by the type-level
 *      `_RESERVED_PREDICATE_KEYS_COVERS_TYPE` assertion in
 *      `evaluator-internals/predicates.ts`. This test additionally
 *      pins the runtime constant's contents so a typo or accidental
 *      reorder gets a fixture-level diff.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTrackedHost } from "./__test-helpers__.ts";
import { buildEvaluator } from "./evaluator.ts";
import {
  isReservedPredicateKey,
  MODIFIER_KEYS,
  RESERVED_PREDICATE_KEYS,
  validateWhenClauseShape,
} from "./evaluator-internals/predicates.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import type {
  BuiltInWhenLeaves,
  BuiltInWhenLeavesInner,
  BuiltInWhenLeavesOuter,
  Plugin,
  PredicateModifiers,
  PredicateShape,
  ReservedPredicateKey,
  Rule,
  TopLevelWhenClause,
  TopLevelWhenClauseNoRecurse,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Reserved-key registration check (plugin-merger records error-class diagnostic)
// ---------------------------------------------------------------------------

describe("plugin-merger: reserved predicate key registration check", () => {
  it("records an error-class diagnostic when a plugin registers `not` as a predicate name", () => {
    const plugin: Plugin = {
      name: "evil",
      predicates: {
        // Direct collision with the `not?:` operator field on
        // TopLevelWhenClause.
        not: () => true,
      },
    };
    const state = resolvePlugins([plugin], {});
    const hit = state.diagnostics.find(
      (d) => d.kind === "reserved-predicate-key",
    );
    assert.ok(
      hit,
      `expected a reserved-predicate-key diagnostic; got: ${JSON.stringify(state.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
    assert.match(hit.message, /reserved predicate key "not"/);
  });

  it("records an error-class diagnostic when a plugin registers `onUnknown` as a predicate name", () => {
    const plugin: Plugin = {
      name: "evil",
      predicates: {
        // Direct collision with the `onUnknown?:` modifier on
        // PredicateModifiers (consumed by the leaf adapter at the
        // outer level and by the not-block evaluator inside `not:`).
        onUnknown: () => true,
      },
    };
    const state = resolvePlugins([plugin], {});
    const hit = state.diagnostics.find(
      (d) => d.kind === "reserved-predicate-key",
    );
    assert.ok(hit);
    assert.equal(hit.type, "error");
    assert.match(hit.message, /reserved predicate key "onUnknown"/);
  });

  it("`onUnknown` collision suggests `unknownPolicy` (modifier-collision suggestion convention)", () => {
    // Pins the modifier-domain-flavored suggestion for `onUnknown:`
    // collisions (per the convention documented on plugin-merger.ts:
    // modifier collisions prefer alternatives including the modifier's
    // domain). The generic `"isNot", "negate"` operator-collision
    // suggestion isn't relevant for an `onUnknown:` collision; the
    // suggestion text must point at `unknownPolicy` /
    // `walkerUnknownPolicy` so a plugin author lands at a semantically
    // related alternative.
    const plugin: Plugin = {
      name: "evil",
      predicates: { onUnknown: () => true },
    };
    const state = resolvePlugins([plugin], {});
    const hit = state.diagnostics.find(
      (d) => d.kind === "reserved-predicate-key",
    );
    assert.ok(hit);
    assert.match(hit.message, /unknownPolicy/);
  });

  it("diagnostic message includes the offending plugin name and a suggested alternative", () => {
    const plugin: Plugin = {
      name: "my-plugin",
      predicates: { not: () => true },
    };
    const state = resolvePlugins([plugin], {});
    const hit = state.diagnostics.find(
      (d) => d.kind === "reserved-predicate-key",
    );
    assert.ok(hit);
    assert.match(hit.message, /Plugin "my-plugin"/);
    assert.match(hit.message, /isNot/); // suggested alternative
    assert.match(hit.message, /not, onUnknown/); // full reserved set listed
  });

  it("accepts non-reserved names \u2014 sanity check that the throw is targeted", () => {
    const plugin: Plugin = {
      name: "good",
      predicates: {
        myCustomPredicate: () => true,
        isClean: () => true, // built-in name is fine \u2014 it's a normal collision
      },
    };
    assert.doesNotThrow(() => resolvePlugins([plugin], {}));
  });
});

// ---------------------------------------------------------------------------
// Type \u2194 runtime sync pin
// ---------------------------------------------------------------------------

describe("RESERVED_PREDICATE_KEYS: type \u2194 runtime sync pin", () => {
  it("matches the {OperatorField, modifier keys} fixture so additions get a loud diff", () => {
    // Pinned fixture so adding a new modifier or operator without
    // updating the runtime list (or the matching type union) gets a
    // loud test-level diff. The type-level assertion in
    // `evaluator-internals/predicates.ts` already catches the
    // drift in the OPPOSITE direction (runtime list missing a type
    // member); this test catches the direction the type-level
    // assertion can't (fixture pinning the literal contents).
    assert.deepEqual(
      [...RESERVED_PREDICATE_KEYS].sort(),
      ["not", "onUnknown"].sort(),
    );
  });

  it("isReservedPredicateKey covers every entry in RESERVED_PREDICATE_KEYS", () => {
    for (const key of RESERVED_PREDICATE_KEYS) {
      assert.equal(
        isReservedPredicateKey(key),
        true,
        `isReservedPredicateKey("${key}") should be true`,
      );
    }
  });

  it("isReservedPredicateKey returns false for non-reserved keys", () => {
    assert.equal(isReservedPredicateKey("cwd"), false);
    assert.equal(isReservedPredicateKey("branch"), false);
    assert.equal(isReservedPredicateKey("commitsAhead"), false);
    assert.equal(isReservedPredicateKey("missing"), false);
    assert.equal(isReservedPredicateKey("condition"), false);
  });

  it("type assignment: runtime entries are assignable to ReservedPredicateKey", () => {
    // Compile-time pin via assignment. If a future maintainer
    // adds a runtime entry that drifts from the type union, this
    // assignment fails to compile.
    const _checked: readonly ReservedPredicateKey[] = RESERVED_PREDICATE_KEYS;
    assert.ok(_checked.length > 0);
  });
});

// ---------------------------------------------------------------------------
// MODIFIER_KEYS ↔ keyof PredicateModifiers sync pin
// ---------------------------------------------------------------------------

describe("MODIFIER_KEYS: type ↔ runtime sync pin", () => {
  it("validateWhenClauseShape strips `onUnknown` when counting leaves (modifier-only outer block throws)", () => {
    // If `onUnknown` ever drops out of MODIFIER_KEYS, an outer
    // block with only `onUnknown:` would count it as a leaf and
    // the validator would PASS — masking the empty-clause foot-gun.
    // This tests the runtime side of the sync pin.
    assert.throws(
      () =>
        validateWhenClauseShape(
          { onUnknown: "block" } as unknown as TopLevelWhenClause<string>,
          'rule "r".when',
        ),
      /contains no predicate leaves/,
    );
  });

  it("MODIFIER_KEYS runtime constant matches `keyof PredicateModifiers` exactly", () => {
    // Runtime + compile-time pin: the runtime list and the type-level
    // modifier surface must agree. The type-level
    // `_MODIFIER_KEYS_COVERS_TYPE` constant in
    // `evaluator-internals/predicates.ts` fails compilation when
    // `keyof PredicateModifiers` extends to a key the runtime list
    // missed; this fixture pins the literal contents so a typo or
    // reorder gets a test-level diff. Adding a future modifier
    // (e.g., v0.2 `priority?:`) requires updating both surfaces.
    const expected: readonly (keyof PredicateModifiers)[] = ["onUnknown"];
    assert.deepEqual([...MODIFIER_KEYS].sort(), [...expected].sort());
  });
});

// ---------------------------------------------------------------------------
// Rule.when wired to TopLevelWhenClause<Writes>
// ---------------------------------------------------------------------------

describe("Rule.when: registry-driven mapped type wireup", () => {
  it("NonNullable<Rule['when']> is structurally identical to TopLevelWhenClause<string>", () => {
    // Compile-only assertion. If `BaseRule.when` ever regresses to
    // the legacy `WhenClause` (loose index signature), this fails to
    // typecheck — the registry-driven mapped type's narrow domain is
    // not assignable to a wider permissive interface.
    type RuleWhenIsTopLevel =
      NonNullable<Rule["when"]> extends TopLevelWhenClause<string>
        ? TopLevelWhenClause<string> extends NonNullable<Rule["when"]>
          ? true
          : false
        : false;
    const _identity: RuleWhenIsTopLevel = true;
    void _identity;
    assert.ok(true);
  });

  it("rule-level onUnknown: is forbidden against the actual Rule type", () => {
    const _r: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: {
        cwd: /work/,
        // @ts-expect-error — rule-level onUnknown: is not on TopLevelWhenClause.
        onUnknown: "block",
      },
    };
    assert.ok(_r.name === "r");
  });

  it("leaf-level onUnknown: inside not: is forbidden against the actual Rule type", () => {
    const _r: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: {
        not: {
          // @ts-expect-error — InnerValue<"branch"> excludes leaf-level modifiers.
          branch: { pattern: /main/, onUnknown: "allow" },
        },
      },
    };
    assert.ok(_r.name === "r");
  });

  it("not: not: recursion is forbidden against the actual Rule type", () => {
    const _r: Rule = {
      name: "r",
      tool: "bash",
      command: "git",
      reason: "r",
      when: {
        not: {
          // @ts-expect-error — TopLevelWhenClauseNoRecurse has no `not?:` field.
          not: { cwd: /work/ },
        },
      },
    };
    assert.ok(_r.name === "r");
  });
});

// ---------------------------------------------------------------------------
// Runtime nested-not: guard (catches JSON / `as any` escape hatches)
// ---------------------------------------------------------------------------

describe("validateWhenClauseShape: nested-not: rejection", () => {
  it("throws on `when: { not: { not: { cwd: P } } }` directly", () => {
    assert.throws(
      () =>
        validateWhenClauseShape(
          {
            not: { not: { cwd: /work/ } },
          } as unknown as TopLevelWhenClause<string>,
          'rule "r".when',
        ),
      /contains a nested 'not:' key/,
    );
  });

  it("throws at buildEvaluator config-resolve time when a rule slips a nested not: through `as any`", () => {
    const rule: Rule = {
      name: "nested-not-via-cast",
      tool: "bash",
      command: "git",
      reason: "r",
      when: { not: { not: { cwd: /work/ } } } as unknown as NonNullable<
        Rule["when"]
      >,
    };
    assert.throws(
      () =>
        buildEvaluator(
          { rules: [rule] },
          resolvePlugins([], {}),
          makeTrackedHost(),
        ),
      /contains a nested 'not:' key/,
    );
  });

  it("the error message names the path and explains why nested not: is forbidden", () => {
    assert.throws(
      () =>
        validateWhenClauseShape(
          {
            not: { not: { cwd: /work/ } },
          } as unknown as TopLevelWhenClause<string>,
          'rule "my-rule".when',
        ),
      (err: Error) => {
        assert.match(err.message, /'rule "my-rule"\.when\.not'/);
        assert.match(err.message, /Use a single 'not:' wrapper/);
        return true;
      },
    );
  });

  it("throws on a JSON-deserialized nested-not (the JSON / `as any` escape hatch the type-level ban can't catch)", () => {
    // Pins the runtime-guard's primary justification: a config
    // loaded from JSON or hand-typed via an `as any` cast bypasses
    // the type-level ban on `TopLevelWhenClauseNoRecurse.not`. The
    // runtime check in validateWhenClauseShape is the only line of
    // defense for that path.
    const fromJson = JSON.parse(
      '{"not": {"not": {"cwd": "/work/"}}}',
    ) as unknown;
    assert.throws(
      () =>
        validateWhenClauseShape(
          fromJson as TopLevelWhenClause<string>,
          'rule "r".when',
        ),
      /contains a nested 'not:' key/,
    );
  });

  it("throws on `when: { not: { not: { not: P } } }` (depth-3 recursion stays rejected)", () => {
    // Pins the recursion contract beyond depth-2. The validator
    // recurses into the not-block and runs the same nested-not
    // check; depth-3 must reject at the second level (the inner
    // `not.not` of the outer block).
    assert.throws(
      () =>
        validateWhenClauseShape(
          {
            not: { not: { not: { cwd: /work/ } } },
          } as unknown as TopLevelWhenClause<string>,
          'rule "r".when',
        ),
      /contains a nested 'not:' key/,
    );
  });
});

// ---------------------------------------------------------------------------
// BuiltInWhenLeaves shape pin
// ---------------------------------------------------------------------------

describe("BuiltInWhenLeaves: shape pin", () => {
  it("BuiltInWhenLeaves contains exactly { missing, condition, cwd, subcommand, flag }", () => {
    // Compile-only assertion. If a future change adds a new built-in
    // non-registry leaf (e.g., `tool?:`) without updating the pin, this
    // fails to typecheck — forces a deliberate decision rather than
    // silently widening the surface that ships with the engine itself.
    type _BuiltInShape = keyof BuiltInWhenLeaves extends
      | "missing"
      | "condition"
      | "cwd"
      | "subcommand"
      | "flag"
      ? true
      : false;
    const _b: _BuiltInShape = true;
    void _b;
    assert.ok(true);
  });

  it("BuiltInWhenLeavesOuter and BuiltInWhenLeavesInner share the same key set", () => {
    // Outer/Inner split formalizes the leaf-level `onUnknown:` ban
    // inside `not:` (parity with registry-driven inner predicates).
    // Both flavors carry `missing?:`, `condition?:`, `cwd?:`,
    // `subcommand?:`, `flag?:`; only the spread shapes differ
    // (`onUnknown?:` dropped inside `not:`).
    type _OuterKeys = keyof BuiltInWhenLeavesOuter extends
      | "missing"
      | "condition"
      | "cwd"
      | "subcommand"
      | "flag"
      ? true
      : false;
    type _InnerKeys = keyof BuiltInWhenLeavesInner extends
      | "missing"
      | "condition"
      | "cwd"
      | "subcommand"
      | "flag"
      ? true
      : false;
    const _outer: _OuterKeys = true;
    const _inner: _InnerKeys = true;
    void _outer;
    void _inner;
    assert.ok(true);
  });

  it("BuiltInWhenLeavesInner.cwd spread shape forbids leaf-level onUnknown", () => {
    // The asymmetry: outer `cwd:` allows `{ pattern, onUnknown? }`;
    // inner `cwd:` (inside `not:`) drops `onUnknown?:` because the
    // engine reads the block-level modifier inside `not:` (default
    // `"block"` = fail-CLOSED). A leaf-level `onUnknown:` inside
    // `not:` would silently lose, masking a fail-OPEN authoring
    // error. Pin the constraint with a positive Inner spread (no
    // `onUnknown:`) and an Outer spread (with `onUnknown:`).
    const innerSpread: NonNullable<BuiltInWhenLeavesInner["cwd"]> = {
      pattern: /work/,
    };
    const outerSpread: NonNullable<BuiltInWhenLeavesOuter["cwd"]> = {
      pattern: /work/,
      onUnknown: "allow",
    };
    assert.ok(innerSpread !== undefined);
    assert.ok(outerSpread !== undefined);
  });

  it("Rule.when rejects leaf-level onUnknown on cwd inside not:", () => {
    // Empirical type-pin: the silent fail-OPEN shape
    // `not: { cwd: { pattern, onUnknown: "allow" } }` must NOT
    // typecheck under the new Outer/Inner split. The `not:` body
    // resolves to `TopLevelWhenClauseNoRecurse` which intersects with
    // `BuiltInWhenLeavesInner` (where `cwd:`'s spread drops the
    // `onUnknown?:` field). Block-level `onUnknown:` lives on the
    // outer `not:` block via `& PredicateModifiers` and is the
    // canonical placement.
    const _ban: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: {
        not: {
          cwd: {
            pattern: /work/,
            // @ts-expect-error: leaf-level onUnknown forbidden inside not: (parity with registry predicates)
            onUnknown: "allow",
          },
        },
      },
    };
    void _ban;

    // Sibling positive cases: bare cwd inside not:, and block-level
    // onUnknown on the not: block, both must typecheck cleanly.
    const _bareInsideNot: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: { not: { cwd: /work/ } },
    };
    void _bareInsideNot;

    const _blockLevel: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: { not: { cwd: /work/, onUnknown: "block" } },
    };
    void _blockLevel;

    assert.ok(true);
  });

  it("Rule.when rejects leaf-level onUnknown on subcommand/flag inside not:", () => {
    // Same silent fail-OPEN ban as `cwd:` above, extended to the ARGV
    // leaves (issue #90): inner spreads carry no `onUnknown?:` — the
    // block-level modifier owns the walker-unknown projection.
    const _banSub: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: {
        not: {
          subcommand: {
            anyOf: ["push"],
            // @ts-expect-error: leaf-level onUnknown forbidden inside not:
            onUnknown: "allow",
          },
        },
      },
    };
    void _banSub;
    const _banFlag: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: {
        not: {
          flag: {
            anyOf: [{ aliases: ["--force"], takesValue: false }],
            // @ts-expect-error: leaf-level onUnknown forbidden inside not:
            onUnknown: "allow",
          },
        },
      },
    };
    void _banFlag;

    // Sibling positives: bare + spread ARGV leaves inside not:, and
    // block-level onUnknown alongside them, all typecheck cleanly.
    const _ok: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: {
        not: {
          subcommand: { anyOf: [["s3", "ls"]] },
          flag: {
            anyOf: [{ aliases: ["-f"], takesValue: false }],
          },
          onUnknown: "block",
        },
      },
    };
    void _ok;

    assert.ok(true);
  });

  it("Rule.when rejects spread shape on outer condition: (bare PredicateFn only)", () => {
    // Negative type-pin: `condition?:` is bare-`PredicateFn`-typed at
    // every placement (outer + inner). Future widening to a
    // {@link PredicateShape} that admits a leaf-level `onUnknown:`
    // modifier would silently bypass the engine's outer
    // `condition:` contract (default `"block"` policy hard-coded;
    // authors needing fail-OPEN wrap inside `not: { condition: fn,
    // onUnknown: "allow" }`). Pin the constraint at the authoring
    // surface so any future shape-widening trips the typecheck gate
    // instead of regressing the contract silently.
    const _banSpread: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: {
        // @ts-expect-error: condition?: is bare PredicateFn — spread shape forbidden
        condition: { value: () => true, onUnknown: "allow" },
      },
    };
    void _banSpread;

    // Sibling positive cases: bare callback at outer + inside `not:`.
    const _bareOuter: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: { condition: () => true },
    };
    void _bareOuter;

    const _bareInner: Rule = {
      name: "x",
      tool: "bash",
      command: "x",
      reason: "x",
      when: { not: { condition: () => true } },
    };
    void _bareInner;

    assert.ok(true);
  });
});
