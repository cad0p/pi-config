import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import { searchVault } from "./search.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  v = createTempVault({
    "Projects/alpha.md": "# Alpha\nalpha-project-marker\n",
    "Projects/beta.md": "# Beta\nbeta-project-marker\n",
    "Resources/guide.md": "# Guide\nRefer to the [[alpha]] project",
  });
});

afterEach(() => {
  v.cleanup();
});

describe("searchVault ignore support", () => {
  test("ignored files are absent from results", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );

    const results = searchVault(
      v.vaultPath,
      v.vaultPath,
      "beta-project-marker",
    );
    expect(results.map((r) => r.file)).not.toContain("Projects/beta.md");

    const alphaResults = searchVault(
      v.vaultPath,
      v.vaultPath,
      "alpha-project-marker",
    );
    expect(alphaResults.map((r) => r.file)).toContain("Projects/alpha.md");
  });

  test("fingerprint mismatch triggers a cold rebuild when .napkinignore is added", () => {
    // Search once — builds and persists the index with no ignore state.
    const before = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(before.map((r) => r.file)).toContain("Projects/beta.md");

    // Add an ignore file, then search again. The stored cache has a
    // different ignoreFingerprint, so the index is rebuilt and the
    // ignored file disappears without any manual invalidation.
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const after = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(after.map((r) => r.file)).not.toContain("Projects/beta.md");
    // A non-ignored file still matches.
    const alpha = searchVault(v.vaultPath, v.vaultPath, "alpha-project-marker");
    expect(alpha.map((r) => r.file)).toContain("Projects/alpha.md");
  });

  test("fingerprint mismatch triggers a cold rebuild when .napkinignore is deleted", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const before = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(before.map((r) => r.file)).not.toContain("Projects/beta.md");

    fs.unlinkSync(path.join(v.vaultPath, ".napkinignore"));
    const after = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(after.map((r) => r.file)).toContain("Projects/beta.md");
  });

  test("ignore.dotfiles: false restores dotfiles to the index", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".hidden.md"),
      "# Hidden\nhidden-dotfile-marker\n",
    );
    // Default dotfiles: true — dotfiles are not indexed.
    const hidden = searchVault(
      v.vaultPath,
      v.vaultPath,
      "hidden-dotfile-marker",
    );
    expect(hidden.map((r) => r.file)).not.toContain(".hidden.md");

    const configPath = path.join(v.vaultPath, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.ignore = { ...config.ignore, dotfiles: false };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const visible = searchVault(
      v.vaultPath,
      v.vaultPath,
      "hidden-dotfile-marker",
    );
    expect(visible.map((r) => r.file)).toContain(".hidden.md");
  });

  test("backlinks do not count ignored files as sources or targets", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Resources/guide.md\n",
    );
    // guide.md links to [[alpha]]; with guide ignored, alpha's backlink
    // count must not include it.
    const results = searchVault(v.vaultPath, v.vaultPath, "alpha");
    const alpha = results.find((r) => r.file === "Projects/alpha.md");
    expect(alpha).toBeDefined();
    expect(alpha?.links).toBe(0);
  });
});
