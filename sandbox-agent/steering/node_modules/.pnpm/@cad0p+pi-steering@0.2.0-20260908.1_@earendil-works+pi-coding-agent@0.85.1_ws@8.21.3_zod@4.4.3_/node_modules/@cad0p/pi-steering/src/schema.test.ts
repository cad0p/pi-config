// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Runtime shape smoke tests for the v2 schema types.
 *
 * These tests construct object literals and assert their runtime shape —
 * they do NOT currently exercise compile-time type enforcement via
 * `@ts-expect-error` directives. Real type-level regression tests for
 * `defineConfig` inference live in `define-config.test.ts`.
 *
 * The value here is: if the schema types drift incompatibly with their
 * runtime contract (e.g., a field is renamed but the Rule interface
 * isn't updated), these tests fail to compile even without explicit
 * negative assertions. For richer type enforcement, extend with
 * `@ts-expect-error` cases or move to `define-config.test.ts`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { commandFromInput } from "./helpers/command.ts";
import type {
  Observer,
  Plugin,
  PredicateContext,
  PredicateFn,
  PredicateHandler,
  Rule,
  SteeringConfig,
  SteeringDiagnostic,
  TopLevelWhenClause,
  WhenClause,
} from "./schema.ts";

describe("schema: shape smoke tests", () => {
  it("Rule accepts a minimal bash rule with command:", () => {
    const rule: Rule = {
      name: "test",
      tool: "bash",
      command: "git",
      reason: "nope",
    };
    assert.equal(rule.name, "test");
  });

  it("Rule rejects `pattern:` on bash rules (removed, issue #117)", () => {
    const rule: Rule = {
      name: "regex-rule",
      tool: "bash",
      command: "git",
      // @ts-expect-error — bash rules carry no `pattern` (write/edit only).
      pattern: /^git push/,
      requires: /--force/,
      unless: /--force-with-lease/,
      reason: "nope",
    };
    assert.ok(rule.requires instanceof RegExp);
  });

  it("Rule rejects `field:` on bash rules (absorbed by command:, issue #117)", () => {
    const rule: Rule = {
      name: "field-rule",
      tool: "bash",
      command: "git",
      // @ts-expect-error — bash rules carry no `field`.
      field: "command",
      reason: "nope",
    };
    assert.equal(rule.name, "field-rule");
  });

  it("Rule accepts RegExp in requires / unless (transient allowlist)", () => {
    const rule: Rule = {
      name: "regex-rule",
      tool: "bash",
      command: "git",
      requires: /--force/,
      unless: /--force-with-lease/,
      reason: "nope",
    };
    assert.ok(rule.requires instanceof RegExp);
  });

  it("Rule accepts PredicateFn in requires / unless", () => {
    const always: PredicateFn = async (_ctx) => true;
    const rule: Rule = {
      name: "fn-rule",
      tool: "bash",
      command: "git",
      requires: always,
      unless: async (ctx) => ctx.tool === "bash",
      reason: "nope",
    };
    assert.equal(typeof rule.requires, "function");
  });

  it("WhenClause accepts cwd as pattern or object with onUnknown", () => {
    const w1: WhenClause = { cwd: "^/workplace" };
    const w2: WhenClause = { cwd: /^\/workplace/ };
    const w3: WhenClause = {
      cwd: { pattern: /^\/workplace/, onUnknown: "block" },
    };
    assert.ok(w1.cwd !== undefined);
    assert.ok(w2.cwd !== undefined);
    assert.ok(w3.cwd !== undefined);
  });

  it("TopLevelWhenClause accepts subcommand/flag ARGV leaves (issue #90)", () => {
    const w: TopLevelWhenClause = {
      subcommand: "push",
      flag: {
        anyOf: [{ aliases: ["--force"], takesValue: false }],
      },
    };
    const spread: TopLevelWhenClause = {
      subcommand: {
        anyOf: [["s3", "ls"], "push"],
        onUnknown: "block",
      },
    };
    assert.ok(w.subcommand !== undefined);
    assert.ok(w.flag !== undefined);
    assert.ok(spread.subcommand !== undefined);
  });

  it("WhenClause.condition accepts a PredicateFn", () => {
    const w: WhenClause = {
      condition: (ctx) => ctx.tool === "bash",
    };
    assert.equal(typeof w.condition, "function");
  });

  it("WhenClause accepts plugin-registered custom keys", () => {
    // Shape a plugin predicate registers. Consumers widen the
    // index signature to carry arbitrary shapes.
    const w: WhenClause = {
      commitsAhead: { wrt: "origin/main", eq: 1 },
    };
    assert.ok("commitsAhead" in w);
  });

  it("Observer accepts minimal shape (name + onResult)", () => {
    const obs: Observer = {
      name: "spy",
      onResult: (_ev, _ctx) => {},
    };
    assert.equal(obs.name, "spy");
  });

  it("Observer.watch accepts every documented filter", () => {
    const obs: Observer = {
      name: "filtered",
      watch: {
        toolName: "bash",
        inputMatches: { command: /^git/ },
        exitCode: "success",
      },
      onResult: () => {},
    };
    assert.equal(obs.watch?.exitCode, "success");
  });

  it("Plugin accepts every documented extension point", () => {
    const fakeHandler: PredicateHandler<{ wrt: string }> = (args, _ctx) =>
      args.wrt.startsWith("origin/");
    const plugin: Plugin = {
      name: "fake",
      // No cast on the typed `PredicateHandler<{ wrt: string }>` here —
      // Item 2 of PR #5 switched `Plugin.predicates` to
      // `Record<string, AnyPredicateHandler>`, so specifically-typed
      // handlers assign into the registry slot directly.
      predicates: { commitsAhead: fakeHandler },
      rules: [
        {
          name: "r",
          tool: "bash",
          command: "x",
          reason: "n",
        },
      ],
      observers: [{ name: "o", onResult: () => {} }],
      // trackers and trackerExtensions left undefined — the
      // schema-level type is just `Record<string, Tracker<unknown>>`,
      // constructing a live tracker here would pull in walker
      // runtime code we don't need for a shape test.
    };
    assert.equal(plugin.name, "fake");
  });

  it("Plugin.predicates accepts typed PredicateHandler<A> values without a cast", () => {
    // Pins the Item 2 fix: `Plugin.predicates` is
    // `Record<string, AnyPredicateHandler>`, so a specifically-typed
    // `PredicateHandler<FooArgs>` assigns cast-free at the registry
    // slot. If this starts failing to compile, the alias was
    // widened/narrowed incompatibly — every downstream plugin that
    // registers a typed handler will break on the same change.
    interface FooArgs {
      threshold: number;
    }
    const typed: PredicateHandler<FooArgs> = (args) => args.threshold > 0;
    const plugin = {
      name: "typed-predicates",
      predicates: { foo: typed },
    } satisfies Plugin;
    assert.ok(plugin.predicates);
  });

  it("Rule.observer accepts inline Observer and string reference", () => {
    const inline: Rule = {
      name: "inline-obs",
      tool: "bash",
      command: "x",
      reason: "r",
      observer: { name: "o", onResult: () => {} },
    };
    const byName: Rule<"o"> = {
      name: "by-name",
      tool: "bash",
      command: "x",
      reason: "r",
      observer: "o",
    };
    assert.equal(byName.observer, "o");
    assert.ok(typeof inline.observer === "object");
  });

  it("Rule accepts writes + onFire for self-marking patterns", () => {
    const rule: Rule = {
      name: "self-marker",
      tool: "bash",
      command: "x",
      reason: "r",
      writes: ["cr-attempted"],
      onFire: (ctx) => {
        ctx.appendEntry("cr-attempted", {});
      },
    };
    assert.deepEqual(rule.writes, ["cr-attempted"]);
    assert.equal(typeof rule.onFire, "function");
  });

  it("Observer accepts writes declaration", () => {
    const obs: Observer = {
      name: "tracker",
      writes: ["ws-sync-done", "ws-sync-failed"],
      onResult: () => {},
    };
    assert.deepEqual(obs.writes, ["ws-sync-done", "ws-sync-failed"]);
  });

  it("WhenClause.missing accepts the { event, in } shape", () => {
    const loop: WhenClause = {
      missing: { event: "ws-sync-done", in: "agent_loop" },
    };
    const session: WhenClause = {
      missing: { event: "welcome-shown", in: "session" },
    };
    assert.equal(loop.missing?.event, "ws-sync-done");
    assert.equal(session.missing?.in, "session");
  });

  it("SteeringConfig accepts every top-level field", () => {
    const cfg: SteeringConfig = {
      defaultNoOverride: true,
      disabledRules: ["no-force-push"],
      disabledPlugins: ["git"],
      plugins: [],
      rules: [],
      observers: [],
    };
    assert.equal(cfg.defaultNoOverride, true);
  });

  it("SteeringDiagnostic accepts info severity + layer-project-untrusted kind", () => {
    // Pins the trust-gate addition to the type union: info-class
    // diagnostics are normal-behavior breadcrumbs, never escalate.
    const diag: SteeringDiagnostic = {
      type: "info",
      kind: "layer-project-untrusted",
      path: "/proj/.pi/steering",
      message:
        "project layer skipped (project untrusted); global layer still applies",
    };
    assert.equal(diag.type, "info");
    assert.equal(diag.kind, "layer-project-untrusted");
    assert.equal(diag.path, "/proj/.pi/steering");
  });

  it("PredicateContext exposes the documented surface", () => {
    // Pure shape test — we never invoke the context.
    const fake: PredicateContext = {
      cwd: "/",
      tool: "bash",
      input: { tool: "bash", command: "echo" },
      command: commandFromInput({ tool: "bash", command: "echo" }),
      agentLoopIndex: 0,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      appendEntry: () => {},
      findEntries: () => [],
    };
    assert.equal(fake.cwd, "/");
  });
});

describe("package-root exports", () => {
  it("AGENT_LOOP_INDEX_KEY resolves to the on-disk JSONL tag string (C3)", async () => {
    // Pins the public export path. Plugin authors inspecting raw
    // session entries via `findEntries` import the constant instead
    // of hardcoding the string — a future rename would then break at
    // import time, not at runtime.
    const rootExports = await import("./index.ts");
    assert.equal(rootExports.AGENT_LOOP_INDEX_KEY, "_agentLoopIndex");
  });
});

describe("collapse pins (issue #110: two-list seam is gone, not deprecated)", () => {
  it("CLIDescriptor carries flags only (no legacy valueConsumingFlags key)", async () => {
    const { GIT_CLI_DESCRIPTOR } = await import("./plugins/git/descriptors.ts");
    assert.equal(
      "valueConsumingFlags" in (GIT_CLI_DESCRIPTOR as object),
      false,
    );
    assert.ok("flags" in (GIT_CLI_DESCRIPTOR as object));
  });

  it("FlagLookupOptions is deleted from flags.ts and the root (no remnant export)", async () => {
    const flagsMod = await import("./helpers/flags.ts");
    assert.equal("FlagLookupOptions" in flagsMod, false);
    const root = await import("./index.ts");
    assert.equal("FlagLookupOptions" in root, false);
  });

  it("no gluedShorts field anywhere (glue derives, never listed)", async () => {
    // Structural: the git descriptor carries no glue list; derivation
    // lives in arity.ts only. (Full `grep -r` sweep recorded in the PR.)
    const { GIT_CLI_DESCRIPTOR } = await import("./plugins/git/descriptors.ts");
    assert.equal("gluedShorts" in (GIT_CLI_DESCRIPTOR as object), false);
    const arityMod = await import("./arity.ts");
    assert.equal(typeof arityMod.deriveFlagSets, "function");
  });
});

describe("collapse pins (issue #115: bundleAware is gone, not deprecated)", () => {
  it("no bundleAware remnants in non-test sources or README", () => {
    // Deleted means deleted: the per-call-site bundle opt-in is gone
    // (bundling derives from the flag table), so the channel name must
    // not appear outside `*.test.ts` (behavioral pins) and the git
    // history. Scans every non-test `src/**/*.ts` plus the README.
    const here = import.meta.dirname;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts") || full.endsWith(".test.ts")) continue;
        if (readFileSync(full, "utf8").includes("bundleAware")) {
          hits.push(path.relative(here, full));
        }
      }
    };
    walk(here);
    const readme = path.join(here, "..", "README.md");
    if (readFileSync(readme, "utf8").includes("bundleAware")) {
      hits.push("README.md");
    }
    assert.deepEqual(hits, []);
  });
});
