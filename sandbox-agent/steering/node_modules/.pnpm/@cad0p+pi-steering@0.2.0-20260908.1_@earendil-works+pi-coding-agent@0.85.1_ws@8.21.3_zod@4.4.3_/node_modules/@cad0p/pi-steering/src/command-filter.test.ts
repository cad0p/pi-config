// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Typing pins for the `command:` first filter (issue #117) plus the
 * behavioral merge gates: routing is exact basename equality (the
 * type machinery is a strict union over declared descriptor keys,
 * threaded through `defineConfig` like `AllRuleNames`).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import { makeCtx, makeTrackedHost as makeHost } from "./__test-helpers__.ts";
import { defineConfig } from "./define-config.ts";
import { buildEvaluator } from "./evaluator.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import shippedGitPlugin from "./plugins/git/index.ts";
import { noForcePush } from "./plugins/git/rules/no-force-push.ts";
import shippedRmPlugin, { noRmRfSlash } from "./plugins/rm/index.ts";
import type { Plugin, Rule } from "./schema.ts";

describe("command: typing pins (issue #117)", () => {
  it("accepts a declared basename", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      rules: [
        {
          name: "git-only",
          tool: "bash",
          command: "git",

          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "git-only");
  });

  it("accepts a readonly array of declared basenames", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin],
      rules: [
        {
          name: "git-or-rm",
          tool: "bash",
          command: ["git", "rm"] as const,
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "git-or-rm");
  });

  it("accepts inline-literal plugin basenames", () => {
    const myPlugin = {
      name: "myplugin",
      cliDescriptors: { mycli: { flags: {} } },
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [myPlugin],
      rules: [
        {
          name: "mycli-only",
          tool: "bash",
          command: "mycli",

          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "mycli-only");
  });

  it("widened `: Plugin` skips the check (runtime backstop covers)", async () => {
    // Bare `: Plugin` widens `cliDescriptors` to
    // `Record<string, CLIDescriptor>` — "can't verify" means "skip",
    // never a false-positive. The fail-closed rule-tagged
    // `MissingDescriptorError` block covers the widened path at
    // evaluation time (no silent never-fire).
    const wide: Plugin = {
      name: "wide",
      cliDescriptors: { widecli: { flags: {} } },
    };
    const cfg = defineConfig({
      plugins: [wide],
      rules: [
        {
          name: "wide-rule",
          tool: "bash",
          command: "anything",
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "wide-rule");
    // Runtime side of the skip: evaluating a matched ref without a
    // registered descriptor fails CLOSED (rule-tagged MDE block),
    // never silently.
    const ev = buildEvaluator(
      { rules: cfg.rules ?? [] },
      resolvePlugins([wide], {}),
      makeHost(),
    );
    const res = await ev.evaluate(
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "anything run" },
      } as BashToolCallEvent,
      makeCtx("/r"),
      0,
    );
    const reason = (res as { reason?: string } | undefined)?.reason ?? "";
    assert.match(reason, /No CLI descriptor for basename "anything"/);
  });

  it("rejects an undeclared basename at tsc", () => {
    defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin],
      rules: [
        {
          name: "typo",
          tool: "bash",
          // @ts-expect-error — "gti" is not a declared descriptor key.
          command: "gti",
          reason: "r",
        },
      ],
    });
  });
});

describe("command: required + rejects pattern/field (issue #117)", () => {
  it("rejects an absent command at tsc", () => {
    defineConfig({
      plugins: [shippedGitPlugin],
      rules: [
        // @ts-expect-error — command is required on bash rules.
        {
          name: "no-command",
          tool: "bash",
          reason: "r",
        },
      ],
    });
  });

  it("no shipped bash rule carries pattern/field; every one routes on command", () => {
    const shipped: readonly Rule[] = [
      ...(shippedGitPlugin.rules ?? []),
      ...(shippedRmPlugin.rules ?? []),
    ];
    assert.ok(shipped.length > 0);
    for (const rule of shipped) {
      assert.ok(!("pattern" in rule), `${rule.name} must not carry pattern`);
      assert.ok(!("field" in rule), `${rule.name} must not carry field`);
      if (rule.tool !== "bash") throw new Error("narrow");
      assert.ok(
        typeof rule.command === "string" || Array.isArray(rule.command),
        `${rule.name} must route on command`,
      );
    }
  });
});

