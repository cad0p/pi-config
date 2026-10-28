// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the built-in ARGV leaves `when.subcommand` / `when.flag`
 * (issue #90, P2 of #76).
 *
 * Two layers:
 *
 *   1. Unit (`evaluateWhen` + `mockContext` with hand-built
 *      `PredicateWord[]` args): pattern semantics, malformed-input
 *      fail-skip, unknown projection, `not:` Kleene composition,
 *      exemption strictness.
 *   2. End-to-end (`loadHarness` + `expectBlocks` / `expectAllows`
 *      over real command strings): the acceptance matrix from #90 —
 *      the walker parses, the engine extracts, the rule fires.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateExemptionClause } from "../evaluator.ts";
import gitPlugin from "../plugins/git/index.ts";
import type {
  CLIDescriptor,
  CLIFlag,
  Exemption,
  FlagLeaf,
  PredicateWord,
  Rule,
  SubcommandLeaf,
  TopLevelWhenClause,
} from "../schema.ts";
import {
  expectAllows,
  expectBlocks,
  loadHarness,
  mockContext,
} from "../testing/index.ts";
import {
  evaluateWhen,
  validateExemptionWhenClauseShape,
} from "./predicates.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Static word: resolved forms === source. */
function w(
  text: string,
  overrides?: { value?: string; rawText?: string },
): PredicateWord {
  return {
    text,
    value: overrides?.value ?? text,
    rawText: overrides?.rawText ?? text,
  } as PredicateWord;
}

/** Intractable word: both resolved forms `undefined`, only source left. */
function rawOnly(rawText: string): PredicateWord {
  return { rawText } as unknown as PredicateWord;
}

/** Drive `evaluateWhen` with an argv-shaped bash context. */
async function fires(
  when: TopLevelWhenClause,
  args: PredicateWord[],
  opts?: {
    basename?: string;
    onUnknownDefault?: "allow" | "block";
    ignoreExplicitModifiers?: boolean;
    // Unit-level `evaluateWhen` calls never forward descriptors
    // implicitly — callers pass the merged map explicitly (§13),
    // and `fires` threads it into BOTH `evaluateWhen` and the mock
    // facade binding.
    descriptors?: Record<string, CLIDescriptor>;
  },
): Promise<boolean> {
  const ctx = mockContext({
    input: {
      tool: "bash",
      command: "git …",
      basename: opts?.basename ?? "git",
      args,
    },
    // Thread descriptors into the mock facade too, so `ctx.command`
    // binds exactly like the engine's per-ref binding (issue #107).
    ...(opts?.descriptors !== undefined
      ? { descriptors: opts.descriptors }
      : {}),
  });
  return evaluateWhen(
    when,
    { cwd: "/tmp/test" },
    ctx,
    {},
    "test-rule",
    "test",
    opts?.onUnknownDefault,
    opts?.ignoreExplicitModifiers,
    opts?.descriptors,
  );
}

/** Drive `evaluateWhen` with a non-bash (write) context: no `args`. */
async function firesOnWrite(when: TopLevelWhenClause): Promise<boolean> {
  const ctx = mockContext({
    tool: "write",
    input: { tool: "write", path: "/tmp/x", content: "x" },
  });
  return evaluateWhen(when, { cwd: "/tmp/test" }, ctx, {}, "t", "t");
}

function gitRule(when: TopLevelWhenClause): Rule {
  return {
    name: "no-push",
    tool: "bash",
    command: "git",
    reason: "no push",
    when,
  };
}

/**
 * Descriptor map plumbed from the git plugin's own slot (§13:
 * plugin-owned facts). Unit-level `fires` calls pass this explicitly
 * wherever git resolution is expected — core seeds nothing.
 */
const GIT_DESCRIPTORS: Record<string, CLIDescriptor> = {
  ...(gitPlugin.cliDescriptors as Record<string, CLIDescriptor>),
};

/**
 * Synthetic plugin-registered descriptor for bare `gh` pins. Core
 * seeds no `gh` (owned by pi-steering-github) — tests that need gh
 * resolution declare it via the slot, like an external plugin would.
 */
const GH_DESCRIPTORS: Record<string, CLIDescriptor> = {
  gh: {
    positionPolicy: "globals-anywhere",
    flags: {
      R: { aliases: ["-R"], takesValue: true },
      repo: { aliases: ["--repo"], takesValue: true },
      hostname: { aliases: ["--hostname"], takesValue: true },
    },
  },
};

/**
 * Synthetic plugin-registered descriptor for bare `aws` pins. Core
 * seeds no `aws` — tests that need `--profile` consumption declare it
 * via the slot, like an external plugin would.
 */
const AWS_DESCRIPTORS: Record<string, CLIDescriptor> = {
  aws: {
    positionPolicy: "globals-anywhere",
    flags: {
      profile: { aliases: ["--profile"], takesValue: true },
    },
  },
};

// ---------------------------------------------------------------------------
// subcommand: walker-parity extraction (unit)
// ---------------------------------------------------------------------------

describe("argv leaves: subcommand extraction parity", () => {
  it("git -C /path push extracts push (registry consuming -C)", async () => {
    assert.equal(
      await fires({ subcommand: "push" }, [w("-C"), w("/path"), w("push")], {
        descriptors: GIT_DESCRIPTORS,
      }),
      true,
    );
  });

  it("git -c KEY=VAL push extracts push (registry consuming -c)", async () => {
    assert.equal(
      await fires({ subcommand: "push" }, [w("-c"), w("KEY=VAL"), w("push")], {
        descriptors: GIT_DESCRIPTORS,
      }),
      true,
    );
  });

  it("WITHOUT the declaration, bare git resolves via the git plugin's declared descriptor (issue #106)", async () => {
    // Pre-#106 the bare form could not know `-c` consumes: `KEY=VAL`
    // was the first positional → mismatch → rule SKIPPED. Post-#106
    // the git plugin's declared descriptor (`-C`, `-c`) resolves by
    // basename (core seeds nothing — the map is passed explicitly),
    // so bare `subcommand: "push"` matches `git -c KEY=VAL push`.
    assert.equal(
      await fires({ subcommand: "push" }, [w("-c"), w("KEY=VAL"), w("push")], {
        descriptors: GIT_DESCRIPTORS,
      }),
      true,
    );
    // Unknown basename → LOUD: absent descriptors throw
    // MissingDescriptorError (never silent strict).
    await assert.rejects(
      fires({ subcommand: "push" }, [w("-c"), w("KEY=VAL"), w("push")], {
        basename: "unknown-basileus-xyz",
      }),
      /No CLI descriptor for basename "unknown-basileus-xyz"/,
    );
  });

  it("gh -R x/y pr merge extracts pr (registry consuming -R)", async () => {
    assert.equal(
      await fires(
        { subcommand: "pr" },
        [w("-R"), w("x/y"), w("pr"), w("merge")],
        {
          basename: "gh",
          descriptors: GH_DESCRIPTORS,
        },
      ),
      true,
    );
  });

  it("gh --repo=x/y pr extracts pr with NO declaration (attached form)", async () => {
    assert.equal(
      await fires({ subcommand: "pr" }, [w("--repo=x/y"), w("pr")], {
        basename: "gh",
        descriptors: GH_DESCRIPTORS,
      }),
      true,
    );
  });

  it("gh --hostname h pr extracts pr (registry consuming --hostname)", async () => {
    assert.equal(
      await fires({ subcommand: "pr" }, [w("--hostname"), w("h"), w("pr")], {
        basename: "gh",
        descriptors: GH_DESCRIPTORS,
      }),
      true,
    );
  });

  it("go -v build → unknown → fires fail-closed (after-only invalid)", async () => {
    assert.equal(
      await fires({ subcommand: "build" }, [w("-v"), w("build")], {
        basename: "go",
        // Explicit strict: policy still falls back to the walker table
        // (go → globals-after-only) → invalid shape → unknown.
        descriptors: { go: {} },
      }),
      true,
    );
  });

  it("aws s3 --profile x ls extracts the [s3, ls] sequence (bare array, width 2)", async () => {
    assert.equal(
      await fires(
        {
          subcommand: ["s3", "ls"],
        },
        [w("s3"), w("--profile"), w("x"), w("ls")],
        { basename: "aws", descriptors: AWS_DESCRIPTORS },
      ),
      true,
    );
  });

  it("slice-trap regression: [s3, --profile] must NOT match the aws run", async () => {
    // A contiguous `slice(0, 2)` rebuild would admit the consumed
    // `--profile` gap token; indices.map() never does.
    assert.equal(
      await fires(
        {
          subcommand: ["s3", "--profile"],
        },
        [w("s3"), w("--profile"), w("x"), w("ls")],
        { basename: "aws", descriptors: AWS_DESCRIPTORS },
      ),
      false,
    );
  });

  it("git push -C x extracts push (before-only: post-subcommand flags are subcommand args)", async () => {
    assert.equal(
      await fires({ subcommand: "push" }, [w("push"), w("-C"), w("x")], {
        descriptors: GIT_DESCRIPTORS,
      }),
      true,
    );
  });

  it("all-flags invocation (git --version) → unknown → fires", async () => {
    assert.equal(
      await fires({ subcommand: "push" }, [w("--version")], {
        descriptors: GIT_DESCRIPTORS,
      }),
      true,
    );
  });

  it("trailing consuming flag (git -C) → unknown → fires", async () => {
    assert.equal(
      await fires({ subcommand: "push" }, [w("-C")], {
        descriptors: GIT_DESCRIPTORS,
      }),
      true,
    );
  });

  it("explicit-strict { mytool: {} } falls back to globals-anywhere", async () => {
    assert.equal(
      await fires({ subcommand: "frobnicate" }, [w("frobnicate")], {
        basename: "mytool",
        descriptors: { mytool: {} },
      }),
      true,
    );
  });

  it("absent basename entry → MissingDescriptorError (loud)", async () => {
    await assert.rejects(
      fires({ subcommand: "frobnicate" }, [w("frobnicate")], {
        basename: "mytool",
      }),
      /No CLI descriptor for basename "mytool"/,
    );
  });
});

