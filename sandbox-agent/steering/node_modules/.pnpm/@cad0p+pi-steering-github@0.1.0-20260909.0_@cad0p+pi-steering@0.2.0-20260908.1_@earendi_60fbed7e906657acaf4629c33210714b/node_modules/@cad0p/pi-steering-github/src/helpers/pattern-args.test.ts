// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Unit tests for the arg helpers (`unquote`, `findFlagValue`,
 * `findBodyFileValue`, `parseBodyFileArg`, `explainBodyFileArg`,
 * `renderBodyFileDiff`, `resolveAgainstCwd`) and their scaffolding.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateContext } from "@cad0p/pi-steering";
import { BODY_STRIP } from "./body-strip.ts";
import {
  countSubstitutionTokens,
  EXPECTED_SUBSTITUTION_TOKENS,
  explainBodyFileArg,
  findBodyFileValue,
  findFlagValue,
  parseBodyFileArg,
  renderBodyFileDiff,
  resolveAgainstCwd,
  unquote,
} from "./pattern-args.ts";

// ---------------------------------------------------------------------------
// Test scaffolding: hand-built ctx
// ---------------------------------------------------------------------------

type ExecStub = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Hand-built predicate ctx. `args` are walker words in `{ text }`
 * form (the shape `argText` reads). `env` seeds the walker's
 * tracked env at the command ref (tilde expansion reads it first,
 * falling back to `process.env` when absent).
 */
