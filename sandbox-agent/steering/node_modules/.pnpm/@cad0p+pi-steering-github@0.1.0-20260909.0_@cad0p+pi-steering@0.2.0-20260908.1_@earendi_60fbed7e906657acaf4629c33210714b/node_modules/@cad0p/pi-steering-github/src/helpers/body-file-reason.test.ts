// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Unit tests for the mirror + trace + slotted-recipe renderer
 * (`renderDiagnosedReason` and friends, #50). The renderer is pure
 * over the shared `BodyFileDiagnosis` struct — these tests hand-build
 * the struct (the struct computation itself is pinned by
 * `missing-vault-body-file.test.ts`), plus byte-identity pins on the
 * static recipe both sections share with the rules' `diff` branch.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BodyFileDiagnosis } from "../predicates/missing-vault-body-file.ts";
import {
  renderDegradedReason,
  renderDiagnosedReason,
  renderSlottedRecipe,
  renderStaticRecipe,
} from "./body-file-reason.ts";
import { BODY_STRIP } from "./body-strip.ts";

function base(over: Partial<BodyFileDiagnosis>): BodyFileDiagnosis {
  return {
    tag: "ok",
    received: "",
    path: null,
    cwd: null,
    abs: null,
    exists: null,
    vaultRoot: null,
    repo: null,
    blocked: true,
    ...over,
  };
}

describe("renderStaticRecipe", () => {
  it("prs static recipe (byte-identity — shared with the diff branch)", () => {
    assert.equal(
      renderStaticRecipe("prs"),
      "PR bodies must come from a body file in the napkin vault:\n" +
        '  gh pr create --title "..." --body-file ' +
        `<(perl -0777 -pe '${BODY_STRIP}' ` +
        "VAULT/**/REPO/prs/YYYY-MM-DD-pr<N>-<slug>.md)",
    );
  });

  it("issues static recipe (byte-identity — shared with the diff branch)", () => {
    assert.equal(
      renderStaticRecipe("issues"),
      "Issue bodies must come from a body file in the napkin vault:\n" +
        '  gh issue create --title "..." --body-file ' +
        `<(perl -0777 -pe '${BODY_STRIP}' ` +
        "VAULT/**/REPO/issues/YYYY-MM-DD-issue<N>-<slug>.md)\n" +
        "- If foreign issue: cd to the repo you want to file the issue; " +
        "REQUIREMENT: have a foreign subagent maintainer loop before filing",
    );
  });
});

describe("renderSlottedRecipe", () => {
  it("fills both slots when discovered", () => {
    const recipe = renderSlottedRecipe(
      "/Users/u/Goldmine",
      "fixture-repo",
      "prs",
    );
    assert.ok(
      recipe.includes(
        "/Users/u/Goldmine/**/fixture-repo/prs/YYYY-MM-DD-pr<N>-<slug>.md)",
      ),
      `recipe: ${recipe}`,
    );
  });

  it("fills vault only when the repo is undiscovered", () => {
    const recipe = renderSlottedRecipe("/Users/u/Goldmine", null, "issues");
    assert.ok(
      recipe.includes("/Users/u/Goldmine/**/REPO/issues/"),
      `recipe: ${recipe}`,
    );
  });
});

describe("renderDiagnosedReason", () => {
  it("missing stage → recipe only (as before)", () => {
    assert.equal(
      renderDiagnosedReason(base({ tag: "missing" }), "prs"),
      renderStaticRecipe("prs"),
    );
    assert.equal(
      renderDiagnosedReason(base({ tag: "missing" }), "issues"),
      renderStaticRecipe("issues"),
    );
  });

  it("#48 shape: the mirror exposes the `<`, trace stops at exists (byte pin)", () => {
    const cwd = "/Users/u/personal/github/pcad.it-infra";
    const path =
      "<../Goldmine/personal/github/pcad.it-infra/issues/2026-09-01-issue188-test.md";
    const d = base({
      tag: "ok",
      received: `<(perl -0777 -pe '${BODY_STRIP}' ${path})`,
      path,
      cwd,
      abs: `${cwd}/${path}`,
      exists: false,
    });
    assert.equal(
      renderDiagnosedReason(d, "issues"),
      `--body-file path as received: ${path}\n` +
        `resolved against cwd ${cwd}: ${cwd}/${path}\n` +
        "exists: no\n" +
        "\n" +
        renderStaticRecipe("issues"),
    );
  });

  it("stops at the first failure: unknown cwd never prints exists/vault lines", () => {
    const d = base({
      tag: "ok",
      received: `<(perl -0777 -pe '${BODY_STRIP}' /vault/prs/note.md)`,
      path: "/vault/prs/note.md",
    });
    const reason = renderDiagnosedReason(d, "prs");
    const lines = reason.split("\n");
    assert.equal(lines[0], "--body-file path as received: /vault/prs/note.md");
    assert.equal(lines[1], "resolved against cwd: unknown — fail-closed");
    assert.ok(!reason.includes("exists:"), `reason: ${reason}`);
    assert.ok(!reason.includes("vault root"), `reason: ${reason}`);
    assert.ok(!reason.includes("vault: none"), `reason: ${reason}`);
  });

  it("HOME unknown: explicit expansion line, never exists/vault lines", () => {
    // Known cwd + null abs (tilde expansion failed): the trace
    // names the expansion failure instead of the unknown-cwd line.
    const path = "~/Goldmine/open-source/github/fixture-repo/prs/note.md";
    const d = base({
      tag: "ok",
      received: `<(perl -0777 -pe '${BODY_STRIP}' ${path})`,
      path,
      cwd: "/work/fixture-repo",
      abs: null,
    });
    const reason = renderDiagnosedReason(d, "prs");
    const lines = reason.split("\n");
    assert.equal(lines[0], `--body-file path as received: ${path}`);
    assert.equal(lines[1], "tilde expansion: HOME unknown — fail-closed");
    assert.ok(!reason.includes("exists:"), `reason: ${reason}`);
    assert.ok(!reason.includes("vault root"), `reason: ${reason}`);
  });

  it("outside-vault shape: stops after exists, vault slot stays bare", () => {
    const d = base({
      tag: "ok",
      received: `<(perl -0777 -pe '${BODY_STRIP}' /tmp/body.md)`,
      path: "/tmp/body.md",
      cwd: "/work/repo",
      abs: "/tmp/body.md",
      exists: true,
    });
    const reason = renderDiagnosedReason(d, "prs");
    assert.ok(reason.includes("exists: yes"), `reason: ${reason}`);
    assert.ok(
      reason.includes("vault: none — not inside a napkin vault, fail-closed"),
      `reason: ${reason}`,
    );
    assert.ok(!reason.includes("repo (command cwd)"), `reason: ${reason}`);
    assert.ok(reason.includes("VAULT/**/REPO/prs/"), `reason: ${reason}`);
  });

  it("misplaced shape: full trace with filled slots + placement line", () => {
    const vault = "/Users/u/Goldmine";
    const abs = `${vault}/open-source/github/other-repo/prs/note.md`;
    const d = base({
      tag: "ok",
      received: `<(perl -0777 -pe '${BODY_STRIP}' ${abs})`,
      path: abs,
      cwd: "/work/fixture-repo",
      abs,
      exists: true,
      vaultRoot: vault,
      repo: "fixture-repo",
    });
    const reason = renderDiagnosedReason(d, "prs");
    assert.ok(reason.includes("exists: yes"), `reason: ${reason}`);
    assert.ok(reason.includes(`vault root: ${vault}`), `reason: ${reason}`);
    assert.ok(
      reason.includes("repo (command cwd): fixture-repo"),
      `reason: ${reason}`,
    );
    assert.ok(
      reason.includes(
        "placement: open-source/github/other-repo/prs/note.md is not under fixture-repo/prs/ — fail-closed",
      ),
      `reason: ${reason}`,
    );
    assert.ok(
      reason.includes(`${vault}/**/fixture-repo/prs/`),
      `reason: ${reason}`,
    );
  });

  it("direct arm: verbatim mirror + verbatim-upload note + recipe", () => {
    const d = base({
      tag: "direct",
      received: "body.md",
      path: "body.md",
    });
    assert.equal(
      renderDiagnosedReason(d, "prs"),
      "--body-file path as received: body.md\n" +
        "direct paths upload verbatim (frontmatter renders on GitHub) — only the pinned substitution is accepted\n" +
        "\n" +
        renderStaticRecipe("prs"),
    );
  });

  it("form arm: value mirror + token-count structure line + recipe", () => {
    const received = `<(perl -0777 -pe '${BODY_STRIP}')`;
    const d = base({ tag: "form", received });
    const reason = renderDiagnosedReason(d, "prs");
    assert.ok(
      reason.includes(
        `value as received: ${received} — 4 tokens inside <(…), expected 5 (perl -0777 -pe PROGRAM PATH)`,
      ),
      `reason: ${reason}`,
    );
  });

  it("form arm with an unclosed substitution: counts the partial word", () => {
    const received = `<(perl -0777 -pe '${BODY_STRIP}'`;
    const d = base({ tag: "form", received });
    const reason = renderDiagnosedReason(d, "issues");
    assert.ok(
      reason.includes(
        `value as received: ${received} — 4 tokens inside <(…), expected 5 (perl -0777 -pe PROGRAM PATH)`,
      ),
      `reason: ${reason}`,
    );
  });

  it("diff tag reaching the renderer falls back to value + token count", () => {
    // The rules route `diff` to the #43 byte-diff diagnostic, so this
    // arm is defensive — pinned here to document the generic fallback.
    const received = `<(perl -0777 -pe '${BODY_STRIP}')`;
    const d = base({ tag: "diff", received });
    const reason = renderDiagnosedReason(d, "prs");
    assert.ok(
      reason.includes(
        `value as received: ${received} — 4 tokens inside <(…), expected 5 (perl -0777 -pe PROGRAM PATH)`,
      ),
      `reason: ${reason}`,
    );
  });

  it("authored text carries no angle-bracket placeholders", () => {
    // Mirrored user data may contain `<` (that IS the typo signal) —
    // so this sweep uses `<`-free fixture data and asserts the
    // renderer's own placeholders are gone.
    const d = base({
      tag: "ok",
      received: `<(perl -0777 -pe '${BODY_STRIP}' /tmp/body.md)`,
      path: "/tmp/body.md",
      cwd: "/work/repo",
      abs: "/tmp/body.md",
      exists: true,
    });
    for (const section of ["prs", "issues"] as const) {
      const reason = renderDiagnosedReason(d, section);
      for (const placeholder of ["<vault>", "<repo>", "<path>"]) {
        assert.ok(
          !reason.includes(placeholder),
          `${placeholder} leaked into the ${section} reason: ${reason}`,
        );
      }
    }
    assert.ok(!renderStaticRecipe("prs").includes("<vault>"));
    assert.ok(!renderStaticRecipe("prs").includes("<repo>"));
  });
});

describe("renderDegradedReason", () => {
  it("mirrors the surviving value word plus the static recipe", () => {
    const reason = renderDegradedReason("body.md", "prs");
    assert.ok(
      reason.startsWith("--body-file value as received: body.md\n"),
      `reason: ${reason}`,
    );
    assert.ok(
      reason.includes("PR bodies must come from a body file"),
      `reason: ${reason}`,
    );
  });

  it("empty value → static recipe only", () => {
    assert.equal(
      renderDegradedReason("", "issues"),
      renderStaticRecipe("issues"),
    );
  });
});
