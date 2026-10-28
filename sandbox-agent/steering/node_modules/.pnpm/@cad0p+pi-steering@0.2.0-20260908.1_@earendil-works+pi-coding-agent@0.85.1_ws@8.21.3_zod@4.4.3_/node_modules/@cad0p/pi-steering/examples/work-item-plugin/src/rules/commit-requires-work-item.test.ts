// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Integration tests for `commit-requires-work-item`.
 *
 * Uses `loadHarness` + `expectBlocks` / `expectAllows` — same shape
 * a real plugin's test would take. Builds a minimal config with just
 * this rule + the `workItemFormat` predicate wired through a fake
 * plugin. Keeps the test isolated from any upstream plugin behavior.
 */

import { describe, it } from "node:test";
import type { Plugin } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import {
  expectAllows,
  expectBlocks,
  loadHarness,
} from "@cad0p/pi-steering/testing";
import { featureBranchHost } from "../__test-helpers__.ts";
import { workItemFormat } from "../predicates/work-item-format.ts";
import { commitRequiresWorkItem } from "./commit-requires-work-item.ts";

/**
 * Minimal test plugin registering the predicate. We could use the
 * whole `work-item` plugin default export here, but wiring the single
 * predicate keeps each rule test focused on its own behavior without
 * pulling in unrelated observers / rules.
 */
const testPlugin: Plugin = {
  name: "test",
  predicates: { workItemFormat },
};

describe("commit-requires-work-item", () => {
  const harness = loadHarness({
    config: {
      plugins: [testPlugin, gitPlugin],
      rules: [commitRequiresWorkItem],
    },
    host: featureBranchHost(),
  });

  it("blocks a commit missing the work-item tag", async () => {
    await expectBlocks(
      harness,
      { command: 'git commit -m "feat: add thing"' },
      { rule: "commit-requires-work-item" },
    );
  });

  it("allows a commit containing [PROJ-N]", async () => {
    await expectAllows(harness, {
      command: 'git commit -m "feat: add thing [PROJ-42]"',
    });
  });

  it("allows commits using --message long form", async () => {
    await expectAllows(harness, {
      command: 'git commit --message "fix [PROJ-1] bad thing"',
    });
  });

  it('does NOT fire on git log --grep="commit"', async () => {
    // Make sure the routing doesn't spuriously match arbitrary
    // commit-containing text.
    await expectAllows(harness, {
      command: 'git log --grep="commit"',
    });
  });

  it("does NOT fire on `git commit` without -m (the rule's flag leaf requires -m)", async () => {
    // The rule's `-m` / `--message` flag entry never matches, so this
    // never even reaches the predicate.
    await expectAllows(harness, { command: "git commit --amend" });
  });

  it("blocks a commit whose [PROJ- tag uses the wrong format", async () => {
    await expectBlocks(
      harness,
      { command: 'git commit -m "feat [PROJXX] oops"' },
      { rule: "commit-requires-work-item" },
    );
  });
});
