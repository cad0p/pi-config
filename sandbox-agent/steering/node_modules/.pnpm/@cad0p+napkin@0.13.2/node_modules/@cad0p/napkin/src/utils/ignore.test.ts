import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";
import { ignoreFingerprint, loadIgnorer } from "./ignore.js";
import { createTempVault } from "./test-helpers.js";

let vault: { path: string; vaultPath: string; cleanup: () => void };

function setConfigIgnore(
  vaultPath: string,
  ignore: { respectGitignore?: boolean; dotfiles?: boolean },
): void {
  const config = loadConfig(vaultPath);
  const updated = { ...config, ignore: { ...config.ignore, ...ignore } };
  fs.writeFileSync(
    path.join(vaultPath, "config.json"),
    JSON.stringify(updated),
  );
}

beforeEach(() => {
  vault = createTempVault({
    "a.md": "# A",
    "b.md": "# B",
    "keep.md": "# Keep",
    "dir/c.md": "# C",
    "dir/foo.md": "# Foo",
    "build/x.md": "# X",
    "build/keep.md": "# Build keep",
  });
});

afterEach(() => {
  vault.cleanup();
});

describe("loadIgnorer — .napkinignore pattern semantics", () => {
  test("unanchored pattern matches at any depth", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "foo.md\n");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("foo.md")).toBe(true);
    expect(ignorer.ignores("dir/foo.md")).toBe(true);
    expect(ignorer.ignores("a.md")).toBe(false);
  });

  test("anchored pattern (leading slash) matches only the vault root", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "/a.md\n");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("a.md")).toBe(true);
    expect(ignorer.ignores("dir/a.md")).toBe(false);
  });

  test("trailing-slash pattern matches the dir and its contents (pruning)", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "build/\n");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    // Dirs are tested with a trailing slash by the walker wrappers.
    expect(ignorer.ignores("build/")).toBe(true);
    expect(ignorer.ignores("build/x.md")).toBe(true);
    expect(ignorer.ignores("dir/")).toBe(false);
  });

  test("double-star pattern matches nested paths", () => {
    fs.writeFileSync(
      path.join(vault.vaultPath, ".napkinignore"),
      "**/foo.md\n",
    );
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("dir/foo.md")).toBe(true);
  });

  test("negation works within the same file", () => {
    fs.writeFileSync(
      path.join(vault.vaultPath, ".napkinignore"),
      "*.md\n!keep.md\n",
    );
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("a.md")).toBe(true);
    expect(ignorer.ignores("keep.md")).toBe(false);
  });

  test("dir negation: build/* with !build/keep.md keeps only keep.md", () => {
    fs.writeFileSync(
      path.join(vault.vaultPath, ".napkinignore"),
      "build/*\n!build/keep.md\n",
    );
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    // Within-source negation: the dir pattern ignores everything under
    // build/, the negation re-includes keep.md (checked after the ignore
    // list, so it wins over the earlier pattern).
    expect(ignorer.ignores("build/x.md")).toBe(true);
    expect(ignorer.ignores("build/sub/deep.md")).toBe(true);
    expect(ignorer.ignores("build/keep.md")).toBe(false);
  });

  test("empty .napkinignore is a no-op", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("a.md")).toBe(false);
  });

  test("absent .napkinignore ignores nothing", () => {
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("a.md")).toBe(false);
  });
});

describe("loadIgnorer — .gitignore + union semantics", () => {
  test(".gitignore honored by default (respectGitignore default true)", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\n");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("b.md")).toBe(true);
    expect(ignorer.ignores("a.md")).toBe(false);
  });

  test(".gitignore ignored when respectGitignore is false", () => {
    setConfigIgnore(vault.vaultPath, { respectGitignore: false });
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\n");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("b.md")).toBe(false);
  });

  test("union: a path is ignored when EITHER source matches", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "a.md\n");
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\n");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("a.md")).toBe(true);
    expect(ignorer.ignores("b.md")).toBe(true);
    expect(ignorer.ignores("c.md")).toBe(false);
  });

  test("cross-source negation is NOT supported (.gitignore cannot un-ignore .napkinignore)", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "*.md\n");
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "!keep.md\n");
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores("keep.md")).toBe(true);
  });
});

