// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `gh-repo-create-needs-seed` pins through the REAL evaluator
 * (defineConfig + loadHarness): routing is structural now
 * (`command: "gh"` + `when.subcommand` sequences, core #117) and the
 * seed exemption is the declarative `not.flag` leaf — so the truth
 * table asserts composed block/allow verdicts, not a regex surface.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defineConfig } from "@cad0p/pi-steering";
import {
  createRecordingHost,
  loadHarness,
  mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import { githubPlugin } from "../index.ts";
import { ghRepoCreateNeedsSeed } from "./gh-repo-create-needs-seed.ts";

const config = defineConfig({ plugins: [githubPlugin] });

const fixtures: string[] = [];

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "steering-seed-rule-fixture-"));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function evaluateBash(
  cwd: string,
  command: string,
): Promise<{ block: boolean; rule: string | null | undefined }> {
  const host = createRecordingHost({});
  const ctx = mockExtensionContext(cwd, host.entries);
  const harness = loadHarness({ config, host });
  const event = {
    type: "tool_call",
    toolCallId: "tc1",
    toolName: "bash",
    input: { command },
  } as unknown as Parameters<typeof harness.evaluate>[0];
  const result = await harness.evaluate(event, ctx, 1);
  if (result === undefined || result === null || result.block !== true) {
    return { block: false, rule: null };
  }
  const raw = result.reason ?? "";
  const reason = typeof raw === "string" ? raw : String(raw);
  const match = reason.match(/(?:^|\n)\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
  return { block: true, rule: match ? match[1] : null };
}

describe("github plugin — gh-repo-create-needs-seed (declarative shape)", () => {
  it("routes command-first: command gh + repo create/new sequences, seed exemption via not.flag", () => {
    const rule = ghRepoCreateNeedsSeed as unknown as {
      tool?: unknown;
      command?: unknown;
      field?: unknown;
      pattern?: unknown;
      when?: { subcommand?: unknown; not?: { flag?: unknown } };
    };
    assert.equal(rule.tool, "bash");
    assert.equal(rule.command, "gh");
    assert.equal(rule.field, undefined);
    assert.equal(rule.pattern, undefined);
    const subcommand = rule.when?.subcommand as unknown as {
      anyOf?: readonly (readonly string[])[];
      onUnknown?: unknown;
    };
    assert.deepEqual(subcommand?.anyOf, [
      ["repo", "create"],
      ["repo", "new"],
    ]);
    assert.equal(subcommand?.onUnknown, "allow");
    const flag = (
      rule.when?.not as unknown as {
        flag?: { anyOf?: readonly { aliases?: readonly string[] }[] };
      }
    )?.flag;
    assert.deepEqual(
      flag?.anyOf?.map((e) => e.aliases),
      [
        ["--add-readme"],
        ["--gitignore", "-g"],
        ["--license", "-l"],
        ["--template", "-p"],
      ],
    );
  });
});

describe("github plugin — gh-repo-create-needs-seed (engine verdicts)", () => {
  // Any seed flag exempts: long or short form, ` ` or `=` value
  // form, before or after the name. The `--add-readme --source .
  // --push` combo is ALLOWED (seed present) — gh's own flag
  // validation governs the combo at runtime; form check only,
  // consistent with the body-file rules' philosophy.
  it("allows any seed flag (--add-readme / --gitignore|-g / --license|-l / --template|-p)", async () => {
    for (const cmd of [
      "gh repo create x --add-readme",
      "gh repo create --add-readme x",
      "gh repo create x --gitignore Node",
      "gh repo create x -g Node",
      "gh repo create x --gitignore=Node",
      "gh repo create x --license mit",
      "gh repo create x -l mit",
      "gh repo create x --license=mit",
      "gh repo create x --template owner/repo",
      "gh repo create x -p owner/repo",
      "gh repo create x --template=owner/repo",
      "gh repo create x --add-readme --source . --push",
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (block by ${rule})`,
      );
    }
  });

  it("blocks bare creates and non-seed flag combos", async () => {
    for (const cmd of [
      "gh repo create x",
      "gh repo create x --source . --push",
      "gh repo create x --source=. --push",
      "gh repo create x -s . -r upstream",
      "gh repo create x --public --clone",
      "gh repo create x --clone",
      "gh repo create x -t myteam --public",
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd);
      assert.equal(block, true, `expected block for: ${cmd}`);
      assert.equal(rule, "gh-repo-create-needs-seed", `for: ${cmd}`);
    }
  });

  it("blocks the repo new alias, skips view/clone and echo prefixes", async () => {
    const created = await evaluateBash(makeFixtureDir(), "gh repo new x");
    assert.equal(created.block, true, "expected block for repo new");
    assert.equal(created.rule, "gh-repo-create-needs-seed");
    for (const cmd of [
      "gh repo view x",
      "gh repo clone x",
      "echo gh repo create x",
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (block by ${rule})`,
      );
    }
  });

  it("flag-first forms: bare blocks, seeded passes (descriptor arity keeps extraction)", async () => {
    // `gh -v --hostname h repo create foo` — leading flags skipped by
    // table arity, `[repo, create]` extracted, no seed → block.
    const bare = await evaluateBash(
      makeFixtureDir(),
      "gh -v --hostname h repo create foo",
    );
    assert.equal(bare.block, true, "expected block");
    assert.equal(bare.rule, "gh-repo-create-needs-seed");
    // Seed flags BEFORE the subcommand count too: `-g` consumes
    // its value (`Node`) by table arity, then `[repo, create]`
    // extracts and the present seed exempts.
    for (const cmd of [
      "gh -g Node repo create foo",
      "gh --template owner/repo repo create x",
      "gh -v --hostname h repo create foo --add-readme",
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (block by ${rule})`,
      );
    }
  });

  it("BEHAVIOR DELTA (improvement): seed token inside a QUOTED value no longer exempts", async () => {
    // The old string-level negative lookahead saw the `--license`
    // token inside `--description "see --license mit"` and exempted
    // (documented false-exemption — an agent could embed a fake seed
    // mention and still birth an empty repo). The token-level
    // `not.flag` leaf reads the quoted value as ONE non-flag word →
    // absent → block. The hole is closed structurally.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      'gh repo create x --description "see --license mit"',
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-create-needs-seed");
  });

  it("BEHAVIOR DELTA (accepted): pflag-faithful glue exempts -local / -public", async () => {
    // Bundle matching derives from the descriptor table: `-local`
    // glues `l` (license), `-public` glues `p` (template) — gh/cobra
    // parse both the same way, then reject the junk seed VALUES at
    // runtime, so nothing real executes. The old token-boundary guard
    // blocked these; the engine is faithful to gh here. Pinned so the
    // flip can't change silently.
    for (const cmd of ["gh repo create x -local", "gh repo create x -public"]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (block by ${rule})`,
      );
    }
    // No leading dash → not flag-shaped → still blocks.
    const glued = await evaluateBash(
      makeFixtureDir(),
      "gh repo create x --description foo--add-readme",
    );
    assert.equal(glued.block, true, "expected block");
    assert.equal(glued.rule, "gh-repo-create-needs-seed");
  });
});
