import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
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