function makeCtx(
  args: readonly { text: string }[],
  cwd: string,
  exec?: ExecStub,
  env?: ReadonlyMap<string, string>,
): PredicateContext {
  const ctx = {
    cwd,
    tool: "bash",
    input: { tool: "bash", command: "gh pr create", basename: "gh", args },
    agentLoopIndex: 0,
    exec:
      exec ??
      (async (_cmd, _args) => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
    appendEntry: () => {},
    findEntries: () => [],
    walkerState: env !== undefined ? { cwd, env } : {},
  };
  return ctx as unknown as PredicateContext;
}

// ---------------------------------------------------------------------------
// unquote / findFlagValue (unchanged helpers)
// ---------------------------------------------------------------------------

describe("unquote", () => {
  it("strips one level of wrapping quotes", () => {
    assert.equal(unquote('"body.md"'), "body.md");
    assert.equal(unquote("'body.md'"), "body.md");
    assert.equal(unquote("body.md"), "body.md");
  });
});

describe("findFlagValue", () => {
  it("reads the value after the flag (space form)", () => {
    const ctx = makeCtx(
      [
        { text: "pr" },
        { text: "create" },
        { text: "--body-file" },
        { text: "body.md" },
      ],
      "/work/repo",
    );
    assert.equal(findFlagValue(ctx, ["--body-file", "-F"]), "body.md");
  });

  it("reads the value from the --flag=value form", () => {
    const ctx = makeCtx(
      [{ text: "pr" }, { text: "create" }, { text: "--body-file=body.md" }],
      "/work/repo",
    );
    assert.equal(findFlagValue(ctx, ["--body-file", "-F"]), "body.md");
  });

  it("returns null when the flag is absent", () => {
    const ctx = makeCtx(
      [{ text: "pr" }, { text: "create" }, { text: "--title" }, { text: "x" }],
      "/work/repo",
    );
    assert.equal(findFlagValue(ctx, ["--body-file", "-F"]), null);
  });
});

// ---------------------------------------------------------------------------
// findBodyFileValue
// ---------------------------------------------------------------------------

describe("findBodyFileValue", () => {
  it("reads the value after the flag (space form)", () => {
    const ctx = makeCtx(
      [{ text: "--body-file" }, { text: "body.md" }],
      "/work/repo",
    );
    assert.equal(findBodyFileValue(ctx), "body.md");
  });

  it("reads the value from the unsplit --flag=value form", () => {
    const ctx = makeCtx([{ text: "--body-file=body.md" }], "/work/repo");
    assert.equal(findBodyFileValue(ctx), "body.md");
  });

  it("handles the walker-split glued form (--body-file= + next word)", () => {
    const ctx = makeCtx(
      [
        { text: "--body-file=" },
        { text: `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/body.md)` },
      ],
      "/work/repo",
    );
    assert.equal(
      findBodyFileValue(ctx),
      `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/body.md)`,
    );
  });

  it("handles the walker-split glued short form (-F= + next word)", () => {
    const ctx = makeCtx(
      [
        { text: "-F=" },
        { text: `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/body.md)` },
      ],
      "/work/repo",
    );
    assert.equal(
      findBodyFileValue(ctx),
      `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/body.md)`,
    );
  });

  it("returns '' for a trailing --body-file= (fail-closed)", () => {
    const ctx = makeCtx([{ text: "--body-file=" }], "/work/repo");
    assert.equal(findBodyFileValue(ctx), "");
  });

  it("returns '' for a trailing --body-file with no value", () => {
    const ctx = makeCtx([{ text: "--body-file" }], "/work/repo");
    assert.equal(findBodyFileValue(ctx), "");
  });

  it("supports the short -F form", () => {
    const ctx = makeCtx([{ text: "-F" }, { text: "body.md" }], "/work/repo");
    assert.equal(findBodyFileValue(ctx), "body.md");
  });

  it("returns '' when the flag is absent", () => {
    const ctx = makeCtx([{ text: "--title" }, { text: "x" }], "/work/repo");
    assert.equal(findBodyFileValue(ctx), "");
  });
});

// ---------------------------------------------------------------------------
// parseBodyFileArg
// ---------------------------------------------------------------------------

describe("parseBodyFileArg", () => {
  it("parses the pinned perl substitution", () => {
    assert.deepEqual(
      parseBodyFileArg(`<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/note.md)`),
      { kind: "substitution", path: "/vault/prs/note.md", quoted: false },
    );
  });

  it("parses a double-quoted program (quote-agnostic pin)", () => {
    assert.deepEqual(
      parseBodyFileArg(`<(perl -0777 -pe "${BODY_STRIP}" /vault/prs/note.md)`),
      { kind: "substitution", path: "/vault/prs/note.md", quoted: false },
    );
  });

  it("parses a quoted path with spaces inside the substitution", () => {
    assert.deepEqual(
      parseBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' "/vault/a b/note.md")`,
      ),
      { kind: "substitution", path: "/vault/a b/note.md", quoted: true },
    );
  });

  it("rejects a DIFFERENT program (byte-pinned)", () => {
    assert.equal(
      parseBodyFileArg(
        "<(perl -0777 -pe 's/^---\\n.*?\\n---\\n//s' /vault/prs/note.md)",
      ),
      null,
    );
  });

  it("rejects a different tool (sed)", () => {
    assert.equal(
      parseBodyFileArg("<(sed -e '1,/^---$/d' /vault/prs/note.md)"),
      null,
    );
  });

  it("rejects missing perl flags", () => {
    assert.equal(
      parseBodyFileArg(`<(perl -pe '${BODY_STRIP}' /vault/prs/note.md)`),
      null,
    );
  });

  it("rejects extra tokens after the path", () => {
    assert.equal(
      parseBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/note.md extra)`,
      ),
      null,
    );
  });

  it("rejects a missing path", () => {
    assert.equal(parseBodyFileArg(`<(perl -0777 -pe '${BODY_STRIP}')`), null);
  });

  it("rejects an unclosed substitution", () => {
    assert.equal(
      parseBodyFileArg(`<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/note.md`),
      null,
    );
  });

  it("classifies a plain path as direct", () => {
    assert.deepEqual(parseBodyFileArg("/vault/prs/note.md"), {
      kind: "direct",
      path: "/vault/prs/note.md",
      quoted: false,
    });
  });

  it("marks a quoted direct path quoted (resolves literally downstream)", () => {
    // The raw word still wears its quotes here — the direct arm
    // strips one level and remembers, so a quoted `"~/…"` never
    // expands onto the wrong file.
    assert.deepEqual(parseBodyFileArg('"~/Goldmine/note.md"'), {
      kind: "direct",
      path: "~/Goldmine/note.md",
      quoted: true,
    });
    assert.deepEqual(parseBodyFileArg("~/Goldmine/note.md"), {
      kind: "direct",
      path: "~/Goldmine/note.md",
      quoted: false,
    });
  });

  it("marks a tilde-quote-split direct path quoted", () => {
    // Inner quotes survive verbatim on the path but still suppress
    // expansion — resolution keeps the word literal (fail-closed).
    assert.deepEqual(parseBodyFileArg('~"/Goldmine/note.md'), {
      kind: "direct",
      path: '~"/Goldmine/note.md',
      quoted: true,
    });
  });

  it("unwraps an outer-quoted substitution to the same form", () => {
    assert.deepEqual(
      parseBodyFileArg(
        `"<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/note.md)"`,
      ),
      { kind: "substitution", path: "/vault/prs/note.md", quoted: false },
    );
  });

  it("keeps a `<`-prefixed path as the opaque path token (#48/#49)", () => {
    // The input-redirection typo: `<../…` inside the substitution is
    // just the fifth token — the form parses (`ok`), the vault check
    // fails it, and the #50 mirror shows the `<` verbatim.
    assert.deepEqual(
      parseBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' <../Goldmine/note.md)`,
      ),
      {
        kind: "substitution",
        path: "<../Goldmine/note.md",
        quoted: false,
      },
    );
  });

  it("keeps an absolute `<`-prefixed path as the opaque path token (#49)", () => {
    assert.deepEqual(
      parseBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' </abs/Goldmine/note.md)`,
      ),
      {
        kind: "substitution",
        path: "</abs/Goldmine/note.md",
        quoted: false,
      },
    );
  });

  it("marks a bare ~/ path unquoted (expands downstream)", () => {
    assert.deepEqual(
      parseBodyFileArg(`<(perl -0777 -pe '${BODY_STRIP}' ~/Goldmine/note.md)`),
      {
        kind: "substitution",
        path: "~/Goldmine/note.md",
        quoted: false,
      },
    );
  });

  it('marks a double-quoted "~/…" path quoted (never expands)', () => {
    // Bash-exact: quotes suppress tilde expansion — the resolver
    // keeps the literal path, which then fails the exists check.
    assert.deepEqual(
      parseBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' "~/Goldmine/note.md")`,
      ),
      {
        kind: "substitution",
        path: "~/Goldmine/note.md",
        quoted: true,
      },
    );
  });

  it("marks a single-quoted '~/…' path quoted (never expands)", () => {
    assert.deepEqual(
      parseBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' '~/Goldmine/note.md')`,
      ),
      {
        kind: "substitution",
        path: "~/Goldmine/note.md",
        quoted: true,
      },
    );
  });

  it("any quote at or before the ~/ prefix keeps the path literal", () => {
    // The shell expands only a lexically-leading unquoted `~/`:
    // `~"/x"` buries its slash in quotes, `""~/x` opens with
    // quotes, `"~"/x` quotes the tilde itself — all three stay
    // literal, verified against bash.
    for (const pathToken of [
      '~"/Goldmine/note.md',
      '""~/Goldmine/note.md',
      '"~"/Goldmine/note.md',
    ]) {
      assert.deepEqual(
        parseBodyFileArg(`<(perl -0777 -pe '${BODY_STRIP}' ${pathToken})`),
        {
          kind: "substitution",
          path: "~/Goldmine/note.md",
          quoted: true,
        },
      );
    }
  });

  it("a quote AFTER the first slash still expands", () => {
    // Quotes past the `~/` prefix do not suppress expansion:
    // `~/a"b` expands, the quotes only group the tail.
    assert.deepEqual(
      parseBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' ~/Goldmine/"note.md")`,
      ),
      {
        kind: "substitution",
        path: "~/Goldmine/note.md",
        quoted: false,
      },
    );
  });
});

