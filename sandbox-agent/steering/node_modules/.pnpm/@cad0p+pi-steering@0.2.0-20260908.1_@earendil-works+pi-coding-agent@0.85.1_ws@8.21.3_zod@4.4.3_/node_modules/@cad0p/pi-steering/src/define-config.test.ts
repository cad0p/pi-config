// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Type-inference + runtime tests for {@link defineConfig}.
 *
 * The main value of `defineConfig` is compile-time — typos in
 * `observer: "description-read"` (when the plugin actually registers
 * `description-reads`) should be REJECTED at type-check. `@ts-expect-error`
 * in this file serves as the assertion: if the type machinery stops
 * catching the typo, the `@ts-expect-error` directive itself errors at
 * type-check and the file fails to compile.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginExemptionsCheck } from "./define-config.ts";
import { defineConfig } from "./define-config.ts";
import shippedGitPlugin from "./plugins/git/index.ts";
import shippedRmPlugin from "./plugins/rm/index.ts";
import type { Observer, Plugin, PredicateContext } from "./schema.ts";

// Type-equality helper for direct type-identity assertions. Pinning
// `Equal<X, Y>` to `true` forces a same-CR test update if `X` widens
// or narrows — catches partial regressions the behavioral typo-check
// can miss (e.g. dropping one literal from a union of four would leave
// the other three positive cases passing while silently weakening the
// fence).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const readObserver = {
  name: "description-reads",
  onResult: () => {},
} as const satisfies Observer;

const syncObserver = {
  name: "sync-done",
  onResult: () => {},
} as const satisfies Observer;

const gitPlugin = {
  name: "git",
  observers: [{ name: "branch-changed", onResult: () => {} }],
} as const satisfies Plugin;

describe("defineConfig: runtime behavior", () => {
  it("returns a SteeringConfig with the fields the caller passed", () => {
    const cfg = defineConfig({
      defaultNoOverride: true,
      plugins: [gitPlugin],
      observers: [readObserver],
      rules: [
        {
          name: "some-rule",
          tool: "bash",
          command: "x",
          reason: "r",
          observer: "description-reads",
        },
      ],
    });
    assert.equal(cfg.defaultNoOverride, true);
    assert.equal(cfg.plugins?.[0]?.name, "git");
    assert.equal(cfg.observers?.[0]?.name, "description-reads");
    assert.equal(cfg.rules?.[0]?.observer, "description-reads");
  });

  it("normalizes readonly inputs to mutable arrays", () => {
    // Tuple literals from `const`-generics land as readonly; output
    // should be a plain array (SteeringConfig fields aren't readonly).
    // Register rules matching the disabledRules entries so the generic
    // AllRuleNames constraint (ADR §8) accepts them.
    const disables = ["x", "y"] as const;
    const cfg = defineConfig({
      rules: [
        {
          name: "x",
          tool: "bash",
          command: "x",
          reason: "r",
        },
        {
          name: "y",
          tool: "bash",
          command: "x",
          reason: "r",
        },
      ],
      disabledRules: disables,
    });
    assert.deepEqual(cfg.disabledRules, ["x", "y"]);
    // Sanity: the returned array is detached from the input —
    // different reference, so module-scoped sources can't be
    // poisoned by a later mutation downstream of `defineConfig`.
    // (`disabledRules` is `readonly` on the public type, so we can't
    // push to it without a cast — reference inequality is the
    // underlying invariant.)
    assert.notStrictEqual(cfg.disabledRules, disables);
  });

  it("omits keys the caller didn't pass (no undefined leakage)", () => {
    const cfg = defineConfig({});
    assert.deepEqual(Object.keys(cfg), []);
  });
});