describe("loadIgnorer — dotfiles rule", () => {
  test("dotfiles and dotdirs ignored by default (dotfiles default true)", () => {
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores(".hidden.md")).toBe(true);
    expect(ignorer.ignores(".hidden-dir/")).toBe(true);
    expect(ignorer.ignores("dir/.hidden.md")).toBe(true);
    expect(ignorer.ignores("a.md")).toBe(false);
  });

  test("dotfiles surfaced when dotfiles is false", () => {
    setConfigIgnore(vault.vaultPath, { dotfiles: false });
    const { ignorer } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(ignorer.ignores(".hidden.md")).toBe(false);
    expect(ignorer.ignores(".hidden-dir/")).toBe(false);
  });
});

describe("ignoreFingerprint", () => {
  test("stable across calls with no changes", () => {
    const fp1 = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    const fp2 = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(fp1).toBe(fp2);
  });

  test("changes when .napkinignore is added", () => {
    const before = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "a.md\n");
    const after = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(after).not.toBe(before);
  });

  test("changes when .napkinignore is edited", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "a.md\n");
    const before = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    // Different length so the size component of the fingerprint changes
    // deterministically (mtime may not advance within the same tick).
    fs.writeFileSync(
      path.join(vault.vaultPath, ".napkinignore"),
      "a.md\nb.md\n",
    );
    const after = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(after).not.toBe(before);
  });

  test("changes when .napkinignore is deleted", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "a.md\n");
    const before = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    fs.unlinkSync(path.join(vault.vaultPath, ".napkinignore"));
    const after = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(after).not.toBe(before);
  });

  test("changes when ignore config values change", () => {
    const before = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    setConfigIgnore(vault.vaultPath, { dotfiles: false });
    const after = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(after).not.toBe(before);
  });

  test("changes when .gitignore is edited (when respected)", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\n");
    const before = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    // Rewriting with different content (different size) changes the fingerprint.
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\nc.md\n");
    const after = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(after).not.toBe(before);
  });

  test("unchanged when .gitignore is edited while respectGitignore is false", () => {
    setConfigIgnore(vault.vaultPath, { respectGitignore: false });
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\n");
    const before = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    // The un-respected .gitignore must not be part of the ignore state, so
    // editing it cannot invalidate the search cache or rebuild the ignorer.
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\nc.md\n");
    const after = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(after).toBe(before);
  });

  test("changes when respectGitignore is toggled (config change → new state)", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".gitignore"), "b.md\n");
    const before = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    setConfigIgnore(vault.vaultPath, { respectGitignore: false });
    const after = ignoreFingerprint(vault.vaultPath, vault.vaultPath);
    expect(after).not.toBe(before);
    // And toggling back restores the original fingerprint (nothing else moved).
    setConfigIgnore(vault.vaultPath, { respectGitignore: true });
    expect(ignoreFingerprint(vault.vaultPath, vault.vaultPath)).toBe(before);
  });
});

describe("loadIgnorer memoization", () => {
  test("returns the same instance while the fingerprint is unchanged", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "a.md\n");
    const { ignorer: i1 } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    const { ignorer: i2 } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(i1).toBe(i2);
  });

  test("returns the same fingerprint as ignoreFingerprint", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "a.md\n");
    const { fingerprint } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(fingerprint).toBe(
      ignoreFingerprint(vault.vaultPath, vault.vaultPath),
    );
  });

  test("rebuilds after an ignore-state change", () => {
    fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "a.md\n");
    const { ignorer: i1 } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    // Different length so the fingerprint changes deterministically.
    fs.writeFileSync(
      path.join(vault.vaultPath, ".napkinignore"),
      "b.md\nc.md\n",
    );
    const { ignorer: i2 } = loadIgnorer(vault.vaultPath, vault.vaultPath);
    expect(i1).not.toBe(i2);
    expect(i1.ignores("a.md")).toBe(true);
    expect(i2.ignores("a.md")).toBe(false);
    expect(i2.ignores("b.md")).toBe(true);
  });
});
