import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getFileInfo,
  listFiles,
  listFolders,
  parseFileRef,
  readFile,
  resolveFile,
  suggestFile,
} from "./files.js";
import { loadIgnorer } from "./ignore.js";
import { createTempVault } from "./test-helpers.js";

let vault: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  vault = createTempVault({
    "README.md": "# My Vault\nWelcome to the vault.",
    "Projects/Active Projects.md":
      "# Active Projects\n- Project A\n- Project B",
    "Projects/K Logic/Meeting.md": "# Meeting Notes\nSome notes here.",
    "Resources/Runbooks/Deploy.md": "# Deploy\nStep 1\nStep 2",
    "Inbox/Daily/2026-02-24.md":
      "# Daily\n- [ ] Buy groceries\n- [x] Ship feature",
    "Templates/Daily Note.md": "# {{date}}\n\n## Tasks\n- [ ] ",
    "Templates/Meeting Note.md": "# Meeting: {{title}}\n\n## Notes\n",
    "image.png": "fake-png-data",
  });
});

afterEach(() => {
  vault.cleanup();
});

describe("listFiles", () => {
  test("lists all files", () => {
    const files = listFiles(vault.vaultPath);
    expect(files.length).toBe(8);
    // Should not include .obsidian files
    for (const f of files) {
      expect(f).not.toMatch(/^\.obsidian\//);
    }
  });

  test("filters by extension", () => {
    const files = listFiles(vault.vaultPath, { ext: "md" });
    expect(files.length).toBe(7);
    for (const f of files) {
      expect(f.endsWith(".md")).toBe(true);
    }
  });

  test("filters by folder", () => {
    const files = listFiles(vault.vaultPath, { folder: "Projects" });
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(f).toMatch(/^Projects\//);
    }
  });

  test("returns empty for nonexistent folder", () => {
    const files = listFiles(vault.vaultPath, { folder: "Nope" });
    expect(files).toEqual([]);
  });
});

describe("listFolders", () => {
  test("lists folders", () => {
    const folders = listFolders(vault.vaultPath);
    expect(folders).toContain("Projects");
    expect(folders).toContain("Resources");
    expect(folders).toContain("Templates");
  });

  test("filters by parent folder", () => {
    const folders = listFolders(vault.vaultPath, "Resources");
    expect(folders).toEqual(["Resources/Runbooks"]);
  });
});

describe("parseFileRef", () => {
  test("parses plain file", () => {
    expect(parseFileRef("file")).toEqual({ path: "file" });
  });

  test("parses wikilink without heading", () => {
    expect(parseFileRef("[[file]]")).toEqual({ path: "file" });
  });

  test("parses wikilink with heading", () => {
    expect(parseFileRef("[[file#Heading]]")).toEqual({
      path: "file",
      heading: "Heading",
    });
  });

  test("parses wikilink with heading and alias", () => {
    expect(parseFileRef("[[file#Heading|alias]]")).toEqual({
      path: "file",
      heading: "Heading",
    });
  });

  test("parses wikilink with spaces and heading", () => {
    expect(parseFileRef("[[file with spaces#Heading]]")).toEqual({
      path: "file with spaces",
      heading: "Heading",
    });
  });

  test("parses wikilink with multiple hashes in heading", () => {
    expect(parseFileRef("[[file#Heading#Subheading]]")).toEqual({
      path: "file#Heading",
      heading: "Subheading",
    });
  });

  test("parses no-brackets file#heading reference", () => {
    expect(parseFileRef("cr-auto-action#Watchdog Recovery")).toEqual({
      path: "cr-auto-action",
      heading: "Watchdog Recovery",
    });
  });
});

describe("resolveFile", () => {
  test("resolves by exact path", () => {
    const result = resolveFile(vault.vaultPath, "README.md");
    expect(result).toEqual({ path: "README.md" });
  });

  test("resolves by wikilink name", () => {
    const result = resolveFile(vault.vaultPath, "Active Projects");
    expect(result).toEqual({ path: "Projects/Active Projects.md" });
  });

  test("resolves case-insensitively", () => {
    const result = resolveFile(vault.vaultPath, "active projects");
    expect(result).toEqual({ path: "Projects/Active Projects.md" });
  });

  test("returns null for missing file", () => {
    const result = resolveFile(vault.vaultPath, "nonexistent-file");
    expect(result).toBeNull();
  });

  test("resolves wikilink with heading", () => {
    const result = resolveFile(vault.vaultPath, "[[Active Projects#Heading]]");
    expect(result).toEqual({
      path: "Projects/Active Projects.md",
      heading: "Heading",
    });
  });
});

describe("readFile", () => {
  test("reads file by wikilink name", () => {
    const { path, content } = readFile(vault.vaultPath, "README");
    expect(path).toBe("README.md");
    expect(content).toContain("My Vault");
  });

  test("reads file by exact path", () => {
    const { content } = readFile(
      vault.vaultPath,
      "Projects/Active Projects.md",
    );
    expect(content).toContain("Project A");
  });

  test("throws for missing file", () => {
    expect(() => readFile(vault.vaultPath, "nonexistent")).toThrow(
      "File not found",
    );
  });
});

describe("sibling layout", () => {
  let siblingVault: { path: string; cleanup: () => void };

  beforeEach(() => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-sibling-files-"),
    );
    // Content at root level
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note");
    fs.mkdirSync(path.join(tmpDir, "folder"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "folder", "deep.md"), "# Deep");
    // .napkin/ and .obsidian/ as siblings
    fs.mkdirSync(path.join(tmpDir, ".napkin"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".napkin", "config.json"), "{}");
    siblingVault = {
      path: tmpDir,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  });

  afterEach(() => {
    siblingVault.cleanup();
  });

  test("listFiles skips .napkin/ when content root is parent", () => {
    const files = listFiles(siblingVault.path);
    expect(files).toContain("note.md");
    expect(files).toContain("folder/deep.md");
    // Should NOT include .napkin/ contents
    for (const f of files) {
      expect(f).not.toMatch(/^\.napkin\//);
    }
  });

  test("listFolders skips .napkin/ when content root is parent", () => {
    const folders = listFolders(siblingVault.path);
    expect(folders).toContain("folder");
    expect(folders).not.toContain(".napkin");
  });
});

describe("getFileInfo", () => {
  test("returns file info", () => {
    const info = getFileInfo(vault.vaultPath, "README.md");
    expect(info.name).toBe("README");
    expect(info.extension).toBe("md");
    expect(info.size).toBeGreaterThan(0);
    expect(info.created).toBeGreaterThan(0);
    expect(info.modified).toBeGreaterThan(0);
  });
});

describe("symlink following", () => {
  let tmpRoot: string;
  let linkedVault: { path: string; vaultPath: string; cleanup: () => void };

  beforeEach(() => {
    // External directory outside the vault that we'll symlink into it.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-symlink-src-"));
    fs.mkdirSync(path.join(tmpRoot, "subdir"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "top-level.md"),
      "# Top-level\nLinked file content.",
    );
    fs.writeFileSync(
      path.join(tmpRoot, "subdir", "nested.md"),
      "# Nested\nDeep content.",
    );

    linkedVault = createTempVault({
      "README.md": "# Vault with symlinks",
    });
    // Symlinked directory: wikis/linked-dir -> tmpRoot
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "linked-dir"));
    // Symlinked file: linked-file.md -> tmpRoot/top-level.md
    fs.symlinkSync(
      path.join(tmpRoot, "top-level.md"),
      path.join(linkedVault.vaultPath, "linked-file.md"),
    );
  });

  afterEach(() => {
    linkedVault.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("listFiles follows a symlinked directory into its files", () => {
    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    expect(files).toContain("linked-dir/top-level.md");
    expect(files).toContain("linked-dir/subdir/nested.md");
  });

  test("listFiles includes a symlinked file", () => {
    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    expect(files).toContain("linked-file.md");
  });

  test("listFolders surfaces a symlinked directory", () => {
    const folders = listFolders(linkedVault.vaultPath);
    expect(folders).toContain("linked-dir");
    expect(folders).toContain("linked-dir/subdir");
  });

  test("listFiles silently skips a broken symlink", () => {
    fs.symlinkSync(
      path.join(tmpRoot, "does-not-exist.md"),
      path.join(linkedVault.vaultPath, "broken.md"),
    );
    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    // Real + symlinked-target files are present; broken link is skipped.
    expect(files).toContain("README.md");
    expect(files).toContain("linked-file.md");
    expect(files).not.toContain("broken.md");
  });

  test("listFiles handles symlink cycles without infinite loop", () => {
    // a/ contains link 'loop' that points back to the vault root.
    const subdir = path.join(linkedVault.vaultPath, "a");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, "inside.md"), "# inside");
    fs.symlinkSync(linkedVault.vaultPath, path.join(subdir, "loop"));

    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    // Cycle is detected before re-entry: the vault is not walked a
    // second time via the `loop` symlink, so the result is the same
    // as if `loop` didn't exist.
    expect(new Set(files)).toEqual(
      new Set([
        "README.md",
        "a/inside.md",
        "linked-dir/subdir/nested.md",
        "linked-dir/top-level.md",
        "linked-file.md",
      ]),
    );
  });

  test("listFolders detects a symlink cycle back to an ancestor", () => {
    const subdir = path.join(linkedVault.vaultPath, "a");
    fs.mkdirSync(subdir, { recursive: true });
    fs.symlinkSync(linkedVault.vaultPath, path.join(subdir, "loop"));

    // Should return cleanly (not hang or overflow). `loop` itself
    // appears once as a visible folder, but its contents are not
    // re-walked.
    const folders = listFolders(linkedVault.vaultPath);
    expect(folders).toContain("a");
    expect(folders).toContain("linked-dir");
    // No entry should re-enter the vault via the loop prefix.
    for (const f of folders) {
      expect(f.startsWith("a/loop/a/")).toBe(false);
    }
  });

  test("sibling symlinks pointing at the same target are both walked", () => {
    // Two distinct symlink names, same underlying tmpRoot. Each
    // sibling should contribute its own prefixed entries.
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "mirror-a"));
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "mirror-b"));

    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    expect(files).toContain("mirror-a/top-level.md");
    expect(files).toContain("mirror-a/subdir/nested.md");
    expect(files).toContain("mirror-b/top-level.md");
    expect(files).toContain("mirror-b/subdir/nested.md");
  });

  test("symlink named like a skipDir entry is still skipped", () => {
    // A symlink named 'node_modules' should be excluded just like a real one.
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "node_modules"));
    const files = listFiles(linkedVault.vaultPath);
    for (const f of files) {
      expect(f.startsWith("node_modules/")).toBe(false);
    }
  });
});