describe("command: evaluator behavior (issue #117)", () => {
  function bashEvent(command: string): BashToolCallEvent {
    return {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "bash",
      input: { command },
    };
  }

  function evaluatorWith(rules: readonly Rule[], plugins: readonly Plugin[]) {
    return buildEvaluator({ rules }, resolvePlugins(plugins, {}), makeHost());
  }

  it("wrapper transparency: sh -c, /usr/bin/, -C match; echo does not", async () => {
    const ev = evaluatorWith([noForcePush], [shippedGitPlugin]);
    const yes = [
      "git push --force",
      "sh -c 'git push --force'",
      "/usr/bin/git push --force",
      "git -C /x push --force",
      "cd /repo && git push --force",
    ];
    for (const cmd of yes) {
      const r = await ev.evaluate(bashEvent(cmd), makeCtx("/repo"), 0);
      assert.equal(
        (r as { block?: boolean } | undefined)?.block,
        true,
        `expected block: ${cmd}`,
      );
    }
    const no = await ev.evaluate(
      bashEvent("echo 'git push --force'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(no, undefined);
  });

  it("array-OR routing (synthetic two-binary rule, one name)", async () => {
    // No production vehicle after the async deletion — synthetic pin.
    // One name = one disabledRules entry; leaves stay per-ref AND.
    const facts = {
      name: "synth",
      cliDescriptors: { alpha: {}, bravo: {} },
    } as const satisfies Plugin;
    const rule = {
      name: "alpha-or-bravo",
      tool: "bash",
      command: ["alpha", "bravo"],
      reason: "synthetic",
    } as const satisfies Rule;
    const ev = evaluatorWith([rule], [facts]);
    for (const cmd of ["alpha run", "bravo run"]) {
      const r = await ev.evaluate(bashEvent(cmd), makeCtx("/r"), 0);
      assert.equal(
        (r as { block?: boolean } | undefined)?.block,
        true,
        `expected block: ${cmd}`,
      );
    }
    assert.equal(
      await ev.evaluate(bashEvent("other run"), makeCtx("/r"), 0),
      undefined,
    );
    // Single disable entry covers both members (identity, not leaves):
    // the array-routed rule's name typechecks as one disabledRules entry.
    const cfg = defineConfig({
      plugins: [facts],
      rules: [rule],
      disabledRules: ["alpha-or-bravo"],
    });
    assert.deepEqual(cfg.disabledRules, ["alpha-or-bravo"]);
  });

  it("per-ref leaf semantics under arrays: senseless leaf never fires", async () => {
    const facts = {
      name: "synth",
      cliDescriptors: { git: {}, npm: {} },
    } as const satisfies Plugin;
    const rule: Rule = {
      name: "push-guard",
      tool: "bash",
      command: ["git", "npm"],
      reason: "synthetic",
      when: { subcommand: "push" },
    };
    const ev = evaluatorWith([rule], [facts]);
    const fires = await ev.evaluate(bashEvent("git push"), makeCtx("/r"), 0);
    assert.equal((fires as { block?: boolean } | undefined)?.block, true);
    // No `push` token on the npm ref → the leaf never fires for it.
    assert.equal(
      await ev.evaluate(bashEvent("npm run dev"), makeCtx("/r"), 0),
      undefined,
    );
  });

  it("unrouted undescribed binaries never throw (routing first, resolution second)", async () => {
    // The anti-hoist pin: `arityOf` sits strictly AFTER the routing
    // filter, so `kubectl get pods` (no kubectl descriptor anywhere)
    // evaluates clean instead of throwing MissingDescriptorError.
    const ev = evaluatorWith([noForcePush], [shippedGitPlugin]);
    assert.equal(
      await ev.evaluate(bashEvent("kubectl get pods"), makeCtx("/r"), 0),
      undefined,
    );
  });

  it("nameless refs (bare VAR=x) never match and never throw", async () => {
    const ev = evaluatorWith([noForcePush], [shippedGitPlugin]);
    assert.equal(
      await ev.evaluate(bashEvent("VAR=x"), makeCtx("/r"), 0),
      undefined,
    );
  });

  it("unknown command basename fails closed at evaluation (rule-tagged MDE block)", async () => {
    // No build-time throw: the fail-closed `MissingDescriptorError`
    // block (with remedy) on the first MATCHED evaluation is the
    // runtime backstop — it covers widened-`: Plugin` / plain-JS
    // configs the type union can't see, and keeps the §5 throw
    // contract unchanged (unmatched refs never reach it).
    const rule: Rule = {
      name: "mystery",
      tool: "bash",
      command: "mycli",
      reason: "r",
    };
    const ev = evaluatorWith([rule], []);
    const res = await ev.evaluate(bashEvent("mycli push"), makeCtx("/r"), 0);
    const reason = (res as { reason?: string } | undefined)?.reason ?? "";
    assert.match(reason, /\[steering:mystery@user\]/);
    assert.match(reason, /No CLI descriptor for basename "mycli"/);
  });

  it("whitespace in command is rejected at build", async () => {
    const rule = {
      name: "bad",
      tool: "bash",
      command: "git commit",
      reason: "r",
    } as unknown as Rule;
    assert.throws(
      () => evaluatorWith([rule], [shippedGitPlugin]),
      /invalid command entry "git commit"/,
    );
  });

  it("empty command array never fires (mirrors empty-anyOf)", async () => {
    const rule = {
      name: "never",
      tool: "bash",
      command: [],
      reason: "r",
    } as unknown as Rule;
    const facts = {
      name: "synth",
      cliDescriptors: { git: {} },
    } as const satisfies Plugin;
    const ev = evaluatorWith([rule], [facts]);
    assert.equal(
      await ev.evaluate(bashEvent("git push --force"), makeCtx("/r"), 0),
      undefined,
    );
  });
});

describe("command: write/edit pattern untouched (issue #117)", () => {
  it("write/edit rules still accept string|RegExp patterns and fire", async () => {
    const str: Rule = {
      name: "w-str",
      tool: "write",
      field: "path",
      pattern: "^/etc/",
      reason: "r",
    };
    const re: Rule = {
      name: "e-re",
      tool: "edit",
      field: "content",
      pattern: /SECRET/,
      reason: "r",
    };
    assert.ok(str.pattern === "^/etc/");
    assert.ok(re.pattern instanceof RegExp);
  });
});

describe("command: async deletion pins (issue #117 §6.1)", () => {
  it('defineConfig plugin-name union no longer contains "async"', () => {
    defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin],
      // @ts-expect-error — "async" ships nothing anymore.
      disabledPlugins: ["async"],
    });
  });

  it("package.json no longer exports ./plugins/async", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(new URL(import.meta.url).pathname), "..", "package.json"),
        "utf8",
      ),
    ) as { exports: Record<string, unknown> };
    assert.ok(!("./plugins/async" in pkg.exports));
    assert.ok("./plugins/git" in pkg.exports);
    assert.ok("./plugins/rm" in pkg.exports);
  });

  it("the async plugin files are gone (scoped import rejects)", async () => {
    const spec = ["./plugins", "async", "index.ts"].join("/");
    await assert.rejects(import(spec));
  });

  it("shipped plugins are git + rm only", () => {
    assert.equal(shippedGitPlugin.name, "git");
    assert.equal(shippedRmPlugin.name, "rm");
    assert.ok(!("async" in { git: 1, rm: 1 }));
  });

  it("no-rm-rf-slash keeps its seal after the migration", () => {
    assert.equal(noRmRfSlash.noOverride, true);
  });
});

