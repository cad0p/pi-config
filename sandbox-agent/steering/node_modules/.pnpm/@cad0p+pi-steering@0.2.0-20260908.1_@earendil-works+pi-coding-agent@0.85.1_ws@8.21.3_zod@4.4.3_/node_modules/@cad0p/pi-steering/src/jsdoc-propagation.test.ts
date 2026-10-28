// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Regression fence: verifies that JSDoc declared on
 * `PiSteeringPredicates.<key>` (in a plugin's `declare global { ... }`
 * block) propagates onto the synthesized fields of
 * {@link TopLevelWhenClause} and {@link TopLevelWhenClauseNoRecurse},
 * surfacing on hover for plugin-predicate authors.
 *
 * Hover resolution drives `LanguageService.getQuickInfoAtPosition` —
 * the same code tsserver runs for IDE hover tooltips — so the
 * assertion text is exactly what the user sees.
 *
 * Background: TypeScript's checker
 * (`resolveMappedTypeMembers` in `src/compiler/checker.ts`) only
 * links property declarations through a mapped type when the
 * constraint AST is literally `keyof T` and the optional `as` clause
 * is a Filter (returns `K | never`, assignable to `K`). The
 * pre-computed alias `[K in PluginPredicateKey]` produces the same
 * keyset but uses a `TypeReference` AST in place of `KeyOfKeyword` —
 * `isMappedTypeWithKeyofConstraintDeclaration` returns false, the
 * `modifiersProp.declarations` link is dropped, and JSDoc on the
 * underlying interface member is no longer reachable from the
 * synthesized symbol.
 *
 * Built-in non-registry leaves (`cwd:`, `missing:`, `condition:`)
 * don't share this regression vector — their JSDoc propagates through
 * the trivial `interface property → property symbol` path on
 * `BuiltInWhenLeavesOuter` / `BuiltInWhenLeavesInner` and the
 * homomorphism check doesn't apply.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import * as ts from "typescript";

// Imported solely so the file-level JSDoc `@link` references resolve
// on hover; these are the types whose hover-propagation behavior the
// fences below pin.
import type {
  TopLevelWhenClause,
  TopLevelWhenClauseNoRecurse,
} from "./schema.ts";

void (0 as unknown as TopLevelWhenClause | TopLevelWhenClauseNoRecurse);

const HERE = import.meta.dirname;
const PLUGIN_GIT_PATH = path.resolve(HERE, "plugins/git/index.ts");
const SCHEMA_PATH = path.resolve(HERE, "schema.ts");
const INDEX_PATH = path.resolve(HERE, "index.ts");

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  strict: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  types: [],
};

/**
 * Resolve hover-time JSDoc at the position of `propName:` inside the
 * object literal whose source location follows `anchor`. Drives
 * `LanguageService.getQuickInfoAtPosition` — the same code tsserver
 * runs for IDE hover tooltips, so the returned text matches what the
 * user sees on hover.
 */