describe("dotdir pruning", () => {
  let v: { path: string; vaultPath: string; cleanup: () => void };

  beforeEach(() => {
    v = createTempVault({
      "README.md": "# Vault",
      // Not in SKIP_DIRS — these are stricter-filter candidates.
      ".cache/notes.md": "# cache notes",
      ".cache/inner/deeper.md": "# deeper",
      ".vscode/tasks.md": "# tasks",
      "ok/fine.md": "# fine",
    });
  });

  afterEach(() => {
    v.cleanup();
  });

  test("listFolders prunes dotdir subtrees entirely", () => {
    const folders = listFolders(v.vaultPath);
    // Neither the dotdirs themselves nor any of their descendants.
    expect(folders).toContain("ok");
    expect(folders.some((f) => f.startsWith("."))).toBe(false);
    expect(folders.some((f) => f.includes(".cache"))).toBe(false);
    expect(folders.some((f) => f.includes(".vscode"))).toBe(false);
  });

  test("listFiles still lists dotdir contents (permissive by design)", () => {
    // listFiles's behavior pre-dates this PR: it only skips SKIP_DIRS,
    // not arbitrary dotdirs. Locked in so a future consolidation
    // doesn't accidentally shift it.
    const files = listFiles(v.vaultPath, { ext: "md" });
    expect(files).toContain("README.md");
    expect(files).toContain("ok/fine.md");
    expect(files).toContain(".cache/notes.md");
    expect(files).toContain(".cache/inner/deeper.md");
    expect(files).toContain(".vscode/tasks.md");
  });
});