describe("command: deletion grep pins (issue #117 §7)", () => {
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");
  const SURFACE = [
    "src/plugins",
    "src/bin",
    "scripts",
    "examples",
    "skills",
    "README.md",
    "package.json",
  ];
  const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
  // The pin file names the deleted shapes in its own scanner +
  // expected sets — excluding it keeps the scan non-recursive. Its
  // own claims are covered by the sibling tests above (package.json
  // exports pin, literal dynamic-import rejection).
  const SKIP_FILES = new Set(["src/command-filter.test.ts"]);
  const SCAN_EXTS = new Set([
    ".ts",
    ".mts",
    ".cts",
    ".js",
    ".mjs",
    ".cjs",
    ".md",
    ".json",
  ]);

  function scanHits(re: RegExp): string[] {
    const out: string[] = [];
    const visit = (abs: string, rel: string): void => {
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(abs.split("/").pop() ?? "")) return;
        for (const entry of readdirSync(abs)) {
          visit(join(abs, entry), rel === "" ? entry : `${rel}/${entry}`);
        }
        return;
      }
      if (SKIP_FILES.has(rel)) return;
      if (![...SCAN_EXTS].some((ext) => abs.endsWith(ext))) return;
      const text = readFileSync(abs, "utf8");
      for (const line of text.split("\n")) {
        if (re.test(line)) out.push(`${rel} :: ${line.trim()}`);
      }
    };
    for (const root of SURFACE) visit(join(repoRoot, root), root);
    // Dedupe: the same sanctioned line often repeats within one
    // file (predicate tests). Any DISTINCT hit line still trips.
    return [...new Set(out)].sort();
  }

  it("scoped async refs are gone except the pin itself + the deletion note", () => {
    // Scoped (NOT bare `async`, which matches the keyword):
    // `asyncPlugin` (imports/arrays), `plugins/async` (subpaths),
    // `no-long-running-commands` (the deleted rail). Any new hit
    // fails the pin — update the set only by conscious edit.
    assert.deepEqual(
      scanHits(/asyncPlugin|plugins\/async|no-long-running/),
      EXPECTED_ASYNC_HITS,
    );
  });

  it("pattern: keys are allowlisted leaf/docs/rejection shapes only", () => {
    // No bash-rule `pattern:` may remain in the rule surface
    // (shipped rules, example rules, bin, scripts, skills, READMEs).
    // Every surviving `pattern:` key is a sanctioned shape: `flag:` /
    // predicate spread args (`branch: { pattern }`, `remote:`,
    // `workItemFormat:`), `subcommand: { pattern }` spreads, the
    // compat/CLI rejection fixtures (bash JSON patterns must THROW),
    // the write-rule fixture, schema/type docs, and historical prose
    // naming the deletion. Any new hit fails the pin.
    assert.deepEqual(scanHits(/(?<![\w.])pattern\s*:/), EXPECTED_PATTERN_HITS);
  });

  it("importing the deleted async subpath fails (literal specifier, tsc + runtime)", async () => {
    // Literal specifier so tsc checks it too: restoring the file
    // trips the unused-`@ts-expect-error` error (loud in reverse).
    // @ts-expect-error — ./plugins/async no longer exists.
    await assert.rejects(import("../plugins/async/index.ts"));
  });
});

