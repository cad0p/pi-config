import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, saveConfig } from "./config.js";
import { NAPKIN_MARKER } from "./vault.js";

/**
 * Create a temporary vault for testing.
 * Embedded layout with an EXPLICIT root: .napkin/ is the vault root (content
 * lives inside it), declared via vault.root = "." — never the implicit
 * legacy fallback, which is refused.
 * Returns:
 *   - path: parent dir (pass to --vault for commands, findVault walks up from here)
 *   - vaultPath: the .napkin/ dir (pass directly to utility functions like listFiles)
 *   - cleanup: removes everything
 */
export function createTempVault(files?: Record<string, string>): {
  path: string;
  vaultPath: string;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-test-"));

  // .napkin/ IS the vault root, declared explicitly
  const napkinDir = path.join(tmpDir, NAPKIN_MARKER);
  fs.mkdirSync(napkinDir, { recursive: true });

  // Write config.json which also syncs .obsidian/
  const testConfig = {
    ...DEFAULT_CONFIG,
    daily: {
      ...DEFAULT_CONFIG.daily,
      folder: "Inbox/Daily",
    },
    vault: { root: "." },
  };
  saveConfig(napkinDir, testConfig);

  // Write files inside .napkin/ (the vault root)
  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const full = path.join(napkinDir, filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  return {
    path: tmpDir,
    vaultPath: napkinDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}