describe("defineConfig: type-level checks", () => {
  it("allows observer name references drawn from inline observers", () => {
    const cfg = defineConfig({
      observers: [readObserver, syncObserver],
      rules: [
        {
          name: "r1",
          tool: "bash",
          command: "x",
          reason: "r",
          observer: "description-reads",
        },
        {
          name: "r2",
          tool: "bash",
          command: "x",
          reason: "r",
          observer: "sync-done",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 2);
  });

  it("allows observer name references drawn from plugin observers", () => {
    const cfg = defineConfig({
      plugins: [gitPlugin],
      rules: [
        {
          name: "r-plug",
          tool: "bash",
          command: "x",
          reason: "r",
          observer: "branch-changed",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.observer, "branch-changed");
  });

  it("rejects unknown observer names at type-check", () => {
    const cfg = defineConfig({
      observers: [readObserver] as const,
      rules: [
        {
          name: "r-typo",
          tool: "bash",
          command: "x",
          reason: "r",
          // @ts-expect-error — typo: "description-read" vs. "description-reads".
          observer: "description-read",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 1);
  });

  it("rejects unknown observer names with no observers registered", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "r-no-obs",
          tool: "bash",
          command: "x",
          reason: "r",
          // @ts-expect-error — nothing registered, so any string is invalid.
          observer: "sync-done",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 1);
  });

  it("accepts inline Observer objects regardless of name registry", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "r-inline",
          tool: "bash",
          command: "x",
          reason: "r",
          observer: { name: "ad-hoc", onResult: () => {} },
        },
      ],
    });
    assert.equal(
      typeof cfg.rules?.[0]?.observer === "object"
        ? cfg.rules?.[0]?.observer?.name
        : undefined,
      "ad-hoc",
    );
  });

  it("allows const-asserted tuples of plugins (tuple literal type flows)", () => {
    const pluginTuple = [gitPlugin] as const;
    const cfg = defineConfig({
      plugins: pluginTuple,
      rules: [
        {
          name: "r-tuple",
          tool: "bash",
          command: "x",
          reason: "r",
          observer: "branch-changed",
        },
      ],
    });
    assert.equal(cfg.plugins?.length, 1);
  });

  it("rule-name omitted `observer` field compiles regardless", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "r-no-observer",
          tool: "bash",
          command: "x",
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.observer, undefined);
  });
});

// ---------------------------------------------------------------------------
// ADR §8 generic constraints — disabledRules / disabledPlugins / writes ↔ missing.
// ---------------------------------------------------------------------------
//
// These tests pin the ADR §8 compile-time contract:
//
//   - `disabledRules` typed against union of registered rule names
//   - `disabledPlugins` typed against union of registered plugin names
//   - `when.missing.event` typed against union of declared `writes`
//
// Same `@ts-expect-error` strategy as above: if the type machinery
// stops enforcing the constraint, the directive itself errors at
// type-check and this file fails to compile.

