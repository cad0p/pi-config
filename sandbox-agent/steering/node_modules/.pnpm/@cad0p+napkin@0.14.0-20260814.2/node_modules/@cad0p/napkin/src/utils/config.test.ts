import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { createTempVault } from "./test-helpers.js";

let vault: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  vault = createTempVault();
});

afterEach(() => {
  vault.cleanup();
});

describe("ignore config defaults", () => {
  test("DEFAULT_CONFIG has ignore.respectGitignore true and ignore.dotfiles true", () => {
    expect(DEFAULT_CONFIG.ignore).toEqual({
      respectGitignore: true,
      dotfiles: true,
    });
  });

  test("loadConfig fills ignore defaults when config.json lacks the section", () => {
    // Strip the ignore section (simulates a pre-ignore config file).
    const configPath = path.join(vault.vaultPath, "config.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    delete raw.ignore;
    fs.writeFileSync(configPath, JSON.stringify(raw));

    const config = loadConfig(vault.vaultPath);
    expect(config.ignore).toEqual({ respectGitignore: true, dotfiles: true });
  });

  test("loadConfig honors explicit ignore values", () => {
    const configPath = path.join(vault.vaultPath, "config.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    raw.ignore = { respectGitignore: false, dotfiles: false };
    fs.writeFileSync(configPath, JSON.stringify(raw));

    const config = loadConfig(vault.vaultPath);
    expect(config.ignore).toEqual({ respectGitignore: false, dotfiles: false });
  });
});

describe("saveConfig obsidian sync target", () => {
  test("sibling layout with no obsidian syncs into <contentRoot>/.obsidian", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-config-sibling-"),
    );
    const napkinDir = path.join(tmpDir, ".napkin");
    fs.mkdirSync(napkinDir, { recursive: true });
    const contentRoot = tmpDir;
    const config: ReturnType<typeof loadConfig> = {
      ...DEFAULT_CONFIG,
      vault: { root: ".." },
    };

    try {
      saveConfig(napkinDir, config);

      // Synced files land in the content root's .obsidian/ — the dir the CLI
      // reads — not in .napkin/.obsidian, which is never read.
      expect(
        fs.existsSync(path.join(contentRoot, ".obsidian", "app.json")),
      ).toBe(true);
      expect(fs.existsSync(path.join(napkinDir, ".obsidian"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("no vault config keeps the embedded .napkin/.obsidian fallback", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-config-embedded-"),
    );
    const napkinDir = path.join(tmpDir, ".napkin");
    fs.mkdirSync(napkinDir, { recursive: true });
    const config: ReturnType<typeof loadConfig> = {
      ...DEFAULT_CONFIG,
      vault: undefined,
    };

    try {
      saveConfig(napkinDir, config);

      expect(fs.existsSync(path.join(napkinDir, ".obsidian", "app.json"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