function hoverDocsAt(
  scratchDir: string,
  source: string,
  propName: string,
  anchor: string,
): string {
  mkdirSync(scratchDir, { recursive: true });
  const scratchFile = path.join(scratchDir, "probe.ts");
  writeFileSync(scratchFile, source);

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [scratchFile],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      try {
        return ts.ScriptSnapshot.fromString(ts.sys.readFile(name) ?? "");
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => scratchDir,
    getCompilationSettings: () => COMPILER_OPTIONS,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  const anchorIdx = source.indexOf(anchor);
  assert(
    anchorIdx >= 0,
    `anchor ${JSON.stringify(anchor)} not found in source`,
  );
  const propIdx = source.indexOf(`${propName}:`, anchorIdx);
  assert(
    propIdx >= 0,
    `prop ${JSON.stringify(propName)} not found after anchor`,
  );
  const qi = ls.getQuickInfoAtPosition(scratchFile, propIdx + 1);
  assert(qi, "expected quickInfo to resolve at probe position");
  return ts.displayPartsToString(qi.documentation ?? []);
}

function withScratch(suffix: string, fn: (scratchDir: string) => void): void {
  const scratchDir = path.join(
    os.tmpdir(),
    `jsdoc-propagation-${suffix}-${process.pid}-${Date.now()}`,
  );
  try {
    fn(scratchDir);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

const IMPORT_HEADER = [
  `import "${PLUGIN_GIT_PATH.replace(/\\/g, "\\\\")}";`,
  `import type { Rule } from "${SCHEMA_PATH.replace(/\\/g, "\\\\")}";`,
  "",
].join("\n");

const RULE_BOILERPLATE = [
  '\tname: "x",',
  '\ttool: "bash",',
  '\tcommand: "x",',
  '\treason: "x",',
].join("\n");

/**
 * One row per plugin-augmented predicate key in `PiSteeringPredicates`.
 * `value` is the bare-form RHS used inside `when: { ... }`; `contains`
 * is a sentinel substring of the source-declared JSDoc on
 * `plugins/git/index.ts`'s `interface PiSteeringPredicates`.
 */
const PREDICATE_CASES = [
  { key: "branch", value: "/main/", contains: "current git branch" },
  { key: "upstream", value: "/origin/", contains: "configured" },
  { key: "remote", value: "/github/", contains: "remote.origin.url" },
  { key: "isClean", value: "false", contains: "git status" },
  { key: "hasStagedChanges", value: "true", contains: "git diff --cached" },
  { key: "commitsAhead", value: "1", contains: "commits ahead" },
] as const;

describe("JSDoc propagation through TopLevelWhenClause mapped type", () => {
  for (const { key, value, contains } of PREDICATE_CASES) {
    it(`surfaces JSDoc on when.${key} via Rule annotation`, () => {
      withScratch(`outer-${key}`, (scratchDir) => {
        const source =
          IMPORT_HEADER +
          "const r: Rule = {\n" +
          RULE_BOILERPLATE +
          "\n" +
          `\twhen: { ${key}: ${value} },\n` +
          "};\n" +
          "void r;\n";
        const docs = hoverDocsAt(scratchDir, source, key, "when: {");
        assert(
          docs.includes(`when.${key}`),
          `expected JSDoc to include 'when.${key}'; got: ${JSON.stringify(docs)}`,
        );
        assert(
          docs.includes(contains),
          `expected JSDoc to include ${JSON.stringify(contains)}; got: ${JSON.stringify(docs)}`,
        );
      });
    });

    it(`surfaces JSDoc on when.not.${key} via TopLevelWhenClauseNoRecurse`, () => {
      withScratch(`inner-${key}`, (scratchDir) => {
        const source =
          IMPORT_HEADER +
          "const r: Rule = {\n" +
          RULE_BOILERPLATE +
          "\n" +
          `\twhen: { not: { ${key}: ${value} } },\n` +
          "};\n" +
          "void r;\n";
        const docs = hoverDocsAt(scratchDir, source, key, "not: {");
        assert(
          docs.includes(`when.${key}`),
          `expected nested JSDoc to include 'when.${key}'; got: ${JSON.stringify(docs)}`,
        );
        assert(
          docs.includes(contains),
          `expected nested JSDoc to include ${JSON.stringify(contains)}; got: ${JSON.stringify(docs)}`,
        );
      });
    });
  }

  it("inline defineConfig drops JSDoc — known limitation; factor rules out for hover-rich authoring", () => {
    // `defineConfig({ rules: [{ ...inline... }] })` narrows the
    // rule literal via its `const R extends readonly Rule[]`
    // signature, bypassing the homomorphic mapped-type linkage.
    // The canonical hover-rich pattern is to factor rules out into
    // `as const satisfies Rule` (or `: Rule`) bindings — see the
    // next test and `defineConfig`'s JSDoc.
    withScratch("inline-defineconfig", (scratchDir) => {
      const source = [
        `import { defineConfig } from "${INDEX_PATH.replace(/\\/g, "\\\\")}";`,
        `import "${PLUGIN_GIT_PATH.replace(/\\/g, "\\\\")}";`,
        "",
        "export default defineConfig({",
        "\trules: [",
        "\t\t{",
        '\t\t\tname: "inline",',
        '\t\t\ttool: "bash",',
        '\t\t\tcommand: "x",',
        '\t\t\treason: "x",',
        "\t\t\twhen: { isClean: false },",
        "\t\t},",
        "\t],",
        "});",
        "",
      ].join("\n");
      const docs = hoverDocsAt(scratchDir, source, "isClean", 'name: "inline"');
      assert.equal(
        docs,
        "",
        `inline-defineConfig path now SURFACES JSDoc — gap closed, update the docs (defineConfig JSDoc + examples README) to remove the factor-out recommendation. Got: ${JSON.stringify(docs)}`,
      );
    });
  });

  it("factored-out `as const satisfies Rule` preserves JSDoc through defineConfig", () => {
    // The canonical hover-rich pattern documented in
    // `defineConfig`'s JSDoc and `examples/dynamic-reason-runtime-
    // cwd/steering.ts`. The factored-out binding annotates the
    // literal with `Rule` (via `satisfies`), restoring the
    // homomorphic mapped-type linkage that surfaces source JSDoc.
    withScratch("factored-out", (scratchDir) => {
      const source = [
        `import { defineConfig, type Rule } from "${INDEX_PATH.replace(/\\/g, "\\\\")}";`,
        `import "${PLUGIN_GIT_PATH.replace(/\\/g, "\\\\")}";`,
        "",
        "const myRule = {",
        '\tname: "factored",',
        '\ttool: "bash",',
        '\tcommand: "x",',
        '\treason: "x",',
        "\twhen: { isClean: false },",
        "} as const satisfies Rule;",
        "",
        "export default defineConfig({",
        "\trules: [myRule],",
        "});",
        "",
      ].join("\n");
      const docs = hoverDocsAt(scratchDir, source, "isClean", "myRule");
      assert(
        docs.includes("git status"),
        `factored-out pattern should preserve JSDoc; got: ${JSON.stringify(docs)}`,
      );
    });
  });
});