describe("defineConfig: type constraints (ADR §8)", () => {
  it("disabledRules accepts registered rule names (plugin + user)", () => {
    const plugin = {
      name: "p",
      rules: [
        {
          name: "plugin-rule",
          tool: "bash",
          command: "x",
          reason: "r",
        },
      ],
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [plugin],
      rules: [
        {
          name: "user-rule",
          tool: "bash",
          command: "x",
          reason: "r",
        },
      ],
      disabledRules: ["plugin-rule", "user-rule"],
    });
    assert.deepEqual(cfg.disabledRules, ["plugin-rule", "user-rule"]);
  });

  it("disabledRules rejects unknown rule names at type-check", () => {
    const plugin = {
      name: "p",
      rules: [
        {
          name: "known-rule",
          tool: "bash",
          command: "x",
          reason: "r",
        },
      ],
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [plugin],
      // @ts-expect-error — "unknown-rule" is not a registered rule name.
      disabledRules: ["unknown-rule"],
    });
    assert.equal(cfg.disabledRules?.length, 1);
  });

  it("disabledPlugins accepts registered plugin names", () => {
    const p1 = { name: "p1" } as const satisfies Plugin;
    const p2 = { name: "p2" } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [p1, p2],
      disabledPlugins: ["p1"],
    });
    assert.deepEqual(cfg.disabledPlugins, ["p1"]);
  });

  it("disabledPlugins rejects unknown plugin names at type-check", () => {
    const p1 = { name: "p1" } as const satisfies Plugin;
    const p2 = { name: "p2" } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [p1, p2],
      // @ts-expect-error — "p3" is not a registered plugin.
      disabledPlugins: ["p3"],
    });
    assert.equal(cfg.disabledPlugins?.length, 1);
  });

  it("when.missing.event rejects strings outside the writes union", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "r",
          writes: ["allowed-type"],
          when: {
            missing: {
              // @ts-expect-error — "forbidden-type" not in writes union.
              event: "forbidden-type",
              in: "agent_loop",
            },
          },
        },
      ],
    });
    assert.equal(cfg.rules?.length, 1);
  });

  it("when.missing.event accepts strings in the rule's own writes union", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "r",
          writes: ["self-type"],
          when: { missing: { event: "self-type", in: "agent_loop" } },
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "r");
  });

  it("when.missing.event accepts strings from an inline observer's writes", () => {
    const observer = {
      name: "obs",
      writes: ["sync-done"],
      onResult: () => {},
    } as const satisfies Observer;
    const cfg = defineConfig({
      observers: [observer],
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "r",
          when: { missing: { event: "sync-done", in: "agent_loop" } },
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.when?.missing?.event, "sync-done");
  });

  it("when.missing.event accepts strings from a plugin rule's writes", () => {
    const plugin = {
      name: "p",
      rules: [
        {
          name: "pr",
          tool: "bash",
          command: "x",
          reason: "r",
          writes: ["plugin-type"],
        },
      ],
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [plugin],
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "r",
          when: { missing: { event: "plugin-type", in: "agent_loop" } },
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.when?.missing?.event, "plugin-type");
  });

  it("when.missing.event accepts strings from a plugin observer's writes", () => {
    const plugin = {
      name: "p",
      observers: [
        {
          name: "obs",
          writes: ["plugin-obs-type"],
          onResult: () => {},
        },
      ],
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [plugin],
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "r",
          when: {
            missing: { event: "plugin-obs-type", in: "agent_loop" },
          },
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.when?.missing?.event, "plugin-obs-type");
  });

  it("G10 — Plugin.predicates accepts typed-arg handlers without a cast", () => {
    // Pins Item 2 of PR #5: `Plugin.predicates` is now
    // `Record<string, AnyPredicateHandler>` (where
    // `AnyPredicateHandler = PredicateHandler<any>`), which leverages
    // TS's bivariance fallback so a specifically-typed handler
    // assigns into the registry slot directly — no cast, no
    // `definePredicate` wrapper needed at the plug-in site.
    //
    // Pre-Item-2 this test pinned the OPPOSITE behavior (typed-arg
    // handlers were rejected by the `PredicateHandler<unknown>` slot,
    // motivating `definePredicate`). If TS's variance rules change
    // under us the `@ts-expect-error` version of this test would
    // reappear in git history — `definePredicate` is still exported
    // for handler AUTHORS who want the generic narrowing sugar on
    // their handler declaration.
    const plugin: Plugin = {
      name: "p",
      predicates: {
        commitFormat: (_args: { pattern: RegExp }, _ctx: PredicateContext) =>
          true,
      },
    };
    assert.equal(plugin.name, "p");
  });
});

describe("defineConfig: bare-annotation footgun (ADR §8 authoring pattern)", () => {
  // These tests pin the ASYMMETRIC failure modes of bare type annotations
  // vs. `as const satisfies` so the JSDoc authoring-pattern guidance in
  // `schema.ts` (Rule.writes / Observer.writes / Plugin.name) stays
  // truthful. If TS's literal-inference behavior changes under us, or a
  // refactor narrows/widens one of the helper types, these tests will
  // surface the change loud enough to update the docs.
  //
  // The two failure modes:
  //   - NAME fields (plugin.name, rule.name): bare annotation widens to
  //     `string`, which makes `AllPluginNames` / `AllRuleNames` = `string`.
  //     Typos in `disabledRules` / `disabledPlugins` then compile silently.
  //     This is the "no typo detection" footgun.
  //   - `writes` arrays: bare annotation widens `readonly ["x"]` to
  //     `readonly string[]`, which can't project string literals, so
  //     `AllWrites` collapses to `never`. EVERY `when.missing.event`
  //     reference is rejected. This is the "can't use writes at all"
  //     failure — louder, but still a footgun if you don't know why.

  it("bare `: Plugin` annotation widens `name` — typos in disabledPlugins compile silently", () => {
    const widePlugin: Plugin = { name: "known-plugin" };
    // No @ts-expect-error: this COMPILES cleanly because `widePlugin.name`
    // has type `string`, so `AllPluginNames` = `string`, so any string
    // satisfies `disabledPlugins`. If TS future-fixes literal inference
    // on bare annotations OR a refactor narrows `AllPluginNames`, this
    // line starts erroring — signal to update the JSDoc footgun note.
    const cfg = defineConfig({
      plugins: [widePlugin],
      disabledPlugins: ["typo-name"],
    });
    assert.equal(cfg.disabledPlugins?.[0], "typo-name");
  });

  it("`as const satisfies Plugin` preserves `name` — typos caught at type-check", () => {
    const narrowPlugin = { name: "known-plugin" } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [narrowPlugin],
      // @ts-expect-error — "typo-name" not in AllPluginNames union
      // (which is the literal "known-plugin" thanks to `as const`).
      disabledPlugins: ["typo-name"],
    });
    assert.equal(cfg.disabledPlugins?.length, 1);
  });

  it("bare `: Observer` annotation widens `writes` — collapses AllWrites to never", () => {
    const wideObserver: Observer = {
      name: "obs",
      writes: ["sync-done"],
      onResult: () => {},
    };
    const cfg = defineConfig({
      observers: [wideObserver],
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "r",
          // @ts-expect-error — bare-annotated observer widens
          // `writes` to `readonly string[]`, which collapses
          // `AllWrites` to `never`. "sync-done" is rejected even
          // though it IS in the runtime value — type info was lost
          // at annotation time.
          when: { missing: { event: "sync-done", in: "agent_loop" } },
        },
      ],
    });
    assert.equal(cfg.rules?.length, 1);
  });

  it("`as const satisfies Observer` preserves `writes` — type is referenceable", () => {
    const narrowObserver = {
      name: "obs",
      writes: ["sync-done"],
      onResult: () => {},
    } as const satisfies Observer;
    const cfg = defineConfig({
      observers: [narrowObserver],
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "r",
          when: { missing: { event: "sync-done", in: "agent_loop" } },
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.when?.missing?.event, "sync-done");
  });
});