describe("unreadable directories", () => {
  let v: { path: string; vaultPath: string; cleanup: () => void };
  let unreadableDir: string;

  beforeEach(() => {
    v = createTempVault({
      "keep.md": "# keep",
      "locked/note.md": "# note",
    });
    unreadableDir = path.join(v.vaultPath, "locked");
    // Drop read+exec perms so readdirSync throws. Skipped if running
    // as root (root bypasses DAC permissions).
    fs.chmodSync(unreadableDir, 0o000);
  });

  afterEach(() => {
    // Restore perms so cleanup can remove the tree.
    try {
      fs.chmodSync(unreadableDir, 0o755);
    } catch {
      // ignore
    }
    v.cleanup();
  });

  test("listFiles silently skips an unreadable subdirectory", () => {
    // process.geteuid is node-only; bun provides it via node:process.
    // Skip the assertion when running as root because chmod 0 is a
    // no-op for UID 0.
    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      return;
    }
    const files = listFiles(v.vaultPath, { ext: "md" });
    expect(files).toContain("keep.md");
    // locked/ was reported as a dir (via Dirent) but its contents
    // couldn't be read — walker should return cleanly without throwing.
    expect(files).not.toContain("locked/note.md");
  });
});

describe("ignore support", () => {
  let v: { path: string; vaultPath: string; cleanup: () => void };

  beforeEach(() => {
    v = createTempVault({
      "README.md": "# Vault",
      "keep.md": "# Keep",
      "Projects/alpha.md": "# Alpha",
      "Projects/beta.md": "# Beta",
      "generated/gen.md": "# Generated",
      ".hidden.md": "# Hidden dotfile",
      ".dotdir/inner.md": "# Hidden dotdir",
    });
  });

  afterEach(() => {
    v.cleanup();
  });

  test("listFiles excludes ignored files and prunes ignored dirs", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\ngenerated/\n",
    );
    const { ignorer: ignore } = loadIgnorer(v.vaultPath, v.vaultPath);
    const files = listFiles(v.vaultPath, { ext: "md", ignore });
    expect(files).toContain("README.md");
    expect(files).toContain("keep.md");
    expect(files).toContain("Projects/alpha.md");
    expect(files).not.toContain("Projects/beta.md");
    // Dir-only pattern prunes the subtree at descent.
    expect(files).not.toContain("generated/gen.md");
    // Default dotfiles rule excludes dotfiles and dotdir subtrees.
    expect(files).not.toContain(".hidden.md");
    expect(files).not.toContain(".dotdir/inner.md");
  });

  test("folder-scoped listFiles still matches vault-relative patterns", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const { ignorer: ignore } = loadIgnorer(v.vaultPath, v.vaultPath);
    // Walk root is vaultPath/Projects, but the pattern is vault-anchored.
    const files = listFiles(v.vaultPath, { folder: "Projects", ignore });
    expect(files).toEqual(["Projects/alpha.md"]);
  });

  test("folder-scoped listFolders matches vault-relative patterns", () => {
    // Mirror of the listFiles folder-scoped case: the walk root is
    // vaultPath/Projects, but ignore patterns are vault-anchored, so a
    // nested dir pruned by a vault-relative pattern must not surface.
    const scoped = createTempVault({
      "Projects/Active/one.md": "# One",
      "Projects/Archive/two.md": "# Two",
      "Other/three.md": "# Three",
    });
    try {
      fs.writeFileSync(
        path.join(scoped.vaultPath, ".napkinignore"),
        "Projects/Archive/\n",
      );
      const { ignorer: ignore } = loadIgnorer(
        scoped.vaultPath,
        scoped.vaultPath,
      );
      const folders = listFolders(scoped.vaultPath, "Projects", ignore);
      expect(folders).toEqual(["Projects/Active"]);
    } finally {
      scoped.cleanup();
    }
  });

  test("listFolders prunes dotdirs by default and surfaces them when dotfiles: false", () => {
    const { ignorer: ignoreDefault } = loadIgnorer(v.vaultPath, v.vaultPath);
    const folders = listFolders(v.vaultPath, undefined, ignoreDefault);
    expect(folders).toContain("Projects");
    expect(folders.some((f) => f.startsWith("."))).toBe(false);

    // dotfiles: false — the ignorer's dotfiles rule stops excluding dotdirs.
    const configPath = path.join(v.vaultPath, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.ignore = { ...config.ignore, dotfiles: false };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const { ignorer: ignoreAll } = loadIgnorer(v.vaultPath, v.vaultPath);
    const foldersAll = listFolders(v.vaultPath, undefined, ignoreAll);
    expect(foldersAll).toContain(".dotdir");
    expect(foldersAll).toContain("Projects");
  });

  test("listFiles filters ignored dirs when dotfiles: false keeps dotdirs walkable", () => {
    fs.writeFileSync(path.join(v.vaultPath, ".napkinignore"), ".dotdir/\n");
    const { ignorer: ignore } = loadIgnorer(v.vaultPath, v.vaultPath);
    const files = listFiles(v.vaultPath, { ext: "md", ignore });
    expect(files).not.toContain(".dotdir/inner.md");
  });

  test(".napkinignore is absent from root listings even when dotfiles: false", () => {
    fs.writeFileSync(path.join(v.vaultPath, ".napkinignore"), "ignored.md\n");
    const configPath = path.join(v.vaultPath, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.ignore = { ...config.ignore, dotfiles: false };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const { ignorer: ignore } = loadIgnorer(v.vaultPath, v.vaultPath);

    const files = listFiles(v.vaultPath, { ignore });
    expect(files).not.toContain(".napkinignore");
    // Internal config files stay hidden too.
    expect(files).not.toContain("config.json");
    expect(files).not.toContain("search-cache.json");
  });

  test("resolveFile: basename of an ignored file resolves to null, exact path still works", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const { ignorer: ignore } = loadIgnorer(v.vaultPath, v.vaultPath);

    // Wikilink-style basename resolution honors the ignorer.
    expect(resolveFile(v.vaultPath, "beta", ignore)).toBeNull();
    // Exact path is explicit intent — escape hatch.
    expect(resolveFile(v.vaultPath, "Projects/beta.md", ignore)).toEqual({
      path: "Projects/beta.md",
    });
    // Non-ignored basename still resolves.
    expect(resolveFile(v.vaultPath, "alpha", ignore)).toEqual({
      path: "Projects/alpha.md",
    });
  });

  test("suggestFile excludes ignored files", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const { ignorer: ignore } = loadIgnorer(v.vaultPath, v.vaultPath);
    const suggestions = suggestFile(v.vaultPath, "bet", ignore);
    expect(suggestions).not.toContain("Projects/beta.md");
    // Non-ignored names still surface.
    const keepSuggestions = suggestFile(v.vaultPath, "keep", ignore);
    expect(keepSuggestions).toContain("keep.md");
  });

  test("readFile throws for an ignored basename but reads by exact path", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const { ignorer: ignore } = loadIgnorer(v.vaultPath, v.vaultPath);
    expect(() => readFile(v.vaultPath, "beta", ignore)).toThrow(
      "File not found",
    );
    const { content } = readFile(v.vaultPath, "Projects/beta.md", ignore);
    expect(content).toContain("Beta");
  });
});