// ---------------------------------------------------------------------------
// subcommand: pattern semantics (unit)
// ---------------------------------------------------------------------------

describe("argv leaves: subcommand pattern semantics", () => {
  it("bare string is EXACT equality (push ≠ pushback)", async () => {
    const g = { descriptors: GIT_DESCRIPTORS };
    assert.equal(await fires({ subcommand: "push" }, [w("push")], g), true);
    assert.equal(
      await fires({ subcommand: "push" }, [w("pushback")], g),
      false,
    );
  });

  it("RegExp tests (pushback matches /^push/)", async () => {
    assert.equal(
      await fires({ subcommand: /^push/ }, [w("pushback")], {
        descriptors: GIT_DESCRIPTORS,
      }),
      true,
    );
  });

  it("bare array is a positional sequence (length IS the width)", async () => {
    // `gh pr create` fires; `gh pr list` and `gh repo create` do not.
    const leaf: TopLevelWhenClause = { subcommand: ["pr", "create"] };
    const g = { basename: "gh", descriptors: GH_DESCRIPTORS };
    assert.equal(await fires(leaf, [w("pr"), w("create")], g), true);
    assert.equal(await fires(leaf, [w("pr"), w("list")], g), false);
    assert.equal(await fires(leaf, [w("repo"), w("create")], g), false);
    assert.equal(await fires(leaf, [w("pr")], g), false);
  });

  it("anyOf is the explicit OR (singles and sequences)", async () => {
    const g = { descriptors: GIT_DESCRIPTORS };
    assert.equal(
      await fires({ subcommand: { anyOf: ["push", "pull"] } }, [w("pull")], g),
      true,
    );
    assert.equal(
      await fires({ subcommand: { anyOf: ["push", "pull"] } }, [w("fetch")], g),
      false,
    );
    const seqs: TopLevelWhenClause = {
      subcommand: {
        anyOf: [
          ["pr", "create"],
          ["repo", "create"],
        ],
      },
    };
    const gh = { basename: "gh", descriptors: GH_DESCRIPTORS };
    assert.equal(await fires(seqs, [w("pr"), w("create")], gh), true);
    assert.equal(await fires(seqs, [w("repo"), w("create")], gh), true);
    assert.equal(await fires(seqs, [w("pr"), w("list")], gh), false);
    assert.equal(await fires(seqs, [w("repo"), w("delete")], gh), false);
  });

  it("sequence: full run required (aws s3 alone ≠ [s3, ls])", async () => {
    const leaf: TopLevelWhenClause = {
      subcommand: ["s3", "ls"],
    };
    assert.equal(
      await fires(leaf, [w("s3"), w("ls")], {
        basename: "aws",
        descriptors: AWS_DESCRIPTORS,
      }),
      true,
    );
    assert.equal(
      await fires(leaf, [w("s3")], {
        basename: "aws",
        descriptors: AWS_DESCRIPTORS,
      }),
      false,
    );
    assert.equal(
      await fires(leaf, [w("s3"), w("cp")], {
        basename: "aws",
        descriptors: AWS_DESCRIPTORS,
      }),
      false,
    );
  });

  it("sequence members mix string-exact + RegExp", async () => {
    const k = { basename: "kubectl", descriptors: { kubectl: {} } };
    assert.equal(
      await fires({ subcommand: ["get", /^pod/] }, [w("get"), w("pods")], k),
      true,
    );
    assert.equal(
      await fires({ subcommand: ["get", /^svc/] }, [w("get"), w("pods")], k),
      false,
    );
  });

  it("malformed leaves fail-SKIP (false, never unknown): matrix", async () => {
    const args = [w("push")];
    // Deleted `depth` key, spelled dynamically: the repo-wide
    // depth-key grep pin scans this file too, so the literal
    // cannot appear here — at runtime the key IS `depth`, so any
    // resurrection of `depth` handling flips these fail-skip asserts.
    const DELETED_DEPTH = ["dep", "th"].join("");
    const bad: TopLevelWhenClause[] = [
      // empty / non-Pattern arrays
      { subcommand: [] },
      { subcommand: ["push", 123] as unknown as SubcommandLeaf },
      // empty / malformed anyOf
      { subcommand: { anyOf: [] } as unknown as SubcommandLeaf },
      {
        subcommand: { anyOf: ["push", 123] } as unknown as SubcommandLeaf,
      },
      {
        subcommand: { anyOf: [["push", 123]] } as unknown as SubcommandLeaf,
      },
      { subcommand: { anyOf: [[]] } as unknown as SubcommandLeaf },
      { subcommand: { anyOf: "push" } as unknown as SubcommandLeaf },
      // non-Pattern scalar / missing anyOf
      { subcommand: 123 as unknown as SubcommandLeaf },
      { subcommand: {} as unknown as SubcommandLeaf },
      // deleted `{ pattern, depth }` shape (no shims, no dual-accept)
      { subcommand: { pattern: "push" } as unknown as SubcommandLeaf },
      {
        subcommand: {
          pattern: ["s3", "ls"],
          [DELETED_DEPTH]: 2,
        } as unknown as SubcommandLeaf,
      },
      {
        subcommand: {
          pattern: "push",
          [DELETED_DEPTH]: "2",
        } as unknown as SubcommandLeaf,
      },
    ];
    for (const when of bad) {
      assert.equal(
        await fires(when, args, { descriptors: GIT_DESCRIPTORS }),
        false,
        JSON.stringify(when),
      );
    }
  });

  it("deleted `{ pattern, depth }` shape fail-skips (false, never unknown)", async () => {
    // Pre-1.0 breaking, no shims: the old spread is malformed now, so
    // the leaf evaluates to `false` (rule skips) and never smuggles
    // the old extract-nothing → unknown → block path back in. The
    // deleted key is spelled dynamically (see the matrix above) so
    // the repo-wide depth-key pin keeps scanning this file.
    const DELETED_DEPTH = ["dep", "th"].join("");
    const g = { descriptors: GIT_DESCRIPTORS };
    assert.equal(
      await fires(
        {
          subcommand: {
            pattern: "push",
            [DELETED_DEPTH]: 0,
          } as unknown as SubcommandLeaf,
        },
        [w("push")],
        g,
      ),
      false,
    );
    assert.equal(
      await fires(
        {
          subcommand: {
            pattern: "push",
            [DELETED_DEPTH]: 0,
            onUnknown: "allow",
          } as unknown as SubcommandLeaf,
        },
        [w("push")],
        g,
      ),
      false,
    );
  });

  it("resolved-first: $X with X=--force classifies flag-shaped (never raw $X)", async () => {
    // `"$X"` IS `--force` at execution: skipped as a flag, so `push`
    // still extracts. The walker-raw scan would see positional `$X`.
    assert.equal(
      await fires(
        { subcommand: "push" },
        [w('"$X"', { value: "--force", rawText: '"$X"' }), w("push")],
        { descriptors: GIT_DESCRIPTORS },
      ),
      true,
    );
  });

  it("rawText fallback when text + value are both undefined", async () => {
    const g = { descriptors: GIT_DESCRIPTORS };
    assert.equal(
      await fires({ subcommand: "push" }, [rawOnly("push")], g),
      true,
    );
    assert.equal(
      await fires(
        { subcommand: "push" },
        [rawOnly("--force"), rawOnly("push")],
        g,
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// flag: presence semantics (unit)
// ---------------------------------------------------------------------------

describe("argv leaves: flag presence semantics", () => {
  const g = { descriptors: GIT_DESCRIPTORS };
  it("long exact token matches; absent flag is definite false", async () => {
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        [w("push"), w("--force")],
        g,
      ),
      true,
    );
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        [w("push")],
        g,
      ),
      false,
    );
  });

  it("attached --flag=value matches without declaration", async () => {
    // Attached forms need no consumption entry — but resolution still
    // requires a registry entry (loud otherwise).
    const gh = { basename: "gh", descriptors: GH_DESCRIPTORS };
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--repo"], takesValue: false }] } },
        [w("--repo=x/y")],
        gh,
      ),
      true,
    );
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--repo"], takesValue: false }] } },
        [w("--repo=x/y")],
        gh,
      ),
      true,
    );
  });

  it("short exact token matches", async () => {
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] } },
        [w("push"), w("-f")],
        g,
      ),
      true,
    );
  });

  it("bundles always match single-char shorts (-uf contains -u and -f)", async () => {
    // No opt-in (issue #115): bundling derives from the table. The git
    // table declares neither `-u` nor `-f`, so both bundle (undeclared
    // letters never glue).
    const args = [w("push"), w("-uf")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] } },
        args,
        g,
      ),
      true,
    );
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-u"], takesValue: false }] } },
        args,
        g,
      ),
      true,
    );
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-x"], takesValue: false }] } },
        args,
        g,
      ),
      false,
    );
  });

  it("bundle presence derives from the table (decidability matrix)", async () => {
    // Lead-letter rule on `-uf`: the first table-declared value-taking
    // letter glues the remainder; every other letter is present.
    const token = [w("push"), w("-uf")];
    const queryF = {
      flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] },
    };
    const queryU = {
      flag: { anyOf: [{ aliases: ["-u"], takesValue: false }] },
    };
    const table = (
      uTakes: boolean,
      fTakes: boolean,
    ): Record<string, CLIDescriptor> => ({
      bin: {
        positionPolicy: "globals-anywhere",
        flags: {
          u: { aliases: ["-u"], takesValue: uTakes },
          f: { aliases: ["-f"], takesValue: fTakes },
        },
      },
    });
    const onBin = (d: Record<string, CLIDescriptor>) => ({
      basename: "bin",
      descriptors: d,
    });
    // Neither takes a value → bundle, both present.
    assert.equal(await fires(queryF, token, onBin(table(false, false))), true);
    assert.equal(await fires(queryU, token, onBin(table(false, false))), true);
    // `u` takes a value → glued, `-f` absent; `-u` itself present.
    assert.equal(await fires(queryF, token, onBin(table(true, false))), false);
    assert.equal(await fires(queryU, token, onBin(table(true, false))), true);
    // Only `f` takes a value → bundle, `-f` present (`f` glues the
    // empty remainder; `u` precedes it, still present).
    assert.equal(await fires(queryF, token, onBin(table(false, true))), true);
    assert.equal(await fires(queryU, token, onBin(table(false, true))), true);
    // Both take a value → glued at `u`, `-f` absent.
    assert.equal(await fires(queryF, token, onBin(table(true, true))), false);
    assert.equal(await fires(queryU, token, onBin(table(true, true))), true);
  });

  it("undeclared letters never glue (strict-always, fail-closed)", async () => {
    // The git table declares neither `-u` nor `-f`: `-uf` bundles, so
    // `-f` is present. Over-presence fires the guard; the only remedy
    // for a false block is a table row (see the decidability matrix).
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] } },
        [w("push"), w("-uf")],
        g,
      ),
      true,
    );
  });

  it("declared-glued remainders never bundle-match", async () => {
    const gh = { basename: "gh", descriptors: GH_DESCRIPTORS };
    // `-Rfoo`: `R` is table-declared value-taking → glues `foo`.
    // `-R` itself IS present (glued form); `-f` rides in the glued
    // remainder → absent.
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-R"], takesValue: false }] } },
        [w("pr"), w("-Rfoo")],
        gh,
      ),
      true,
    );
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] } },
        [w("pr"), w("-Rfoo")],
        gh,
      ),
      false,
    );
    // Mid-token glue: `-xRfoo` presents the non-glued prefix `xR`
    // only — `f` past the declared glue letter is absent. (The scan
    // used to be glue-blind past the first letter.)
    const mid = [w("pr"), w("-xRfoo")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-x"], takesValue: false }] } },
        mid,
        gh,
      ),
      true,
    );
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-R"], takesValue: false }] } },
        mid,
        gh,
      ),
      true,
    );
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] } },
        mid,
        gh,
      ),
      false,
    );
  });

  it("glue letter present, its remainder absent (tar -fX vs -vf)", async () => {
    const tar = {
      basename: "tar",
      descriptors: {
        tar: {
          positionPolicy: "globals-anywhere",
          flags: {
            f: { aliases: ["-f"], takesValue: true },
            v: { aliases: ["-v"], takesValue: false },
          },
        },
      } as Record<string, CLIDescriptor>,
    };
    const queryF = {
      flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] },
    };
    const queryV = {
      flag: { anyOf: [{ aliases: ["-v"], takesValue: false }] },
    };
    // `-vf`: `v` precedes the glue letter → present; `f` glues the
    // empty remainder → present.
    assert.equal(await fires(queryV, [w("x"), w("-vf")], tar), true);
    assert.equal(await fires(queryF, [w("x"), w("-vf")], tar), true);
    // `-fX`: `f` present (glued form); `v` absent (nowhere in the token).
    assert.equal(await fires(queryF, [w("x"), w("-fX")], tar), true);
    assert.equal(await fires(queryV, [w("x"), w("-fX")], tar), false);
  });

  it("anyOf entries OR unchanged (multi-entry, multi-alias)", async () => {
    const leaf = {
      flag: {
        anyOf: [
          { aliases: ["-f", "--force"], takesValue: false },
          { aliases: ["-u", "--update"], takesValue: false },
        ],
      },
    };
    assert.equal(await fires(leaf, [w("push"), w("--force")], g), true);
    assert.equal(await fires(leaf, [w("push"), w("-u")], g), true);
    assert.equal(await fires(leaf, [w("push"), w("-x")], g), false);
    // Bundles fan out across entries too: `-ux` presents `-u`.
    assert.equal(await fires(leaf, [w("push"), w("-ux")], g), true);
  });

  it("stale bundleAware key is ignored (deleted-means-deleted)", async () => {
    // No stale-shape detection: the deleted opt-in channel is an
    // unknown key, ignored — the leaf stays valid and bundles match.
    const stale = {
      flag: {
        anyOf: [{ aliases: ["-f"], takesValue: false }],
        bundleAware: true,
      },
    } as unknown as TopLevelWhenClause;
    assert.equal(await fires(stale, [w("push"), w("-uf")], g), true);
  });

  it("longs NEVER bundle-match", async () => {
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        [w("--forceful")],
        g,
      ),
      false,
    );
    // Not even inside a real bundle: `-uf` carries no longs.
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        [w("push"), w("-uf")],
        g,
      ),
      false,
    );
  });

  it("consuming values skipped BY POSITION, never by content", async () => {
    // `gh -R --force pr` with -R in the plugin-registered gh
    // descriptor: `--force` is -R's VALUE.
    const args = [w("-R"), w("--force"), w("pr")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        args,
        {
          basename: "gh",
          descriptors: GH_DESCRIPTORS,
        },
      ),
      false,
    );
    // Unknown basename → LOUD: absent descriptors throw (never
    // silent strict).
    await assert.rejects(
      fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        args,
        {
          basename: "unknown-basileus-xyz",
        },
      ),
      /No CLI descriptor for basename "unknown-basileus-xyz"/,
    );
  });

  it("the consuming flag itself IS present (only its value is skipped)", async () => {
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-R"], takesValue: false }] } },
        [w("-R"), w("x/y"), w("pr")],
        {
          basename: "gh",
          descriptors: GH_DESCRIPTORS,
        },
      ),
      true,
    );
  });

  it("malformed flag leaves fail-SKIP (false, never unknown): matrix", async () => {
    const args = [w("push"), w("--force")];
    const bad: TopLevelWhenClause[] = [
      { flag: { anyOf: [] } },
      // non-string alias member → invalid entry → fail-skip
      {
        flag: {
          anyOf: [{ aliases: ["--force", 1], takesValue: false }],
        } as unknown as TopLevelWhenClause["flag"],
      } as TopLevelWhenClause,
      // multi-char short spellings are invalid members
      {
        flag: {
          anyOf: [{ aliases: ["-ff"], takesValue: false }],
        },
      },
      // bare `-` / `--` / non-dash spellings invalid
      { flag: { anyOf: [{ aliases: ["-"], takesValue: false }] } },
      { flag: { anyOf: [{ aliases: ["--"], takesValue: false }] } },
      { flag: { anyOf: [{ aliases: ["force"], takesValue: false }] } },
      // no bare form: non-object leaves invalid
      { flag: "--force" as unknown as FlagLeaf },
      { flag: ["--force"] as unknown as FlagLeaf },
      { flag: 123 as unknown as FlagLeaf },
    ];
    for (const when of bad) {
      assert.equal(await fires(when, args, g), false, JSON.stringify(when));
    }
  });

  it("rawText-only word does not throw (S1: resolved form decides)", async () => {
    // Regression: the bundle scan used to pass the original Word to
    // the walker (which reads resolved forms with no `rawText`
    // fallback → TypeError on `undefined.startsWith`), escaping out of
    // `evaluateFlag` into a fail-OPEN skip. The scan classifies on the
    // same resolved form as the rest of the scan → match → fires.
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] } },
        [rawOnly("-uf")],
        g,
      ),
      true,
    );
    // Non-matching bundle letter skips cleanly (no throw).
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-x"], takesValue: false }] } },
        [rawOnly("-uf")],
        g,
      ),
      false,
    );
    // All-absent word (no text/value/rawText) → `""` → positional,
    // never throws, never flag-shaped.
    const absent = {} as unknown as PredicateWord;
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-f"], takesValue: false }] } },
        [absent],
        g,
      ),
      false,
    );
    assert.equal(await fires({ subcommand: "push" }, [absent], g), false);
  });

  it("-- is flag-shaped; post--- positionals scan as ordinary tokens (documented limit)", async () => {
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        [w("--"), w("--force")],
        g,
      ),
      true,
    );
  });

  it("non-bash (no args) → unknown → fires; onUnknown allow skips", async () => {
    assert.equal(
      await firesOnWrite({
        flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] },
      }),
      true,
    );
    assert.equal(
      await firesOnWrite({
        flag: {
          anyOf: [{ aliases: ["--force"], takesValue: false }],
          onUnknown: "allow",
        },
      }),
      false,
    );
  });

  it("non-bash subcommand → unknown → fires; onUnknown allow skips", async () => {
    assert.equal(await firesOnWrite({ subcommand: "push" }), true);
    assert.equal(
      await firesOnWrite({
        subcommand: { anyOf: ["push"], onUnknown: "allow" },
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// not: blocks (Kleene, positive cases)
// ---------------------------------------------------------------------------

describe("argv leaves: not-block Kleene semantics", () => {
  const g = { descriptors: GIT_DESCRIPTORS };
  it("not: { subcommand } — mismatch fires, match skips", async () => {
    assert.equal(
      await fires({ not: { subcommand: "push" } }, [w("pull")], g),
      true,
    );
    assert.equal(
      await fires({ not: { subcommand: "push" } }, [w("push")], g),
      false,
    );
  });

  it("not: { flag } — absent fires, present skips", async () => {
    assert.equal(
      await fires(
        {
          not: {
            flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] },
          },
        },
        [w("push")],
        g,
      ),
      true,
    );
    assert.equal(
      await fires(
        {
          not: {
            flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] },
          },
        },
        [w("push"), w("--force")],
        g,
      ),
      false,
    );
  });

  it("not: { subcommand } on unknown extraction fires by default (block-level block)", async () => {
    assert.equal(
      await fires({ not: { subcommand: "build" } }, [w("-v"), w("build")], {
        basename: "go",
        descriptors: { go: {} },
      }),
      true,
    );
  });

  it("not: { subcommand } on unknown + block onUnknown allow skips", async () => {
    assert.equal(
      await fires(
        { not: { subcommand: "build", onUnknown: "allow" } },
        [w("-v"), w("build")],
        { basename: "go", descriptors: { go: {} } },
      ),
      false,
    );
  });

  it("not: never inverts a descriptor throw (absent leaf → rejects)", async () => {
    await assert.rejects(
      fires({ not: { subcommand: "push" } }, [w("push")], {
        basename: "mytool",
      }),
      /No CLI descriptor for basename "mytool"/,
    );
  });

  it("not: { flag } on non-bash fires by default (unknown → block-level block)", async () => {
    const ctx = mockContext({
      tool: "write",
      input: { tool: "write", path: "/x", content: "x" },
    });
    assert.equal(
      await evaluateWhen(
        {
          not: {
            flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] },
          },
        },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Exemptions: S1 strict (type + load-time + evaluation)
// ---------------------------------------------------------------------------

describe("argv leaves: exemption strictness (S1)", () => {
  it("type-level: onUnknown forbidden in exemption subcommand/flag spreads", () => {
    const _banSub: Exemption = {
      rule: "x",
      when: {
        subcommand: {
          anyOf: ["push"],
          // @ts-expect-error: leaf-level onUnknown forbidden in exemptions
          onUnknown: "allow",
        },
      },
    };
    const _banFlag: Exemption = {
      rule: "x",
      when: {
        flag: {
          anyOf: [{ aliases: ["--force"], takesValue: false }],
          // @ts-expect-error: leaf-level onUnknown forbidden in exemptions
          onUnknown: "allow",
        },
      },
    };
    const _banNotSub: Exemption = {
      rule: "x",
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
    const _banNotFlag: Exemption = {
      rule: "x",
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
    void _banSub;
    void _banFlag;
    void _banNotSub;
    void _banNotFlag;
    assert.ok(true);
  });

  it("load-time: smuggled onUnknown in ARGV spreads throws (incl. bare-keyed)", () => {
    const cases: Array<[string, TopLevelWhenClause]> = [
      [
        "anyOf",
        {
          flag: {
            anyOf: [{ aliases: ["--force"], takesValue: false }],
            onUnknown: "allow",
          },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "subcommand anyOf",
        {
          subcommand: { anyOf: ["push"], onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "pattern+onUnknown",
        {
          subcommand: { pattern: "push", onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
    ];
    for (const [label, when] of cases) {
      assert.throws(
        () => validateExemptionWhenClauseShape(when, `exemption ${label}`),
        /forbidden 'onUnknown/,
        label,
      );
    }
  });

  it("load-time: not-block smuggled onUnknown throws", () => {
    assert.throws(
      () =>
        validateExemptionWhenClauseShape(
          {
            not: {
              flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] },
              onUnknown: "allow",
            },
          } as unknown as TopLevelWhenClause,
          "exemption x",
        ),
      /forbidden 'onUnknown/,
    );
  });

  it("evaluation: smuggled onUnknown block never exempts on unknown (hard allow)", async () => {
    // `go -v build` extraction is null → unknown; even an as-any
    // `onUnknown: "block"` must NOT exempt.
    const smuggled = {
      subcommand: { anyOf: ["build"], onUnknown: "block" },
    } as unknown as TopLevelWhenClause;
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "go -v build",
        basename: "go",
        args: [w("-v"), w("build")],
      },
      descriptors: { go: {} },
    });
    assert.equal(
      await evaluateWhen(
        smuggled,
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "allow",
        true,
        { go: {} },
      ),
      false,
    );
  });

  it("evaluation: unknown extraction never exempts (default strict path)", async () => {
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "go -v build",
        basename: "go",
        args: [w("-v"), w("build")],
      },
      descriptors: { go: {} },
    });
    assert.equal(
      await evaluateWhen(
        { subcommand: "build" },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "allow",
        true,
        { go: {} },
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin-key collision parity with cwd
// ---------------------------------------------------------------------------

describe("argv leaves: plugin collision parity (explicit branch wins)", () => {
  it("a plugin registering `subcommand` does not shadow the built-in", async () => {
    const h = loadHarness({
      config: {
        plugins: [
          {
            name: "evil",
            predicates: {
              subcommand: () => false,
              flag: () => {
                throw new Error("must never run");
              },
            },
            rules: [],
          },
          // Explicit strict: this test is about predicate-key
          // precedence, not argv arity.
          { name: "git-facts", cliDescriptors: { git: {} } },
        ],
        rules: [gitRule({ subcommand: "push" })],
      },
    });
    await expectBlocks(
      h,
      { command: "git push origin main" },
      { rule: "no-push" },
    );
    await expectAllows(h, { command: "git pull" });
  });

  it("control: a plugin registering `cwd` behaves the same (explicit wins)", async () => {
    const h = loadHarness({
      config: {
        plugins: [
          {
            name: "evil",
            predicates: { cwd: () => false },
            rules: [],
          },
          // Explicit strict: this test is about predicate-key
          // precedence, not argv arity.
          { name: "git-facts", cliDescriptors: { git: {} } },
        ],
        rules: [
          {
            name: "no-push",
            tool: "bash",
            command: "git",
            reason: "no push",
            when: { cwd: /./ },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "git push origin main" },
      { rule: "no-push" },
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end acceptance matrix (#90 checkboxes)
// ---------------------------------------------------------------------------

describe("argv leaves: end-to-end acceptance (#90)", () => {
  it("git -C /path push + git -c KEY=VAL push match subcommand push", async () => {
    const h = loadHarness({
      config: {
        // Registry-only arity: the git plugin's declared descriptor
        // supplies `-C` / `-c` consumption (no inline declaration).
        plugins: [gitPlugin],
        rules: [gitRule({ subcommand: "push" })],
      },
    });
    await expectBlocks(
      h,
      { command: "git -C /path push origin main" },
      { rule: "no-push" },
    );
    await expectBlocks(
      h,
      { command: "git -c KEY=VAL push origin main" },
      { rule: "no-push" },
    );
    await expectAllows(h, { command: "git pull" });
  });

  it("flag bundles match git push -uf for -f (always on)", async () => {
    const h = loadHarness({
      config: {
        // Explicit strict: bundle matching needs no consumption facts.
        plugins: [{ name: "git-facts", cliDescriptors: { git: {} } }],
        rules: [
          gitRule({
            flag: {
              anyOf: [{ aliases: ["-f", "--force"], takesValue: false }],
            },
          }),
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "git push -uf origin main" },
      { rule: "no-push" },
    );
    await expectBlocks(
      h,
      { command: "git push --force origin main" },
      { rule: "no-push" },
    );
    await expectAllows(h, { command: "git push origin main" });
  });

  it("gh -R x/y pr merge / --repo= / --hostname shapes extract pr", async () => {
    const h = loadHarness({
      config: {
        // Synthetic plugin-registered gh descriptor (core seeds no
        // `gh` — owned by pi-steering-github).
        plugins: [
          {
            name: "gh-facts",
            cliDescriptors: {
              gh: {
                positionPolicy: "globals-anywhere",
                flags: {
                  R: { aliases: ["-R"], takesValue: true },
                  repo: { aliases: ["--repo"], takesValue: true },
                  hostname: { aliases: ["--hostname"], takesValue: true },
                },
              },
            },
          },
        ],
        rules: [
          {
            name: "no-pr-merge",
            tool: "bash",
            command: "gh",
            reason: "no merge",
            when: { subcommand: "pr" },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "gh -R x/y pr merge 1" },
      { rule: "no-pr-merge" },
    );
    await expectBlocks(
      h,
      { command: "gh --repo=x/y pr merge 1" },
      { rule: "no-pr-merge" },
    );
    await expectBlocks(
      h,
      { command: "gh --hostname h pr merge 1" },
      { rule: "no-pr-merge" },
    );
    await expectAllows(h, { command: "gh -R x/y issue list" });
  });

  it("go -v build blocks fail-closed (after-only invalid → unknown → block)", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-build",
            tool: "bash",
            command: "go",
            reason: "no build",
            when: { subcommand: "build" },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "go -v build ./..." },
      { rule: "no-build" },
    );
  });

  it("aws s3 --profile x ls matches [s3, ls]; inner sh -c ref works", async () => {
    const h = loadHarness({
      config: {
        // Synthetic plugin-registered aws descriptor for `--profile`.
        plugins: [
          {
            name: "aws-facts",
            cliDescriptors: {
              aws: {
                positionPolicy: "globals-anywhere",
                flags: {
                  profile: { aliases: ["--profile"], takesValue: true },
                },
              },
            },
          },
        ],
        rules: [
          {
            name: "no-s3-ls",
            tool: "bash",
            command: "aws",
            reason: "no ls",
            when: {
              subcommand: ["s3", "ls"],
            },
          },
          gitRule({
            flag: {
              anyOf: [{ aliases: ["-f", "--force"], takesValue: false }],
            },
          }),
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "aws s3 --profile x ls s3://b" },
      { rule: "no-s3-ls" },
    );
    await expectAllows(h, { command: "aws s3 --profile x cp a b" });
    // Wrapper inner ref: the engine evaluates the expanded `git push -uf`.
    await expectBlocks(
      h,
      { command: "sh -c 'git push -uf origin main'" },
      { rule: "no-push" },
    );
  });

  it("write/edit rules with argv leaves fire fail-closed", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-write",
            tool: "write",
            field: "path",
            pattern: "^/tmp/",
            reason: "no write",
            when: { subcommand: "push" },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { write: { path: "/tmp/x", content: "x" } },
      { rule: "no-write" },
    );
  });

  it("exemption with subcommand exempts on match, never on unknown", async () => {
    const h = loadHarness({
      config: {
        // Explicit strict: exemption parity needs no consumption facts.
        plugins: [{ name: "git-facts", cliDescriptors: { git: {} } }],
        rules: [
          {
            name: "no-git",
            tool: "bash",
            command: "git",
            reason: "no git",
          },
        ],
        exemptions: [{ rule: "no-git", when: { subcommand: "pull" } }],
      },
    });
    await expectAllows(h, { command: "git pull" });
    await expectBlocks(
      h,
      { command: "git push origin main" },
      { rule: "no-git" },
    );
    // All-flags: extraction null → unknown → guard still fires.
    await expectBlocks(h, { command: "git --version" }, { rule: "no-git" });
  });
});

// ---------------------------------------------------------------------------
// Validator message + root re-exports
// ---------------------------------------------------------------------------

describe("argv leaves: validator + surface", () => {
  it("empty-clause error names the new leaves", async () => {
    const { validateWhenClauseShape } = await import("./predicates.ts");
    assert.throws(
      () => validateWhenClauseShape({}, 'rule "x".when'),
      /subcommand:.*flag:|flag:.*subcommand:/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI descriptors: leaf integration (issue #106 step-4)
// ---------------------------------------------------------------------------

describe("argv leaves: CLI descriptor auto-resolution (issue #106)", () => {
  it("git -C /x push resolves the git plugin's declared descriptor with NO inline declaration", async () => {
    const h = loadHarness({
      config: {
        // Plugin-owned facts (§13): git resolution needs the git
        // plugin declared — core seeds nothing.
        plugins: [gitPlugin],
        rules: [
          gitRule({ subcommand: "push" }),
          gitRule({
            flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] },
          }),
        ],
      },
    });
    // Subcommand leaf via registry.
    await expectBlocks(
      h,
      { command: "git -C /x push origin main" },
      { rule: "no-push" },
    );
    await expectAllows(h, { command: "git -C /x pull" });
  });

  it("gh descriptor leaf-resolution (-R/--repo minimum, not git-only)", async () => {
    const ghRule = (when: TopLevelWhenClause): Rule => ({
      name: "no-pr",
      tool: "bash",
      command: "gh",
      reason: "no pr",
      when,
    });
    const h = loadHarness({
      // Synthetic plugin-registered gh descriptor (core seeds no
      // `gh` — owned by pi-steering-github). Mirrors GH_DESCRIPTORS
      // at the unit layer.
      config: {
        plugins: [
          {
            name: "gh-facts",
            cliDescriptors: {
              gh: {
                positionPolicy: "globals-anywhere",
                flags: {
                  R: { aliases: ["-R"], takesValue: true },
                  repo: { aliases: ["--repo"], takesValue: true },
                  hostname: { aliases: ["--hostname"], takesValue: true },
                },
              },
            },
          },
        ],
        rules: [ghRule({ subcommand: "pr" })],
      },
    });
    await expectBlocks(
      h,
      { command: "gh -R x/y pr merge 1" },
      { rule: "no-pr" },
    );
    await expectBlocks(
      h,
      { command: "gh --repo x/y pr merge 1" },
      { rule: "no-pr" },
    );
    await expectAllows(h, { command: "gh -R x/y issue list" });
  });

  it("explicit-strict { mycli: {} } → silent strict default", async () => {
    const h = loadHarness({
      config: {
        plugins: [{ name: "mycli-facts", cliDescriptors: { mycli: {} } }],
        rules: [
          {
            name: "no-sub",
            tool: "bash",
            command: "mycli",
            reason: "no sub",
            when: { subcommand: "push" },
          },
        ],
      },
    });
    // Explicit strict, no table: `-C` consumes nothing, `/x` is the
    // subcommand → mismatch → allow.
    await expectAllows(h, { command: "mycli -C /x push" });
    await expectBlocks(h, { command: "mycli push" }, { rule: "no-sub" });
  });

  it("absent descriptor → rule-TAGGED block (not generic engine error)", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-sub",
            tool: "bash",
            command: "mycli",
            reason: "no sub",
            when: { subcommand: "push" },
          },
        ],
      },
    });
    // No descriptor anywhere: the per-ref binding rethrows with rule
    // context → top-level fail-closed catch emits an actionable block
    // naming rule + basename + remedy (ask the user).
    const res = await expectBlocks(
      h,
      { command: "mycli push" },
      { rule: "no-sub" },
    );
    const reason =
      res && "reason" in res && typeof res.reason === "string"
        ? res.reason
        : "";
    assert.match(reason, /\[steering:no-sub@user\]/);
    assert.match(reason, /No CLI descriptor for basename "mycli"/);
    assert.match(reason, /Plugin\.cliDescriptors\.mycli/);
    assert.match(reason, /\{ "mycli": \{\} \}/);
    assert.match(reason, /Ask the user/);
    assert.doesNotMatch(reason, /engine error/);
  });

  it("absent descriptor on the condition path → same tagged block", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-mycli",
            tool: "bash",
            command: "mycli",
            reason: "no mycli",
            when: {
              condition: (ctx) => ctx.command.positionals().length > 0,
            },
          },
        ],
      },
    });
    await expectBlocks(h, { command: "mycli push" }, { rule: "no-mycli" });
  });

  it("not:-wrapped absent leaf → block (no inversion)", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-sub",
            tool: "bash",
            command: "mycli",
            reason: "no sub",
            when: { not: { subcommand: "push" } },
          },
        ],
      },
    });
    // Binding throws before the not-block ever runs; the throw is a
    // verdict-never — nothing inverts it to allow.
    await expectBlocks(h, { command: "mycli push" }, { rule: "no-sub" });
  });

  it("invalid registry policy → skip + one-shot WARN ([invalid-descriptor])", async () => {
    const { __resetDescriptorWarningsForTests } = await import("../arity.ts");
    __resetDescriptorWarningsForTests();
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown, ...rest: unknown[]) => {
      warnings.push(String(msg));
    };
    try {
      const ctx = mockContext({
        input: {
          tool: "bash",
          command: "git push",
          basename: "git",
          args: [
            { text: "push", value: "push", rawText: "push" } as PredicateWord,
          ],
        },
        descriptors: { git: {} },
      });
      const bad = { git: { positionPolicy: "bogus" } } as unknown as Record<
        string,
        { positionPolicy: "bogus" }
      >;
      // First call warns once.
      const first = await evaluateWhen(
        { subcommand: "push" },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "block",
        false,
        bad as never,
      );
      assert.equal(first, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /\[invalid-descriptor\]/);
      // Second call: one-shot, no additional WARN.
      const second = await evaluateWhen(
        { subcommand: "push" },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "block",
        false,
        bad as never,
      );
      assert.equal(second, false);
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = orig;
      __resetDescriptorWarningsForTests();
    }
  });

  it("invalid registry flags → strict-empty + one-shot WARN ([invalid-descriptor])", async () => {
    const { __resetDescriptorWarningsForTests } = await import("../arity.ts");
    __resetDescriptorWarningsForTests();
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown, ...rest: unknown[]) => {
      warnings.push(String(msg));
    };
    try {
      const ctx = mockContext({
        input: {
          tool: "bash",
          command: "git push",
          basename: "git",
          args: [
            { text: "-C", value: "-C", rawText: "-C" } as PredicateWord,
            { text: "/x", value: "/x", rawText: "/x" } as PredicateWord,
            { text: "push", value: "push", rawText: "push" } as PredicateWord,
          ],
        },
        descriptors: { git: {} },
      });
      const bad = {
        git: { flags: "--not-a-table" },
      } as unknown as Record<string, CLIDescriptor>;
      const first = await evaluateWhen(
        { subcommand: "push" },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "block",
        false,
        bad as never,
      );
      // `-C` treated as non-consuming → `/x` is the subcommand → mismatch.
      assert.equal(first, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /\[invalid-descriptor\]/);
      const second = await evaluateWhen(
        { subcommand: "push" },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "block",
        false,
        bad as never,
      );
      assert.equal(second, false);
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = orig;
      __resetDescriptorWarningsForTests();
    }
  });

  it("leaf/facade agreement at VALUE level (issue #107)", async () => {
    // `push --delete origin`: the flag leaf and the per-ref
    // `commandFromInput` binding agree `--delete` is present AND
    // valueless (the #106 presence-only limitation is lifted).
    const h = loadHarness({
      config: {
        rules: [
          gitRule({
            flag: { anyOf: [{ aliases: ["--delete"], takesValue: false }] },
          }),
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "git push --delete origin" },
      { rule: "no-push" },
    );
    const deleted = [
      { text: "push", value: "push", rawText: "push" } as PredicateWord,
      {
        text: "--delete",
        value: "--delete",
        rawText: "--delete",
      } as PredicateWord,
      {
        text: "origin",
        value: "origin",
        rawText: "origin",
      } as PredicateWord,
    ];
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "git push --delete origin",
        basename: "git",
        args: deleted,
      },
      descriptors: GIT_DESCRIPTORS,
    });
    assert.equal(
      ctx.command.hasFlag({ aliases: ["--delete"], takesValue: false }),
      true,
    );
    assert.equal(
      ctx.command.getFlagValue({ aliases: ["--delete"], takesValue: false }),
      null,
    );
    assert.deepEqual(
      ctx.command.getAllFlagValues({
        aliases: ["--delete"],
        takesValue: false,
      }),
      [],
    );
    assert.deepEqual(ctx.command.positionals(), ["push", "--delete", "origin"]);
  });

  it("positionals() skip-set equals leaf consumption set (minus the -- axis)", async () => {
    // Shared fixture: `gh pr merge --repo TEXT` with the synthetic gh
    // descriptor. The leaf skips TEXT by position; the facade's
    // `positionals()` skips the same set.
    const args = [
      { text: "pr", value: "pr", rawText: "pr" } as PredicateWord,
      { text: "merge", value: "merge", rawText: "merge" } as PredicateWord,
      { text: "--repo", value: "--repo", rawText: "--repo" } as PredicateWord,
      { text: "TEXT", value: "TEXT", rawText: "TEXT" } as PredicateWord,
    ];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--repo"], takesValue: false }] } },
        args,
        {
          basename: "gh",
          descriptors: GH_DESCRIPTORS,
        },
      ),
      true,
    );
    // The consumed VALUE is not flaggable: `--body`'s `TEXT` never
    // reports present even when queried through a matching shape —
    // pin via the `-R`/`--force` consumption pair on shared args.
    const consumed = [w("-R"), w("--force"), w("pr")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        consumed,
        {
          basename: "gh",
          descriptors: GH_DESCRIPTORS,
        },
      ),
      false,
    );
    const ctx = mockContext({
      input: { tool: "bash", command: "gh …", basename: "gh", args },
      descriptors: GH_DESCRIPTORS,
    });
    assert.equal(
      ctx.command.getFlagValue({ aliases: ["--repo"], takesValue: true }),
      "TEXT",
    );
    assert.deepEqual(ctx.command.positionals(), ["pr", "merge"]);
    const cctx = mockContext({
      input: { tool: "bash", command: "gh …", basename: "gh", args: consumed },
      descriptors: GH_DESCRIPTORS,
    });
    assert.deepEqual(cctx.command.positionals(), ["pr"]);
    // `--` axis divergence (documented, no action): `positionals()`
    // is `--`-aware while `when.flag` still scans post-`--` tokens.
    const dashed = [...args, w("--"), w("--force")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        dashed,
        {
          basename: "gh",
          descriptors: GH_DESCRIPTORS,
        },
      ),
      true,
    );
    const dctx = mockContext({
      input: { tool: "bash", command: "gh …", basename: "gh", args: dashed },
      descriptors: GH_DESCRIPTORS,
    });
    assert.deepEqual(dctx.command.positionals(), ["pr", "merge", "--force"]);
  });

  it("exemption parity: unknown never exempts (kept pin)", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-git",
            tool: "bash",
            command: "git",
            reason: "no git",
          },
        ],
        exemptions: [{ rule: "no-git", when: { subcommand: "pull" } }],
      },
    });
    // No git descriptor anywhere: the per-ref binding throws →
    // rule-tagged block (guard still fires — unknown never exempts).
    await expectBlocks(h, { command: "git --version" }, { rule: "no-git" });
  });

  it("exemption definite-flip: subcommand push matches git -C /x push via the git plugin's descriptor", async () => {
    const h = loadHarness({
      config: {
        // The exemption-rule build path threads descriptors too —
        // gitPlugin here covers both rule and exemption leaves.
        plugins: [gitPlugin],
        rules: [
          {
            name: "no-push",
            tool: "bash",
            command: "git",
            reason: "no push",
          },
        ],
        exemptions: [{ rule: "no-push", when: { subcommand: "push" } }],
      },
    });
    await expectAllows(h, { command: "git -C /x push origin main" });
    await expectBlocks(h, { command: "git -C /x pull" }, { rule: "no-push" });
  });

  it("exemption not-block+descriptor parity: not:{subcommand:push} on git -C /x push MUST NOT exempt", async () => {
    const h = loadHarness({
      config: {
        plugins: [gitPlugin],
        rules: [
          {
            name: "no-push",
            tool: "bash",
            command: "git",
            reason: "no push",
            when: { subcommand: "push" },
          },
        ],
        exemptions: [
          { rule: "no-push", when: { not: { subcommand: "push" } } },
        ],
      },
    });
    // Inner push matches via descriptor → not(push) is false → no
    // exemption → guard fires. Proves the evaluateWhen→evaluateNotBlock
    // descriptor forward.
    await expectBlocks(
      h,
      { command: "git -C /x push origin main" },
      { rule: "no-push" },
    );
  });

  it("exemption path: descriptor throw → non-match + warn (guard still fires)", async () => {
    // evaluateExemptionClause's catch is UNCHANGED by the loudness
    // work: a throwing exemption predicate = "does not match" =
    // guard fires (fail-closed in the guard's direction).
    // mockContext binds with explicit-strict so the facade builds;
    // the exemption clause itself resolves against an EMPTY registry
    // (absent → throw → non-match).
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "mycli push",
        basename: "mycli",
        args: [w("push")],
      },
      descriptors: { mycli: {} },
    });
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const matched = await evaluateExemptionClause(
        { subcommand: "push" },
        { cwd: "/tmp/test" } as never,
        ctx,
        { predicates: {}, descriptors: {} } as never,
        "no-sub",
      );
      assert.equal(matched, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /exemption for rule "no-sub" threw/);
      assert.match(warnings[0] ?? "", /No CLI descriptor for basename "mycli"/);
    } finally {
      console.warn = orig;
    }
  });
});