describe("defineConfig: rule + plugin name unions track declared plugins", () => {
  // Post-cut (#72): `AllRuleNames` / `AllPluginNames` project ONLY
  // from declared plugins + inline rules — there is no engine-default
  // arm. A stale `disabledRules` entry targeting an ex-default rule
  // name without its shipping plugin declared is a COMPILE ERROR;
  // declaring the plugin re-enters the name via `FromPluginField`.

  it("disabledRules accepts a shipped rule name once its plugin is declared", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      disabledRules: ["no-force-push"],
    });
    assert.deepEqual(cfg.disabledRules, ["no-force-push"]);
  });

  it("disabledRules rejects an ex-default name WITHOUT its shipping plugin (compile error)", () => {
    const cfg = defineConfig({
      plugins: [shippedRmPlugin],
      // @ts-expect-error — "no-force-push" ships with the git plugin,
      // which this config does NOT declare. Since #72 there are no
      // engine defaults to keep the name in the union; a leftover
      // disable of a never-declared rule is a compile-time error.
      disabledRules: ["no-force-push"],
    });
    assert.equal(cfg.disabledRules?.length, 1);
  });

  it("disabledRules accepts names across several shipping plugins + user rules", () => {
    const plugin = {
      name: "p",
      rules: [
        {
          name: "plugin-rule",
          tool: "bash",
          command: "git",
          reason: "r",
        },
      ],
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin, plugin],
      rules: [
        {
          name: "user-rule",
          tool: "bash",
          command: "rm",
          reason: "r",
        },
      ],
      disabledRules: [
        "no-force-push",
        "no-rm-rf-slash",
        "plugin-rule",
        "user-rule",
      ],
    });
    assert.equal(cfg.disabledRules?.length, 4);
  });

  it("disabledRules rejects misspellings of a shipped rule name", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      // @ts-expect-error — "no-force-pushh" is a typo of the git
      // plugin's "no-force-push".
      disabledRules: ["no-force-pushh"],
    });
    assert.equal(cfg.disabledRules?.length, 1);
  });

  it("disabledPlugins rejects a plugin name that was never declared", () => {
    const cfg = defineConfig({
      // @ts-expect-error — "git" is opt-in and undeclared here;
      // disabling an undeclared plugin is a typo or a misunderstanding
      // — rejected at compile time.
      disabledPlugins: ["git"],
    });
    assert.equal(cfg.disabledPlugins?.length, 1);
  });

  it("disabledPlugins accepts a mix of declared + user plugin names", () => {
    const userPlugin = { name: "my-plugin" } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [shippedGitPlugin, userPlugin],
      disabledPlugins: ["git", "my-plugin"],
    });
    assert.equal(cfg.disabledPlugins?.length, 2);
  });

  it("disabledPlugins rejects misspellings of a declared plugin name", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      // @ts-expect-error — "gti" is a typo of the DECLARED plugin
      // "git". Declared plugin names are part of the typo-check
      // union; misspellings are rejected at compile time.
      disabledPlugins: ["gti"],
    });
    assert.equal(cfg.disabledPlugins?.length, 1);
  });

  it("empty config: both unions collapse to never (any disable entry errors)", () => {
    // With nothing declared there is nothing to disable — the
    // headline type-level guarantee of the cut.
    const cfg = defineConfig({
      // @ts-expect-error — no rules declared at all.
      disabledRules: ["no-force-push"],
    });
    assert.equal(cfg.disabledRules?.length, 1);
  });
});