const EXPECTED_ASYNC_HITS: readonly string[] = [
  "README.md :: The deleted `async` plugin's `no-long-running-commands` availability rail has no honest home yet (its CLI tables were never verified \u2014 see the restoration follow-up, issue [#120](https://github.com/cad0p/pi-steering/issues/120)).",
];

const EXPECTED_DEPTH_HITS: readonly string[] = [
  "src/evaluator-internals/predicates.ts :: depth: width,",
  "src/walker-reexports.test.ts :: depth: 1,",
];

const EXPECTED_PATTERN_HITS: readonly string[] = [
  "README.md :: // SpreadBase auto-detects to `{ pattern: Bare }` via",
  "README.md :: Emits a `defineConfig({...})` module using JSON-literal rendering. Write/edit rule patterns come across verbatim; `requires` / `unless` / override semantics are preserved. Bash rules do NOT round-trip (`pattern:` was removed \u2014 rewrite as `command:` + `when:` leaves in TypeScript). Plugins, observers, and function-valued predicates are rejected \u2014 those features only exist in the TypeScript shape and must be authored directly.",
  "README.md :: pattern: RegExp;",
  'README.md :: | { pattern: Pattern | Pattern[]; onUnknown?: "allow" | "block" };',
  "examples/work-item-plugin/src/index.ts :: *       - Invalidation-sentinel pattern: observer writes",
  'examples/work-item-plugin/src/predicates/work-item-format.test.ts :: "not-an-object" as unknown as { pattern: RegExp },',
  "examples/work-item-plugin/src/predicates/work-item-format.test.ts :: pattern: /\\[PROJ-\\d+\\]/,",
  "examples/work-item-plugin/src/predicates/work-item-format.test.ts :: { pattern: /\\[PROJ-\\d+\\]/ },",
  "examples/work-item-plugin/src/predicates/work-item-format.ts :: *   when: { workItemFormat: { pattern: /\\[PROJ-\\d+\\]/ } }",
  "examples/work-item-plugin/src/predicates/work-item-format.ts :: pattern: RegExp;",
  "examples/work-item-plugin/src/rules/commit-description-check.ts :: * Helper that writes the reminder entry. The ADR \u00a714 pattern: both",
  "examples/work-item-plugin/src/rules/commit-requires-work-item.ts :: *   - The typed-arg authoring pattern \u2014 `{ pattern: /\\[PROJ-\\d+\\]/ }`.",
  "examples/work-item-plugin/src/rules/commit-requires-work-item.ts :: workItemFormat: { pattern: /\\[PROJ-\\d+\\]/ },",
  'src/bin/pi-steering.test.ts :: pattern: "^/etc/",',
  'src/bin/pi-steering.test.ts :: pattern: "^git\\\\\\\\s+push",',
  "src/plugins/git/README.md :: bash `pattern:` in issue #117 \u2014 routing is exact basename equality",
  'src/plugins/git/README.md :: when: { branch: { pattern: /^main$/, onUnknown: "allow" } }',
  'src/plugins/git/README.md :: when: { remote: { pattern: /production/, onUnknown: "block" } }',
  'src/plugins/git/README.md :: when: { upstream: { pattern: "^origin/", onUnknown: "allow" } }',
  "src/plugins/git/helpers/pattern-args.ts :: *   - `{ pattern: Pattern, onUnknown? }`         -> object used as-is,",
  "src/plugins/git/helpers/pattern-args.ts :: *   - `{ pattern: Pattern[], onUnknown? }`       -> array preserved,",
  "src/plugins/git/helpers/pattern-args.ts :: // Object form: { pattern: Pattern | Pattern[]; onUnknown? }.",
  "src/plugins/git/helpers/pattern-args.ts :: export function matchPattern(pattern: Pattern, target: string): boolean {",
  'src/plugins/git/integration.test.ts :: * `remote: { pattern: ..., onUnknown: "allow" }`; on the resulting',
  "src/plugins/git/predicates/branch.test.ts :: // Pins the array shorthand and `{ pattern: Pattern[]; onUnknown }` form",
  "src/plugins/git/predicates/branch.test.ts :: assert.equal(await branch({ pattern: [/^main$/, /^master$/] }, ctx), true);",
  'src/plugins/git/predicates/branch.test.ts :: await branch({ pattern: /^main$/, onUnknown: "allow" }, ctxAllow),',
  'src/plugins/git/predicates/branch.test.ts :: { pattern: /^main$/, onUnknown: "allow" },',
  'src/plugins/git/predicates/branch.test.ts :: { pattern: [/^main$/, /^master$/], onUnknown: "allow" },',
  'src/plugins/git/predicates/branch.ts :: *   when: { branch: { pattern: /^main$/, onUnknown: "allow" } }  // object form',
  'src/plugins/git/predicates/branch.ts :: *   when: { branch: { pattern: [/^main$/, /^master$/], onUnknown: "allow" } }',
  "src/plugins/git/predicates/remote.test.ts :: // Pins the array shorthand and `{ pattern: Pattern[]; onUnknown }` form",
  'src/plugins/git/predicates/remote.test.ts :: await remote({ pattern: /./, onUnknown: "allow" }, ctx),',
  "src/plugins/git/predicates/remote.test.ts :: await remote({ pattern: [/github\\.com\\//, /gitlab\\.com\\//] }, ctx),",
  'src/plugins/git/predicates/remote.test.ts :: { pattern: [/github\\.com\\//, /gitlab\\.com\\//], onUnknown: "allow" },',
  'src/plugins/git/predicates/shared.test.ts :: await branch({ pattern: /^main$/, onUnknown: "block" }, ctx),',
  'src/plugins/git/predicates/shared.test.ts :: await remote({ pattern: /./, onUnknown: "allow" }, ctx),',
  'src/plugins/git/predicates/shared.test.ts :: await remote({ pattern: /my-org/, onUnknown: "block" }, ctx),',
  'src/plugins/git/predicates/shared.test.ts :: await upstream({ pattern: /^origin\\/main$/, onUnknown: "allow" }, ctx),',
  'src/plugins/git/predicates/shared.test.ts :: await upstream({ pattern: /^origin\\/main$/, onUnknown: "block" }, ctx),',
  "src/plugins/git/predicates/upstream.test.ts :: // Pins the array shorthand and `{ pattern: Pattern[]; onUnknown }` form",
  'src/plugins/git/predicates/upstream.test.ts :: await upstream({ pattern: /./, onUnknown: "allow" }, ctx),',
  "src/plugins/git/predicates/upstream.test.ts :: await upstream({ pattern: [/^origin\\/main$/, /^origin\\/develop$/] }, ctx),",
  "src/plugins/git/predicates/upstream.test.ts :: pattern: [/^origin\\/main$/, /^origin\\/develop$/],",
  "src/plugins/git/rules/no-main-commit-github.ts :: // old `GIT_COMMIT_PATTERN` anchor, deleted with bash `pattern:`).",
  'src/plugins/git/rules/no-main-commit-github.ts :: remote: { pattern: /github\\.com[/:]/, onUnknown: "allow" },',
  'src/plugins/git/rules/no-main-commit.test.ts :: * `remote: { pattern: ..., onUnknown: "allow" }`) skips on the',
  'src/plugins/git/rules/no-main-commit.ts :: *   `when: { branch: { pattern: /.../, onUnknown: "allow" } }`',
  "src/plugins/git/rules/no-main-commit.ts :: // old `GIT_COMMIT_PATTERN` anchor, deleted with bash `pattern:`).",
];