describe("leaf/facade agreement (issue #110)", () => {
  it("gh -Rfoo agrees presence TRUE both sides (blind-default divergence closed)", async () => {
    const args = [w("-Rfoo")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["-R"], takesValue: true }] } },
        args,
        { basename: "gh", descriptors: GH_DESCRIPTORS },
      ),
      true,
    );
    const ctx = mockContext({
      input: { tool: "bash", command: "gh …", basename: "gh", args },
      descriptors: GH_DESCRIPTORS,
    });
    assert.equal(
      ctx.command.hasFlag({ aliases: ["-R"], takesValue: true }),
      true,
    );
  });

  it("push --delete origin agrees leaf-vs-facade at VALUE level", async () => {
    const args = [w("push"), w("--delete"), w("origin")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--delete"], takesValue: false }] } },
        args,
        { basename: "git", descriptors: GIT_DESCRIPTORS },
      ),
      true,
    );
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "git push --delete origin",
        basename: "git",
        args,
      },
      descriptors: GIT_DESCRIPTORS,
    });
    assert.equal(
      ctx.command.getFlagValue({ aliases: ["--delete"], takesValue: false }),
      null,
    );
    assert.deepEqual(ctx.command.positionals(), ["push", "--delete", "origin"]);
  });

  it("anyOf-entries migration: OR-over-entries × OR-over-aliases truth table", async () => {
    const args = [w("--subject"), w("x")];
    // Single entry, both aliases.
    assert.equal(
      await fires(
        {
          flag: {
            anyOf: [{ aliases: ["-t", "--subject"], takesValue: false }],
          },
        },
        args,
        { basename: "git", descriptors: GIT_DESCRIPTORS },
      ),
      true,
    );
    // Two entries, one alias each — same verdict.
    assert.equal(
      await fires(
        {
          flag: {
            anyOf: [
              { aliases: ["-t"], takesValue: false },
              { aliases: ["--subject"], takesValue: false },
            ],
          },
        },
        args,
        { basename: "git", descriptors: GIT_DESCRIPTORS },
      ),
      true,
    );
    // Neither alias present → false.
    assert.equal(
      await fires(
        {
          flag: {
            anyOf: [{ aliases: ["-t", "--subject"], takesValue: false }],
          },
        },
        [w("push")],
        { basename: "git", descriptors: GIT_DESCRIPTORS },
      ),
      false,
    );
  });

  it("invalid-entry silent-skip pin (leaf false, no WARN — vs descriptor WARN at merger)", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const result = await fires(
        {
          flag: {
            anyOf: [{ aliases: [], takesValue: true } as unknown as never],
          },
        },
        [w("push")],
        { basename: "git", descriptors: GIT_DESCRIPTORS },
      );
      assert.equal(result, false);
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = orig;
    }
  });

  it("unlisted-flag strict-always re-pinned (absent-from-table never consumes)", async () => {
    // --unknown with a value: leaf sees --unknown present, but TEXT is
    // NOT consumed (strict) — it stays positional in the facade view.
    const args = [w("--unknown"), w("TEXT"), w("push")];
    assert.equal(
      await fires(
        { flag: { anyOf: [{ aliases: ["--unknown"], takesValue: false }] } },
        args,
        { basename: "git", descriptors: GIT_DESCRIPTORS },
      ),
      true,
    );
    const ctx = mockContext({
      input: { tool: "bash", command: "git …", basename: "git", args },
      descriptors: GIT_DESCRIPTORS,
    });
    // TEXT was NOT consumed as --unknown's value: it surfaces positional.
    assert.ok(ctx.command.positionals().includes("TEXT"));
  });

  it("nameless-ref empty-arity pin (no basename → silent strict, never throws)", async () => {
    const ctx = mockContext({
      input: { tool: "bash", command: "VAR=x", args: [w("VAR=x")] } as never,
    });
    assert.equal(
      await evaluateWhen(
        { flag: { anyOf: [{ aliases: ["--force"], takesValue: false }] } },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
      ),
      false,
    );
  });

  it("leaf↔facade AGREEMENT pin (issue #123 — one scan, re-split impossible)", async () => {
    // Same argv + same entries through `when.flag` and
    // `ctx.command.hasFlag` ALWAYS agree — both delegate to the shared
    // `flagPresenceScan`, so the facade cannot be re-split bundle-blind
    // without tripping this matrix (including the false/false rows).
    const rows: {
      tokens: string[];
      entry: CLIFlag;
      basename: string;
      descriptors: Record<string, CLIDescriptor>;
    }[] = [
      // Exact token.
      {
        tokens: ["push", "--force"],
        entry: { aliases: ["--force"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // Attached `--flag=value`.
      {
        tokens: ["--mirror=x"],
        entry: { aliases: ["--mirror"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // Declared consuming flag skips its value BY POSITION (`-f` is
      // `-C`'s value here — absent on BOTH sides; the old blind facade
      // reported present).
      {
        tokens: ["-C", "-f"],
        entry: { aliases: ["-f"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // Undeclared-letter bundle: full body present (`-uf` → `-f`).
      {
        tokens: ["-uf"],
        entry: { aliases: ["-f"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // Glue truncation: `-Cfoo` presents `C` (glue, takesValue) …
      {
        tokens: ["-Cfoo"],
        entry: { aliases: ["-C"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // … and never what the glue consumed (`f`).
      {
        tokens: ["-Cfoo"],
        entry: { aliases: ["-f"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // Longs never bundle-match.
      {
        tokens: ["--force"],
        entry: { aliases: ["-f"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // Consuming long skips a flag-shaped value.
      {
        tokens: ["--git-dir", "--force"],
        entry: { aliases: ["--force"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // Absent on both sides.
      {
        tokens: ["push"],
        entry: { aliases: ["--force"], takesValue: false },
        basename: "git",
        descriptors: GIT_DESCRIPTORS,
      },
      // gh glued form through the synthetic table.
      {
        tokens: ["-Rfoo"],
        entry: { aliases: ["-R"], takesValue: true },
        basename: "gh",
        descriptors: GH_DESCRIPTORS,
      },
      {
        tokens: ["-Rfoo"],
        entry: { aliases: ["-f"], takesValue: false },
        basename: "gh",
        descriptors: GH_DESCRIPTORS,
      },
    ];
    for (const { tokens, entry, basename, descriptors } of rows) {
      const args = tokens.map((t) => w(t));
      const leaf = await fires({ flag: { anyOf: [entry] } }, args, {
        basename,
        descriptors,
      });
      const ctx = mockContext({
        input: { tool: "bash", command: `${basename} …`, basename, args },
        descriptors,
      });
      assert.equal(
        ctx.command.hasFlag(entry),
        leaf,
        `leaf↔facade disagree on [${tokens.join(" ")}] × ${entry.aliases.join("/")}`,
      );
    }
  });
});

describe("unknown-predicate projection (issue #75 layer 2)", () => {
  // Defense-in-depth for direct `evaluateWhen` callers (SDK embedders,
  // tests) that bypass the load-time key check: unregistered keys
  // project `"unknown"` under the block-level `onUnknown:` policy —
  // fail-closed in rule mode, no-match in exemption mode — instead of
  // throwing into catch-and-skip (the old silent fail-open).
  it("outer unknown key fires under the block default (and warns)", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      assert.equal(
        await fires(
          { totallyMadeUp: true } as unknown as TopLevelWhenClause,
          [w("push")],
          { basename: "git", descriptors: GIT_DESCRIPTORS },
        ),
        true,
      );
      assert.ok(
        warnings.some((msg) =>
          /when\.totallyMadeUp names an unregistered predicate/.test(msg),
        ),
        `no matching warning in:\n${warnings.join("\n")}`,
      );
    } finally {
      console.warn = orig;
    }
  });

  it("outer unknown key skips under onUnknown allow", async () => {
    assert.equal(
      await fires(
        { totallyMadeUp: true } as unknown as TopLevelWhenClause,
        [w("push")],
        {
          basename: "git",
          descriptors: GIT_DESCRIPTORS,
          onUnknownDefault: "allow",
        },
      ),
      false,
    );
  });

  it("not: { <unknown> } projects without the not-flip", async () => {
    assert.equal(
      await fires(
        { not: { totallyMadeUp: true } } as unknown as TopLevelWhenClause,
        [w("push")],
        { basename: "git", descriptors: GIT_DESCRIPTORS },
      ),
      true,
    );
  });

  it("exemption mode still lands no-match (no S1 regression)", async () => {
    // The exemption evaluator's ("allow", ignore-explicit) projection
    // turns the same unknown into no-match → the target guard fires.
    assert.equal(
      await fires(
        { totallyMadeUp: true } as unknown as TopLevelWhenClause,
        [w("push")],
        {
          basename: "git",
          descriptors: GIT_DESCRIPTORS,
          onUnknownDefault: "allow",
          ignoreExplicitModifiers: true,
        },
      ),
      false,
    );
  });
});