describe("defineConfig: cross-module plugin typo detection (F2 regression fence)", () => {
  // The F2 finding: gitPlugin's emitted .d.ts was widening rule names
  // to `Rule<string, string>[]`, which silently disabled typo detection
  // on `disabledRules: [...]` for consumers importing the shipped plugin.
  // `as const satisfies Rule` at the source and `as const satisfies
  // readonly Rule[]` on the collection preserve the tuple + literals.
  //
  // These tests pin that the SHIPPED `gitPlugin` (not an inline copy)
  // carries literal rule names through to `defineConfig` generics.
  // If the widening regresses, the @ts-expect-error directives stop
  // firing and these tests fail to compile — loud signal.

  it("disabledRules accepts rule names from the imported gitPlugin", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      disabledRules: ["no-main-commit"],
    });
    assert.equal(cfg.disabledRules?.[0], "no-main-commit");
  });

  it("disabledRules rejects typos in imported-plugin rule names", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      // @ts-expect-error — "no-main-commit-typo" is not a registered
      // rule name on the imported gitPlugin. If this directive stops
      // firing, the .d.ts widening regression documented as F2 in
      // the phase-a3b review has returned.
      disabledRules: ["no-main-commit-typo"],
    });
    assert.equal(cfg.disabledRules?.length, 1);
  });

  it("disabledPlugins accepts the imported gitPlugin's name", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      disabledPlugins: ["git"],
    });
    assert.equal(cfg.disabledPlugins?.[0], "git");
  });

  it("disabledPlugins rejects a typo on the imported gitPlugin's name", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      // @ts-expect-error — "gti" is not a registered plugin name.
      disabledPlugins: ["gti"],
    });
    assert.equal(cfg.disabledPlugins?.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Rule discriminated union — `tool` gates the legal `field` values (R4).
//
// These tests pin the (tool, field) combinations that TS accepts and the
// ones it rejects. The discriminated Rule union (BashRule | WriteRule |
// EditRule) replaced a flat `Rule` that accepted any `field` value
// regardless of `tool` — an author could write
// `{ tool: "bash", field: "path", ... }` and the evaluator would
// silently run the rule against the command text (bash always uses the
// extracted command). The union surfaces those typos at compile time.
// ---------------------------------------------------------------------------

describe("Rule discriminated union: tool gates field", () => {
  it("bash + command typechecks", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "bash-ok",
          tool: "bash",
          command: "rm",
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 1);
  });

  it("write + path / content typecheck", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "write-path",
          tool: "write",
          field: "path",
          pattern: /^\/etc\//,
          reason: "r",
        },
        {
          name: "write-content",
          tool: "write",
          field: "content",
          pattern: /SECRET/,
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 2);
  });

  it("edit + path / content typecheck", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "edit-path",
          tool: "edit",
          field: "path",
          pattern: /^\/etc\//,
          reason: "r",
        },
        {
          name: "edit-content",
          tool: "edit",
          field: "content",
          pattern: /SECRET/,
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 2);
  });

  it('write rules reject `field: "command"` (type error)', () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "write-command-bad",
          tool: "write",
          // @ts-expect-error — write rules test `path` / `content`.
          field: "command",
          pattern: /^x/,
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 1);
  });

  it('edit rules reject `field: "command"` (type error)', () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "edit-command-bad",
          tool: "edit",
          // @ts-expect-error — edit rules test `path` / `content`.
          field: "command",
          pattern: /^x/,
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Exemption registry typing (issue #26)
// ---------------------------------------------------------------------------

describe("defineConfig: exemption typing + runtime copy", () => {
  it("exemptions survive the runtime copy (reference-preserving when clauses)", () => {
    const condition = () => true;
    const cfg = defineConfig({
      rules: [
        {
          name: "no-force-push",
          tool: "bash",
          command: "git",
          reason: "r",
        },
      ],
      exemptions: [
        { rule: "no-force-push", when: { cwd: "/vault/" } },
        {
          rule: "no-force-push",
          when: { condition },
        },
      ],
    });
    assert.equal(cfg.exemptions?.length, 2);
    assert.deepEqual(cfg.exemptions?.[0]?.when, { cwd: "/vault/" });
    // Function-typed leaves survive by reference (same object) —
    // mirrors the rules/observers copy semantics.
    assert.equal(cfg.exemptions?.[1]?.when?.condition, condition);
  });

  it("omits exemptions when the caller passed none", () => {
    const cfg = defineConfig({});
    assert.equal(cfg.exemptions, undefined);
  });

  it("exemptions[].rule accepts registered rule names (plugins + inline)", () => {
    const plugin = {
      name: "p",
      rules: [
        {
          name: "plugin-rule",
          tool: "bash",
          command: "git",
          reason: "r",
        },
      ],
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [plugin, shippedGitPlugin],
      rules: [
        {
          name: "user-rule",
          tool: "bash",
          command: "git",
          reason: "r",
        },
      ],
      exemptions: [
        { rule: "plugin-rule", when: { cwd: "/v/" } },
        { rule: "user-rule", when: { cwd: "/v/" } },
        // Shipped rule names are part of the union once their plugin
        // is declared.
        { rule: "no-force-push", when: { cwd: "/v/" } },
      ],
    });
    assert.equal(cfg.exemptions?.length, 3);
  });

  it("exemptions[].rule rejects unknown rule names at type-check", () => {
    const plugin = {
      name: "p",
      rules: [
        {
          name: "known-rule",
          tool: "bash",
          command: "x",
          reason: "r",
        },
      ],
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [plugin],
      exemptions: [
        // @ts-expect-error — "unknown-rule" is not a registered rule name.
        { rule: "unknown-rule", when: { cwd: "/v/" } },
      ],
    });
    assert.equal(cfg.exemptions?.length, 1);
  });

  it("exemptions[].when.missing.event narrows against the writes union", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "consumer",
          tool: "bash",
          command: "x",
          reason: "r",
          writes: ["sync-done"],
        },
      ],
      exemptions: [
        {
          rule: "consumer",
          when: { missing: { event: "sync-done", in: "session" } },
        },
        {
          rule: "consumer",
          when: {
            // @ts-expect-error — "forbidden-type" not in writes union.
            missing: { event: "forbidden-type", in: "session" },
          },
        },
      ],
    });
    assert.equal(cfg.exemptions?.length, 2);
  });

  it("exemptions[].when rejects onUnknown anywhere (type-level ban via ExemptionWhenClause)", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "no-force-push",
          tool: "bash",
          command: "git",
          reason: "r",
        },
      ],
      exemptions: [
        {
          rule: "no-force-push",
          when: {
            cwd: {
              pattern: /x/,
              // @ts-expect-error — onUnknown is forbidden in exemption clauses (strict fail-closed; leaf spread forms lose the modifier).
              onUnknown: "block",
            },
          },
        },
        {
          rule: "no-force-push",
          when: {
            not: {
              cwd: /x/,
              // @ts-expect-error — onUnknown is forbidden in exemption clauses (strict fail-closed; not-block modifier stripped).
              onUnknown: "block",
            },
          },
        },
      ],
    });
    assert.equal(cfg.exemptions?.length, 2);
  });

  it("exemptions[].when accepts every modifier-free form (bare, array, pattern, condition, missing, not:)", () => {
    const cfg = defineConfig({
      rules: [
        {
          name: "no-force-push",
          tool: "bash",
          command: "git",
          reason: "r",
          writes: ["sync-done"],
        },
      ],
      exemptions: [
        // Bare shorthand.
        { rule: "no-force-push", when: { cwd: /x/ } },
        // Array shorthand (OR-of-patterns).
        { rule: "no-force-push", when: { cwd: [/x/, /y/] } },
        // Pattern object WITHOUT onUnknown.
        { rule: "no-force-push", when: { cwd: { pattern: /x/ } } },
        // condition function leaf.
        { rule: "no-force-push", when: { condition: () => true } },
        // missing leaf (writes-narrowed event).
        {
          rule: "no-force-push",
          when: { missing: { event: "sync-done", in: "session" } },
        },
        // not: block without onUnknown.
        { rule: "no-force-push", when: { not: { cwd: /x/ } } },
      ],
    });
    assert.equal(cfg.exemptions?.length, 6);
  });
});

