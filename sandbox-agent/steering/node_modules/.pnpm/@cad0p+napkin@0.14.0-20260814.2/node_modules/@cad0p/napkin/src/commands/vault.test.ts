import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import { vault } from "./vault.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  v = createTempVault({
    "README.md": "# Vault",
    "Projects/note.md": "note",
    "Resources/guide.md": "guide",
  });
});

afterEach(() => {
  v.cleanup();
});

describe("vault command", () => {
  test("outputs json with vault info", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await vault({ json: true, vault: v.path });
    console.log = orig;

    const data = JSON.parse(logs.join(""));
    expect(data.name).toBeTruthy();
    expect(data.path).toBe(v.vaultPath);
    expect(data.files).toBe(3);
    expect(data.folders).toBe(2);
    expect(data.size).toBeGreaterThan(0);
  });

  test("counts symlinked files and their bytes", async () => {
    // External source directory that we'll symlink into the vault.
    const tmpSrc = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-vault-symlink-"),
    );
    const extContent = `# External\n${"x".repeat(500)}`;
    fs.writeFileSync(path.join(tmpSrc, "external.md"), extContent);
    fs.symlinkSync(tmpSrc, path.join(v.vaultPath, "linked"));

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await vault({ json: true, vault: v.path });
    } finally {
      console.log = orig;
      fs.rmSync(tmpSrc, { recursive: true, force: true });
    }

    const data = JSON.parse(logs.join(""));
    // 3 original files + 1 reached via symlink = 4.
    expect(data.files).toBe(4);
    // Size should include the 500-byte external content.
    expect(data.size).toBeGreaterThanOrEqual(extContent.length);
  });
});
