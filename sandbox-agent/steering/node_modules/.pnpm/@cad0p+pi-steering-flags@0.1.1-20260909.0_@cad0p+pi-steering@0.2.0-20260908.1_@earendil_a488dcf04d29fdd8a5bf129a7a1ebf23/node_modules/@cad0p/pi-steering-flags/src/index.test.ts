// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * End-to-end test: load the plugin via `defineConfig` + `loadHarness`,
 * drive synthetic bash events through the full evaluator, confirm the
 * predicates wire up through the standard `when.<key>` lookup path.
 *
 * If these fail, the plugin's predicate names / arg shapes are
 * mismatched against how the engine merges plugins. Deeper unit tests
 * live in the per-predicate test files.
 */

import { describe, it } from "node:test";
import { defineConfig } from "@cad0p/pi-steering";
import {
  expectAllows,
  expectBlocks,
  loadHarness,
} from "@cad0p/pi-steering/testing";
import flagsPlugin from "./index.ts";

/**
 * Argv facts for the basenames these suites drive (core #117:
 * registry-only arity — absent descriptors are loud). Explicit-strict
 * empty except `aws --profile` (takesValue:true: the separated
 * `--profile dev` form must consume, mirroring the owning-table
 * pattern every consumer copies).
 */
const testFacts = {
  name: "test-facts",
  cliDescriptors: {
    aws: {
      flags: {
        profile: { aliases: ["--profile"], takesValue: true },
      },
    },
    cr: {},
    gh: {},
  },
} as const;

describe("pi-steering-flags plugin (e2e)", () => {
  it("requiresFlag: blocks when flag is missing, allows when present", async () => {
    const config = defineConfig({
      plugins: [flagsPlugin, testFacts],
      rules: [
        {
          name: "aws-requires-profile",
          tool: "bash",
          command: "aws",
          when: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } },
          reason: "aws requires --profile",
        },
      ],
    });
    const harness = loadHarness({ config });

    await expectBlocks(harness, { command: "aws s3 ls" });

    await expectAllows(harness, {
      command: "aws s3 ls --profile dev",
    });

    await expectAllows(harness, {
      command: "AWS_PROFILE=dev aws s3 ls",
    });
  });

  it("allowlistedFlagsOnly: blocks unknown flags, allows allowlisted", async () => {
    const config = defineConfig({
      plugins: [flagsPlugin, testFacts],
      rules: [
        {
          name: "cr-allowlisted",
          tool: "bash",
          command: "cr",
          when: {
            allowlistedFlagsOnly: { allow: ["--all", "--description"] },
          },
          reason: "only --all / --description permitted",
        },
      ],
    });
    const harness = loadHarness({ config });

    await expectAllows(harness, {
      command: "cr --all --description foo.md",
    });

    await expectBlocks(harness, {
      command: "cr --publish --description foo.md",
    });
  });

  it("combines with when.not.infoOnly carve-out", async () => {
    const config = defineConfig({
      plugins: [flagsPlugin, testFacts],
      rules: [
        {
          name: "cr-allowlisted-help-ok",
          tool: "bash",
          command: "cr",
          when: {
            not: { infoOnly: { extraFlags: ["-h"] } },
            allowlistedFlagsOnly: { allow: ["--description"] },
          },
          reason: "disallowed flag",
        },
      ],
    });
    const harness = loadHarness({ config });

    // --publish would normally fire, but --help (with the -h extra)
    // carves out the whole when-clause.
    await expectAllows(harness, { command: "cr --help --publish" });
    await expectAllows(harness, { command: "cr -h --publish" });

    // Without an info-only flag, the disallowed flag fires.
    await expectBlocks(harness, { command: "cr --publish" });
  });

  it("infoOnly: bare true blocks non-info-only commands, allows --help / --version", async () => {
    const config = defineConfig({
      plugins: [flagsPlugin, testFacts],
      rules: [
        {
          name: "gh-merge-info-only",
          tool: "bash",
          command: "gh",
          when: { not: { infoOnly: true } },
          reason: "real gh pr merge needs extra guards",
        },
      ],
    });
    const harness = loadHarness({ config });

    // Info-only invocations are carved out.
    await expectAllows(harness, { command: "gh pr merge --help" });
    await expectAllows(harness, { command: "gh pr merge --version" });

    // Real operations still fire (the when-clause ANDs back in).
    await expectBlocks(harness, { command: "gh pr merge --squash" });
    await expectBlocks(harness, { command: "gh pr merge" });
  });

  it("infoOnly: help inside a quoted VALUE does not carve out (issue #13 repro)", async () => {
    const config = defineConfig({
      plugins: [flagsPlugin, testFacts],
      rules: [
        {
          name: "gh-merge-quoted-help",
          tool: "bash",
          command: "gh",
          when: { not: { infoOnly: true } },
          reason: "real gh pr merge needs extra guards",
        },
      ],
    });
    const harness = loadHarness({ config });

    // The old INFO_ONLY regex matched the `--help` inside the quoted
    // value and wrongly allowed the merge. Token-level detection
    // blocks it.
    await expectBlocks(harness, {
      command: 'gh pr merge --squash --subject "see --help"',
    });
  });
});