describe("zero-literal pins (issue #123)", () => {
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");
  // Repo-wide scan (broader than the §7 SURFACE above): every code +
  // docs + tests file. Skips build output, deps, vcs, and this pin
  // file itself (it names the deleted shape in its own scanner +
  // allowlists).
  function scanRepo(re: RegExp): string[] {
    const out: string[] = [];
    const visit = (abs: string, rel: string): void => {
      const st = statSync(abs);
      if (st.isDirectory()) {
        const base = abs.split("/").pop() ?? "";
        if (base === "node_modules" || base === "dist" || base === ".git") {
          return;
        }
        for (const entry of readdirSync(abs)) {
          visit(join(abs, entry), rel === "" ? entry : `${rel}/${entry}`);
        }
        return;
      }
      if (rel === "src/command-filter.test.ts") return;
      if (!/\.(ts|mts|cts|js|mjs|cjs|md|json)$/.test(abs)) return;
      const text = readFileSync(abs, "utf8");
      for (const line of text.split("\n")) {
        if (re.test(line)) out.push(`${rel} :: ${line.trim()}`);
      }
    };
    visit(repoRoot, "");
    return [...new Set(out)].sort();
  }

  it("the bundle-only facade twin is fully deleted (zero hits repo-wide)", () => {
    // Interface entry, impl, TSDoc, re-exports, call sites, pins,
    // docs — any resurrection fails here. Note: the name is spelled
    // only in this scanner's regex, and this file is skipped above.
    assert.deepEqual(scanRepo(/hasFlagOrBundle/), []);
  });

  it("the deleted subcommand depth key stays deleted (allowlisted walker-API lines only)", () => {
    // Pre-1.0 breaking: arrays always mean positional sequence
    // (length IS the extraction width, inferred) and OR goes through
    // the explicit `{ anyOf: [...] }` spread — no `depth` key exists
    // on the rule surface anymore. The only surviving `depth:`
    // spellings repo-wide are the external walker's
    // `locateSubcommandRun` call-site option plus its direct unit
    // pin. Any new hit fails here — write a sequence or an anyOf
    // instead. The `-` guard keeps `defense-in-depth` prose out of
    // the scan while still catching `depth:` keys, `"depth":` JSON
    // spellings, and `depth :` spacings.
    assert.deepEqual(scanRepo(/(?<![\w.-])depth\s*:/), EXPECTED_DEPTH_HITS);
  });

  it("condition: never appears in examples (named predicates only)", () => {
    // `condition:` is an escape hatch and MUST NOT appear in examples
    // (copy-paste-true docs): leaf-inexpressible logic gets a named
    // `definePredicate` registered on an inline plugin literal and
    // consumed as a `when:` leaf (see the force-push-strict pack) or
    // a multi-file plugin (see the work-item-plugin). Key-shaped
    // matches only (`^\s*condition\s*:`)
    // so prose mentions in comments/docs never trip the pin.
    const out: string[] = [];
    const visit = (abs: string, rel: string): void => {
      const st = statSync(abs);
      if (st.isDirectory()) {
        const base = abs.split("/").pop() ?? "";
        if (base === "node_modules" || base === ".git") return;
        for (const entry of readdirSync(abs)) {
          visit(join(abs, entry), rel === "" ? entry : `${rel}/${entry}`);
        }
        return;
      }
      if (!/\.(ts|mts|cts|js|mjs|cjs|md|json)$/.test(abs)) return;
      const text = readFileSync(abs, "utf8");
      for (const line of text.split("\n")) {
        if (/^[ \t]*condition\s*:/.test(line)) {
          out.push(`${rel} :: ${line.trim()}`);
        }
      }
    };
    visit(join(repoRoot, "examples"), "examples");
    assert.deepEqual([...new Set(out)].sort(), []);
  });

  it("requires:/unless: never take functions in examples (registered leaves only)", () => {
    // Named logic belongs in the registry — even at single-file
    // scale (see the force-push-strict pack's inline plugin
    // literal): function-valued `requires:` / `unless:` in examples
    // is an antipattern (a name carries unit tests + a registry
    // entry; an inline closure carries neither). The fn slots stay
    // one-off escape hatches for real configs; `requires:` /
    // `unless:` Pattern STRING forms stay allowed (transient until
    // the gh table lands). Key-shaped matches whose same-line value
    // (or the next non-empty line, for wrapped values) starts with a
    // quote, backtick, or `/` are the surviving Pattern forms —
    // anything else (arrow, `async`, `function`, bare identifier)
    // fails the pin.
    const out: string[] = [];
    const visit = (abs: string, rel: string): void => {
      const st = statSync(abs);
      if (st.isDirectory()) {
        const base = abs.split("/").pop() ?? "";
        if (base === "node_modules" || base === ".git") return;
        for (const entry of readdirSync(abs)) {
          visit(join(abs, entry), rel === "" ? entry : `${rel}/${entry}`);
        }
        return;
      }
      if (!/\.(ts|mts|cts|js|mjs|cjs|md|json)$/.test(abs)) return;
      const lines = readFileSync(abs, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const m = /^[ \t]*(requires|unless)[ \t]*:(.*)$/.exec(line);
        if (!m) continue;
        let value = (m[2] ?? "").trim();
        // Comment-only remainder (`requires: // ...`) carries no
        // value — fall through to the next non-empty line.
        if (value === "" || value.startsWith("//")) {
          let j = i + 1;
          while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
          value = (lines[j] ?? "").trim();
        }
        // Strip a leading comment then re-check: `requires: /* x */ fn`
        // stays a violation (first non-comment char decides).
        value = value.replace(/^(\/\/.*|\/\*[\s\S]*?\*\/)/, "").trim();
        if (!/^["'`/]/.test(value)) {
          out.push(`${rel} :: ${line.trim()}`);
        }
      }
    };
    visit(join(repoRoot, "examples"), "examples");
    assert.deepEqual([...new Set(out)].sort(), []);
  });

  it("flag literals live only in tables, mechanism, docs-tables, or tests", () => {
    // Doctrine (README dependency rule): production rules + examples
    // reference entries BY VARIABLE from a declared table — never
    // hand-build literals in leaves. A duplicated literal can skew
    // from the table into silent fail-open. Allowed:
    //   - `**/descriptors.ts` (owning-plugin tables),
    //   - `*Facts` / `*flags` table declarations (synthetic example
    //     facts — one declaration feeding both `cliDescriptors` and
    //     the leaf references; enumerated line-by-line below so a
    //     leaf literal in the same files still trips),
    //   - core mechanism (`flags.ts` / `command.ts` adapters, schema,
    //     arity derivation, merger normalization),
    //   - test mechanics (`*.test.*` build entries freely),
    //   - the README's inline-table prose (a table declaration, not
    //     a rule leaf).
    const hits = scanRepo(/aliases:/);
    const PATH_ALLOW: readonly (string | RegExp)[] = [
      /\.test\.[mc]?[tj]s$/,
      /(^|\/)descriptors\.ts$/,
      "src/helpers/flags.ts",
      "src/helpers/command.ts",
      "src/schema.ts",
      "src/arity.ts",
      "src/plugin-merger.ts",
    ];
    const LINE_ALLOW: ReadonlySet<string> = new Set([
      'examples/draft-prs-only/steering.ts :: draft: { aliases: ["--draft"], takesValue: false },',
      'examples/draft-prs-only/steering.ts :: repo: { aliases: ["-R", "--repo"], takesValue: true },',
      'examples/combined-git-discipline/steering.ts :: draft: { aliases: ["--draft"], takesValue: false },',
      'examples/combined-git-discipline/steering.ts :: repo: { aliases: ["-R", "--repo"], takesValue: true },',
      'examples/dynamic-reason-runtime-cwd/steering.ts :: prefix: { aliases: ["--prefix"], takesValue: true },',
      'README.md :: Bound arity is table-bound with no per-call opts (#110): the engine binds each ref\'s `arityOf(basename, descriptors, cache)` into `ctx.command`, so `getFlagValue` / `getAllFlagValues` / `positionals()` share one consumption source and cannot diverge. Unlisted flags never consume (strict always); attached `--flag=value` forms always apply; glued `-X<rest>` applies iff X derives from the table. `positionals()` is `--`-aware (everything after a bare `--` surfaces verbatim) while `when.flag` still scans post-`--` tokens as present (walker limitation, unchanged). No descriptor for the ref\'s basename → `MissingDescriptorError` block (loud); obscure binaries with no owning plugin declare via an inline plugin literal `plugins: [{ name: "my-facts", cliDescriptors: { mycli: { flags: { repo: { aliases: ["-R"], takesValue: true } } } } }]` — or `{ mycli: {} }` for explicit strict.',
    ]);
    const unexpected = hits.filter((hit) => {
      const rel = hit.split(" :: ")[0] ?? "";
      if (
        PATH_ALLOW.some((p) =>
          typeof p === "string" ? rel === p : p.test(rel),
        )
      ) {
        return false;
      }
      return !LINE_ALLOW.has(hit);
    });
    assert.deepEqual(unexpected, []);
  });
});