// Issue #29 fixtures — mirror @cad0p/pi-napkin/steering: a plugin whose
// shipped exemptions target rules shipped by the git plugin
// (no-main-commit / no-main-commit-github, see src/plugins/git/rules.ts).
const napkinLike = {
  name: "napkin",
  exemptions: [
    { rule: "no-main-commit", when: { cwd: "/vault/" } },
    { rule: "no-main-commit-github", when: { cwd: "/vault/" } },
  ],
} as const satisfies Plugin;

const napkinPartial = {
  name: "napkin-partial",
  exemptions: [{ rule: "no-such-rule", when: { cwd: "/vault/" } }],
} as const satisfies Plugin;

const napkinDefault = {
  name: "napkin-default",
  exemptions: [{ rule: "no-force-push", when: { cwd: "/vault/" } }],
} as const satisfies Plugin;

const napkinSelf = {
  name: "napkin-self",
  rules: [
    {
      name: "self-rule",
      tool: "bash",
      command: "x",
      reason: "r",
    },
  ],
  exemptions: [{ rule: "self-rule", when: { cwd: "/vault/" } }],
} as const satisfies Plugin;

const napkinInlineTarget = {
  name: "napkin-inline-target",
  exemptions: [{ rule: "user-inline-rule", when: { cwd: "/vault/" } }],
} as const satisfies Plugin;