// ---------------------------------------------------------------------------
// explainBodyFileArg (the 5-tag classify — no detail payloads)
// ---------------------------------------------------------------------------

describe("explainBodyFileArg", () => {
  it("empty value → missing", () => {
    assert.equal(explainBodyFileArg(""), "missing");
  });

  it("plain path → direct", () => {
    assert.equal(explainBodyFileArg("/vault/prs/note.md"), "direct");
  });

  it("unclosed <( form → form", () => {
    assert.equal(
      explainBodyFileArg(`<(perl -0777 -pe '${BODY_STRIP}'`),
      "form",
    );
  });

  it("pinned substitution → ok", () => {
    assert.equal(
      explainBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/note.md)`,
      ),
      "ok",
    );
  });

  it("incident byte-swap (`*)?` vs `?)*`) → diff", () => {
    const mutatedProgram = `${BODY_STRIP.slice(0, 129)}?)*${BODY_STRIP.slice(132)}`;
    assert.equal(mutatedProgram.length, BODY_STRIP.length);
    assert.equal(
      explainBodyFileArg(
        `<(perl -0777 -pe '${mutatedProgram}' /vault/prs/note.md)`,
      ),
      "diff",
    );
  });

  it("cat substitution (2 tokens) → diff", () => {
    assert.equal(explainBodyFileArg("<(cat /vault/prs/note.md)"), "diff");
  });

  it("`<`-prefixed path still classifies `ok` (vault check fails it, #48/#49)", () => {
    assert.equal(
      explainBodyFileArg(
        `<(perl -0777 -pe '${BODY_STRIP}' <../Goldmine/note.md)`,
      ),
      "ok",
    );
  });

  it("sed with the pinned program → diff (never ok — tool pin)", () => {
    assert.equal(
      explainBodyFileArg(`<(sed -0777 -pe '${BODY_STRIP}' /vault/prs/note.md)`),
      "diff",
    );
  });
});

// ---------------------------------------------------------------------------
// renderBodyFileDiff
// ---------------------------------------------------------------------------

describe("renderBodyFileDiff", () => {
  it("incident byte-swap at 129 → ONE byte pair with spans `*)?` / `?)*`", () => {
    // The pi#8845 incident: a 2-char swap at byte 129 of 135 that
    // the agent could not see with the static reason. The bounded
    // suffix trim (bound = min(len) - prefix = 6) stops before the
    // common `?)*`-diverging tail, so the pair survives.
    const mutatedProgram = `${BODY_STRIP.slice(0, 129)}?)*${BODY_STRIP.slice(132)}`;
    assert.equal(mutatedProgram.length, BODY_STRIP.length);
    assert.equal(
      renderBodyFileDiff(
        `<(perl -0777 -pe '${mutatedProgram}' /vault/prs/note.md)`,
      ),
      "substitution program diverges from the pinned strip at byte 129:\n" +
        "  - expected: *)?\n" +
        "  + got:      ?)*",
    );
  });

  it("overwrite at 129 → same offset, spans `*)?` / `XYZ`", () => {
    const mutatedProgram = `${BODY_STRIP.slice(0, 129)}XYZ${BODY_STRIP.slice(132)}`;
    assert.equal(mutatedProgram.length, BODY_STRIP.length);
    assert.equal(
      renderBodyFileDiff(
        `<(perl -0777 -pe '${mutatedProgram}' /vault/prs/note.md)`,
      ),
      "substitution program diverges from the pinned strip at byte 129:\n" +
        "  - expected: *)?\n" +
        "  + got:      XYZ",
    );
  });

  it("two tail edits → ONE byte pair at the first divergence (byte 124)", () => {
    // Bytes 123-127 `\r?\n` → `\n?\r` and bytes 129-131 `*)?` →
    // `?)*`: the first divergence is byte 124 (`r` → `n`; byte 123
    // is the shared `\`), the suffix trim folds the rest of the
    // reordered tail into the single pair.
    const got = `${BODY_STRIP.slice(0, 123)}\\n?\\r${BODY_STRIP.slice(128)}`;
    const got2 = `${got.slice(0, 129)}?)*${got.slice(132)}`;
    assert.equal(got2.length, BODY_STRIP.length);
    assert.equal(
      renderBodyFileDiff(`<(perl -0777 -pe '${got2}' /vault/prs/note.md)`),
      "substitution program diverges from the pinned strip at byte 124:\n" +
        "  - expected: r?\\n)*)?\n" +
        "  + got:      n?\\r)?)*",
    );
  });

  it("cat → the two full lines (PATH placeholder has no angle brackets, #50)", () => {
    assert.equal(
      renderBodyFileDiff("<(cat /vault/prs/note.md)"),
      "substitution inner command deviates from the pinned strip:\n" +
        `  - expected: perl -0777 -pe '${BODY_STRIP}' PATH\n` +
        "  + got:      cat /vault/prs/note.md",
    );
  });

  it("far-apart edits (bytes 5 + 130, ~93% diverging) → full lines", () => {
    const farApart = `${BODY_STRIP.slice(0, 5)}Z${BODY_STRIP.slice(6)}`;
    const farApart2 = `${farApart.slice(0, 130)}Q${farApart.slice(131)}`;
    assert.equal(farApart2.length, BODY_STRIP.length);
    assert.equal(
      renderBodyFileDiff(`<(perl -0777 -pe '${farApart2}' /vault/prs/note.md)`),
      "substitution inner command deviates from the pinned strip:\n" +
        `  - expected: perl -0777 -pe '${BODY_STRIP}' PATH\n` +
        `  + got:      perl -0777 -pe '${farApart2}' /vault/prs/note.md`,
    );
  });

  it("sed with the pinned program → full lines (never a byte pair)", () => {
    // The sed substitution's program token IS the pinned strip —
    // the core pair is empty; the tool pin is what fails, so the
    // full lines show the sed shape.
    assert.equal(
      renderBodyFileDiff(`<(sed -0777 -pe '${BODY_STRIP}' /vault/prs/note.md)`),
      "substitution inner command deviates from the pinned strip:\n" +
        `  - expected: perl -0777 -pe '${BODY_STRIP}' PATH\n` +
        `  + got:      sed -0777 -pe '${BODY_STRIP}' /vault/prs/note.md`,
    );
  });

  it("exactly-60% span (81/135) stays a byte pair (strict >)", () => {
    // Differing span = exactly 0.6 * 135 = 81 chars (prefix 27,
    // suffix 27) — 81 > 81 is false on both sides, so no fallback.
    const gotProgram =
      BODY_STRIP.slice(0, 27) + "x".repeat(81) + BODY_STRIP.slice(108);
    assert.equal(gotProgram.length, BODY_STRIP.length);
    assert.equal(
      renderBodyFileDiff(
        `<(perl -0777 -pe '${gotProgram}' /vault/prs/note.md)`,
      ),
      `substitution program diverges from the pinned strip at byte 27:\n` +
        `  - expected: ${BODY_STRIP.slice(27, 108)}\n` +
        `  + got:      ${"x".repeat(81)}`,
    );
  });

  it("82/135 span (just over the ratio) → full lines", () => {
    const gotProgram =
      BODY_STRIP.slice(0, 26) + "x".repeat(82) + BODY_STRIP.slice(108);
    assert.equal(gotProgram.length, BODY_STRIP.length);
    assert.equal(
      renderBodyFileDiff(
        `<(perl -0777 -pe '${gotProgram}' /vault/prs/note.md)`,
      ),
      "substitution inner command deviates from the pinned strip:\n" +
        `  - expected: perl -0777 -pe '${BODY_STRIP}' PATH\n` +
        `  + got:      perl -0777 -pe '${gotProgram}' /vault/prs/note.md`,
    );
  });
});

// ---------------------------------------------------------------------------
// countSubstitutionTokens
// ---------------------------------------------------------------------------

describe("countSubstitutionTokens", () => {
  it("counts 5 for the pinned substitution", () => {
    assert.equal(EXPECTED_SUBSTITUTION_TOKENS, 5);
    assert.equal(
      countSubstitutionTokens(
        `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/note.md)`,
      ),
      5,
    );
  });

  it("counts 4 for the pathless shape (swallowed redirect)", () => {
    assert.equal(
      countSubstitutionTokens(`<(perl -0777 -pe '${BODY_STRIP}')`),
      4,
    );
  });

  it("counts the unclosed `<(` word too (form stage)", () => {
    assert.equal(
      countSubstitutionTokens(`<(perl -0777 -pe '${BODY_STRIP}'`),
      4,
    );
  });

  it("returns null for a non-substitution word", () => {
    assert.equal(countSubstitutionTokens("/vault/prs/note.md"), null);
    assert.equal(countSubstitutionTokens(""), null);
  });
});

// ---------------------------------------------------------------------------
// resolveAgainstCwd
// ---------------------------------------------------------------------------

describe("resolveAgainstCwd", () => {
  it("resolves a relative path against the cwd", () => {
    const ctx = makeCtx([], "/work/repo");
    assert.equal(
      resolveAgainstCwd(ctx, "notes/body.md"),
      "/work/repo/notes/body.md",
    );
  });

  it("passes absolute paths through unchanged", () => {
    const ctx = makeCtx([], "/work/repo");
    assert.equal(
      resolveAgainstCwd(ctx, "/vault/prs/body.md"),
      "/vault/prs/body.md",
    );
  });

  it("returns null for a walker-unknown cwd (fail-closed)", () => {
    const ctx = makeCtx([], "unknown");
    assert.equal(resolveAgainstCwd(ctx, "notes/body.md"), null);
  });

  it("expands a leading ~/ against the tracked HOME", () => {
    const ctx = makeCtx(
      [],
      "/work/repo",
      undefined,
      new Map([["HOME", "/home/u"]]),
    );
    assert.equal(
      resolveAgainstCwd(ctx, "~/Goldmine/note.md"),
      "/home/u/Goldmine/note.md",
    );
  });

  it("a HOME= override in the tracked env wins over process.env", () => {
    // The tracked env is authoritative: the override applies even
    // when the process env carries a different HOME.
    const saved = process.env.HOME;
    process.env.HOME = "/process/home";
    try {
      const ctx = makeCtx(
        [],
        "/work/repo",
        undefined,
        new Map([["HOME", "/override/home"]]),
      );
      assert.equal(
        resolveAgainstCwd(ctx, "~/Goldmine/note.md"),
        "/override/home/Goldmine/note.md",
      );
    } finally {
      process.env.HOME = saved;
    }
  });

  it("falls back to process.env HOME when the walker env is absent", () => {
    const saved = process.env.HOME;
    process.env.HOME = "/process/home";
    try {
      const ctx = makeCtx([], "/work/repo");
      assert.equal(
        resolveAgainstCwd(ctx, "~/Goldmine/note.md"),
        "/process/home/Goldmine/note.md",
      );
    } finally {
      process.env.HOME = saved;
    }
  });

  it("returns null for ~/… when HOME is unknown (fail-closed)", () => {
    // Tracked env present but HOME-less: authoritative, no process
    // fallback — the vault predicate renders the explicit trace.
    const ctx = makeCtx([], "/work/repo", undefined, new Map());
    assert.equal(resolveAgainstCwd(ctx, "~/Goldmine/note.md"), null);
  });

  it("still resolves non-tilde paths when HOME is unknown", () => {
    // HOME only matters for a leading `~` — everything else is
    // unaffected by a missing HOME.
    const ctx = makeCtx([], "/work/repo", undefined, new Map());
    assert.equal(
      resolveAgainstCwd(ctx, "notes/body.md"),
      "/work/repo/notes/body.md",
    );
    assert.equal(
      resolveAgainstCwd(ctx, "/vault/prs/body.md"),
      "/vault/prs/body.md",
    );
  });

  it("leaves a quoted path literal (quotes suppress expansion)", () => {
    // `"~/x"` never expands in the shell: the quotes are already
    // stripped by the tokenizer, the flag remembers.
    const ctx = makeCtx(
      [],
      "/work/repo",
      undefined,
      new Map([["HOME", "/home/u"]]),
    );
    assert.equal(
      resolveAgainstCwd(ctx, "~/Goldmine/note.md", true),
      "/work/repo/~/Goldmine/note.md",
    );
  });

  it("passes ~user/… through unchanged (documented upstream limit)", () => {
    // The core helper returns `~user/…` as-is — resolution treats
    // it as a relative path, exactly as before this change.
    const ctx = makeCtx(
      [],
      "/work/repo",
      undefined,
      new Map([["HOME", "/home/u"]]),
    );
    assert.equal(
      resolveAgainstCwd(ctx, "~other/Goldmine/note.md"),
      "/work/repo/~other/Goldmine/note.md",
    );
  });
});
