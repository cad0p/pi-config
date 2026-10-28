// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateWord } from "@cad0p/pi-steering";
import { testPredicate } from "@cad0p/pi-steering/testing";
import { allowlistedFlagsOnly } from "./allowlisted-flags-only.ts";

function W(value: string): PredicateWord {
  return { value, text: value, pos: 0, end: value.length, rawText: value };
}

describe("allowlistedFlagsOnly", () => {
  it("does NOT fire when all flags are in the allowlist", async () => {
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: ["--all", "--description"] },
      {
        input: {
          tool: "bash",
          command: "cr --all --description foo.md",
          basename: "cr",
          args: [W("--all"), W("--description"), W("foo.md")],
        },
        descriptors: { cr: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("fires when a non-allowlisted flag is present", async () => {
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: ["--description"] },
      {
        input: {
          tool: "bash",
          command: "cr --publish --description foo.md",
          basename: "cr",
          args: [W("--publish"), W("--description"), W("foo.md")],
        },
        descriptors: { cr: {} },
      },
    );
    assert.equal(fires, true);
  });

  it("auto-derives --flag= prefixes for allowlisted --flags", async () => {
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: ["--description"] },
      {
        input: {
          tool: "bash",
          command: "cr --description=foo.md",
          basename: "cr",
          args: [W("--description=foo.md")],
        },
        descriptors: { cr: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("ignores positional (non-flag) tokens", async () => {
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: ["--description"] },
      {
        input: {
          tool: "bash",
          command: "cr --description path/to/file.md",
          basename: "cr",
          args: [W("--description"), W("path/to/file.md")],
        },
        descriptors: { cr: {} },
      },
    );
    // `path/to/file.md` doesn't start with `-` → ignored.
    assert.equal(fires, false);
  });

  it("fires on short flag not in allowlist", async () => {
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: ["--description"] },
      {
        input: {
          tool: "bash",
          command: "cr -r CR-12345",
          basename: "cr",
          args: [W("-r"), W("CR-12345")],
        },
        descriptors: { cr: {} },
      },
    );
    assert.equal(fires, true);
  });

  it("allowPrefixes permits prefix-matched tokens not in bare allow", async () => {
    // Short flag attached-value: `-ofoo` with allow:[] + allowPrefixes:["-o"]
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: ["--verbose"], allowPrefixes: ["-o"] },
      {
        input: {
          tool: "bash",
          command: "cmd -ofoo --verbose",
          basename: "cmd",
          args: [W("-ofoo"), W("--verbose")],
        },
        descriptors: { cmd: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("handles empty args (nothing to check)", async () => {
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: ["--description"] },
      {
        input: {
          tool: "bash",
          command: "cr",
          basename: "cr",
          args: [],
        },
        descriptors: { cr: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("does NOT fire on malformed args (non-array allow)", async () => {
    // Fail-open: misconfigured rule shouldn't block everything.
    const fires = await testPredicate(
      allowlistedFlagsOnly,
      { allow: "not-an-array" } as never,
      {
        input: {
          tool: "bash",
          command: "cr --publish",
          basename: "cr",
          args: [W("--publish")],
        },
        descriptors: { cr: {} },
      },
    );
    assert.equal(fires, false);
  });
});