describe("defineConfig: plugin-shipped exemption targets (issue #29)", () => {
  it("rejects a plugin whose exemption targets are shipped by an unlisted plugin (napkin alone)", () => {
    // napkin's carve-outs target the git plugin's rules; without git in
    // the plugins tuple the targets are orphans — failure moves from a
    // session-start `exemption-orphan` error to compile time, on the
    // offending plugin element's own line.
    const cfg = defineConfig({
      plugins: [
        // @ts-expect-error — napkin's exemption targets (no-main-commit, no-main-commit-github) are shipped by the git plugin, which isn't listed here.
        napkinLike,
      ],
    });
    assert.equal(cfg.plugins?.length, 1);
  });

  it("accepts the napkin plugin when the git plugin is listed (both orders)", () => {
    const cfg = defineConfig({ plugins: [napkinLike, shippedGitPlugin] });
    assert.equal(cfg.plugins?.length, 2);
    const cfgReversed = defineConfig({
      plugins: [shippedGitPlugin, napkinLike],
    });
    assert.equal(cfgReversed.plugins?.length, 2);
  });

  it("rejects a plugin whose exemption target is shipped by nobody, even with git listed", () => {
    const cfg = defineConfig({
      plugins: [
        // @ts-expect-error — "no-such-rule" is shipped by nobody; git's rules don't cover it either.
        napkinPartial,
        shippedGitPlugin,
      ],
    });
    assert.equal(cfg.plugins?.length, 2);
  });

  // Direct type-identity assertions for the failing branch. The
  // behavioral negatives above only prove "some error fires"; these
  // pin the EXACT message union — acceptance #1 requires the message
  // to name the missing rule(s) + the install hint, and pinning the
  // template text here locks it against drift.
  type _Flagged =
    PluginExemptionsCheck<
      readonly [typeof napkinLike],
      readonly []
    > extends infer C
      ? C extends { plugins?: infer PL }
        ? PL
        : never
      : never;
  type _FlaggedMsg = _Flagged extends readonly (infer E)[]
    ? E extends { __steeringExemption: infer M }
      ? M
      : never
    : never;
  type _Pin = Equal<
    _FlaggedMsg,
    | "exemption target 'no-main-commit' not found in this config; install the plugin that ships it"
    | "exemption target 'no-main-commit-github' not found in this config; install the plugin that ships it"
  >;
  const _pinMsg: _Pin = true;
  void _pinMsg;

  type _FlaggedPartial =
    PluginExemptionsCheck<
      readonly [typeof napkinPartial],
      readonly []
    > extends infer C
      ? C extends { plugins?: infer PL }
        ? PL
        : never
      : never;
  type _FlaggedPartialMsg = _FlaggedPartial extends readonly (infer E)[]
    ? E extends { __steeringExemption: infer M }
      ? M
      : never
    : never;
  type _PinPartial = Equal<
    _FlaggedPartialMsg,
    "exemption target 'no-such-rule' not found in this config; install the plugin that ships it"
  >;
  const _pinPartial: _PinPartial = true;
  void _pinPartial;

  // Happy path: a plugin shipping NO exemptions (git) leaves the check
  // at `{}` — zero change to the config parameter type.
  const _pinHappy: Equal<
    PluginExemptionsCheck<readonly [typeof shippedGitPlugin], readonly []>,
    // biome-ignore lint/complexity/noBannedTypes: `{}` is the deliberate happy-path result (zero change).
    {}
  > = true;
  void _pinHappy;

  it("accepts targets that resolve to a declared plugin's, inline, or self-shipped rules", () => {
    // "no-force-push" ships with the git plugin (#72) — the target
    // resolves only because the git plugin is listed alongside.
    const cfgDefault = defineConfig({
      plugins: [napkinDefault, shippedGitPlugin],
    });
    assert.equal(cfgDefault.plugins?.length, 2);
    // "user-inline-rule" is registered as an inline rule in this config.
    const cfgInline = defineConfig({
      plugins: [napkinInlineTarget],
      rules: [
        {
          name: "user-inline-rule",
          tool: "bash",
          command: "x",
          reason: "r",
        },
      ],
    });
    assert.equal(cfgInline.plugins?.length, 1);
    // napkin-self ships BOTH the rule and the exemption targeting it.
    const cfgSelf = defineConfig({ plugins: [napkinSelf] });
    assert.equal(cfgSelf.plugins?.length, 1);
  });

  it("flags EACH offending plugin element when several plugins ship orphan targets", () => {
    const cfg = defineConfig({
      plugins: [
        // @ts-expect-error — napkin's targets need the git plugin listed.
        napkinLike,
        // @ts-expect-error — "no-such-rule" is shipped by nobody.
        napkinPartial,
      ],
    });
    assert.equal(cfg.plugins?.length, 2);

    // Per-element isolation: BOTH tuple positions carry their own
    // `__steeringExemption` message (element 1 names napkin's two
    // targets; element 2 names just its own).
    type _TwoFlagged =
      PluginExemptionsCheck<
        readonly [typeof napkinLike, typeof napkinPartial],
        readonly []
      > extends infer C
        ? C extends { plugins?: infer PL }
          ? PL
          : never
        : never;
    type _TwoMsgs = _TwoFlagged extends readonly [infer E1, infer E2]
      ? [
          E1 extends { __steeringExemption: infer M1 } ? M1 : never,
          E2 extends { __steeringExemption: infer M2 } ? M2 : never,
        ]
      : never;
    type _PinTwo = Equal<
      _TwoMsgs,
      [
        (
          | "exemption target 'no-main-commit' not found in this config; install the plugin that ships it"
          | "exemption target 'no-main-commit-github' not found in this config; install the plugin that ships it"
        ),
        "exemption target 'no-such-rule' not found in this config; install the plugin that ships it",
      ]
    >;
    const _pinTwo: _PinTwo = true;
    void _pinTwo;
  });

  it("skips plugins annotated `: Plugin` (widened rule — can't verify, never false-positive)", () => {
    // The bare annotation widens `exemptions[].rule` to `string`, so
    // the check can't verify the target — it skips instead of
    // flagging. Runtime `exemption-orphan` backstop still covers these.
    const widened: Plugin = {
      name: "widened",
      exemptions: [{ rule: "no-such-rule-anywhere", when: { cwd: "/vault/" } }],
    };
    const cfg = defineConfig({ plugins: [widened] });
    assert.equal(cfg.plugins?.length, 1);
  });

  it("keeps disabledPlugins consistent: disabling a LISTED plugin doesn't orphan its rules' targets", () => {
    // git stays in the plugins tuple, so its rules stay in the
    // rule-name universe (and in the runtime merged universe — a
    // disabled plugin still contributes its rules/exemptions there).
    // No orphan, no false positive.
    const cfg = defineConfig({
      plugins: [napkinLike, shippedGitPlugin],
      disabledPlugins: ["git"],
    });
    assert.equal(cfg.plugins?.length, 2);
  });
});
