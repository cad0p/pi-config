import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT_NO_VAULT } from "./exit-codes.js";

/**
 * The directory marker identifying a napkin vault. The nested layout
 * composes `.obsidian` + `NAPKIN_MARKER` under the project root. This is
 * the single source of truth for the name — imported by downstream
 * packages and napkin's own walk.
 */
export const NAPKIN_MARKER = ".napkin";

export interface VaultInfo {
  /** Vault display name (derived from content root directory) */
  name: string;
  /** Where vault content lives (project root, parent of .napkin/) */
  contentPath: string;
  /** Where config.json lives (always the .napkin/ directory) */
  configPath: string;
  /** Where .obsidian/ directory lives */
  obsidianPath: string;
}

/**
 * Thrown when no usable vault can be found — neither a walk-up hit (`.napkin/`
 * at or above the starting directory) nor a global vault from the user config.
 * Also thrown when a `.napkin/` exists but is unreadable (legacy embedded
 * layout without an explicit `vault.root` in its config).
 */
export class VaultNotFoundError extends Error {
  readonly exitCode = EXIT_NO_VAULT;

  constructor(message: string) {
    super(message);
    this.name = "VaultNotFoundError";
  }
}

function noVaultFoundMessage(
  startDir: string,
  globalConfigPath: string,
): string {
  return (
    `No napkin vault found (searched up from ${startDir}).\n` +
    `  Run \`napkin init\` to create one here, pass --vault <path>, or set a` +
    ` global vault in ${globalConfigPath} ({"vault": "/path/to/vault"}).`
  );
}

function legacyLayoutMessage(napkinDir: string, projectDir: string): string {
  const siblingRoot = path.relative(napkinDir, projectDir).replace(/\\/g, "/");
  return (
    `Vault at ${projectDir} uses the legacy embedded layout: ` +
    `${path.join(napkinDir, "config.json")} is missing, unreadable, or has` +
    ` no "vault" section. ` +
    `This layout is no longer supported.\n` +
    `  Add "vault": {"root": "${siblingRoot}"} to adopt the sibling layout` +
    ` (content in ${projectDir}/), or "vault": {"root": "."} to keep` +
    ` content inside ${napkinDir}/.`
  );
}

/**
 * Walk up from startDir looking for .napkin/ (or .obsidian/.napkin/ for nested layout).
 * Falls back to the global vault configured in $XDG_CONFIG_HOME/napkin/config.json.
 * Throws {@link VaultNotFoundError} when no vault exists — never silently
 * creates one in the user's cwd.
 */
export function findVault(startDir?: string): VaultInfo {
  let dir = path.resolve(startDir || process.cwd());
  const root = path.parse(dir).root;

  const startingDir = dir;

  while (true) {
    const napkinDir = path.join(dir, NAPKIN_MARKER);

    if (fs.existsSync(napkinDir) && fs.statSync(napkinDir).isDirectory()) {
      return resolveVaultLayout(napkinDir, dir);
    }

    // Check for nested layout: .obsidian/.napkin/
    const nestedNapkin = path.join(dir, ".obsidian", NAPKIN_MARKER);
    if (
      fs.existsSync(nestedNapkin) &&
      fs.statSync(nestedNapkin).isDirectory()
    ) {
      return resolveVaultLayout(nestedNapkin, dir);
    }

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      break;
    }
    dir = parent;
  }

  // Fall back to global vault from user config
  const globalVault = getGlobalConfigVault();
  if (globalVault) {
    return resolveVaultLayout(globalVault, path.dirname(globalVault));
  }

  // No vault found — fail loudly instead of creating a bare vault in the
  // user's cwd. Silent auto-create produced stray .napkin/ + .obsidian/ +
  // NAPKIN.md dirs in arbitrary directories (and in agent workspace dirs),
  // which users consistently reported as surprising.
  throw new VaultNotFoundError(
    noVaultFoundMessage(startingDir, globalConfigPath()),
  );
}

/**
 * Walk up from startDir looking for an existing vault's `.napkin/` (or
 * `.obsidian/.napkin/` for the nested layout) at any level. Purely
 * structural — no global-config fallback and no layout validation: any
 * ancestor `.napkin/` counts, even a legacy one. Returns the directory
 * that contains it, or null.
 */
export function findAncestorVault(startDir?: string): string | null {
  return findAncestorMarker(startDir || process.cwd())?.vaultDir ?? null;
}

/**
 * Shared walk behind {@link findAncestorVault} and
 * {@link findAncestorConfigDir}. Returns the directory that contains a
 * vault marker plus the marker directory itself (`.napkin/`, or
 * `.obsidian/.napkin/` for the nested layout — where the vault's
 * `config.json` lives), or null. Purely structural, read-only probes.
 */
function findAncestorMarker(
  startDir: string,
): { vaultDir: string; markerDir: string } | null {
  let dir = path.resolve(startDir || process.cwd());
  const root = path.parse(dir).root;

  while (true) {
    const napkinDir = path.join(dir, NAPKIN_MARKER);
    if (fs.existsSync(napkinDir) && fs.statSync(napkinDir).isDirectory()) {
      return { vaultDir: dir, markerDir: napkinDir };
    }

    const nestedNapkin = path.join(dir, ".obsidian", NAPKIN_MARKER);
    if (
      fs.existsSync(nestedNapkin) &&
      fs.statSync(nestedNapkin).isDirectory()
    ) {
      return { vaultDir: dir, markerDir: nestedNapkin };
    }

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Walk up from startDir looking for an existing vault's `.napkin/` (or
 * `.obsidian/.napkin/` for the nested layout) at any level, returning
 * the marker directory itself — where the vault's `config.json` lives.
 * Purely structural — no global-config fallback and no layout
 * validation: any ancestor marker counts, even a legacy one. Returns
 * the marker dir, or null.
 */
export function findAncestorConfigDir(startDir?: string): string | null {
  return findAncestorMarker(startDir || process.cwd())?.markerDir ?? null;
}

/**
 * Path to the global napkin config: $XDG_CONFIG_HOME/napkin/config.json
 * (defaults to ~/.config/napkin/config.json).
 */
export function globalConfigPath(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "napkin",
    "config.json",
  );
}

/**
 * Set `vault` in the global config so `vaultPath` becomes the default vault
 * for commands run outside any vault. Only writes when NO usable default
 * vault is configured yet (missing config, missing `vault` field, or a
 * stale path whose `.napkin/` no longer exists) — an existing valid default
 * is an explicit user choice and is never overwritten. Other keys in an
 * existing global config are preserved.
 *
 * Returns whether a write happened and the config path.
 */
export function setGlobalVaultIfUnset(vaultPath: string): {
  set: boolean;
  configPath: string;
} {
  const configPath = globalConfigPath();
  if (getGlobalConfigVault()) {
    return { set: false, configPath };
  }

  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // invalid JSON — start fresh, only the vault key matters globally
      raw = {};
    }
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...raw, vault: vaultPath }, null, 2) + "\n",
  );
  return { set: true, configPath };
}

/**
 * Check for a global vault configured in the user's config directory.
 * Reads the `vault` field from $XDG_CONFIG_HOME/napkin/config.json
 * (defaults to ~/.config/napkin/config.json).
 *
 * Returns the .napkin/ path if a valid vault is configured, null otherwise.
 */
function getGlobalConfigVault(): string | null {
  const configPath = globalConfigPath();
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!raw.vault) return null;

    const vaultPath =
      raw.vault === "~" || raw.vault.startsWith("~/")
        ? path.join(os.homedir(), raw.vault.slice(1))
        : path.resolve(path.dirname(configPath), raw.vault);

    const napkinDir = path.join(vaultPath, NAPKIN_MARKER);
    // A FILE named .napkin is not a vault — only a directory counts as a
    // valid default; otherwise a stray file would block replacement.
    if (fs.existsSync(napkinDir) && fs.statSync(napkinDir).isDirectory()) {
      return napkinDir;
    }
  } catch {
    // invalid config
  }

  return null;
}

/**
 * Resolve vault layout from .napkin/config.json vault paths.
 * Requires an explicit `vault.root` — a `.napkin/` whose config lacks a
 * `vault` section is the legacy embedded layout and is refused with a
 * migration hint.
 */
function resolveVaultLayout(napkinDir: string, projectDir: string): VaultInfo {
  const configPath = path.join(napkinDir, "config.json");
  let vaultConfig: { root?: string; obsidian?: string } | undefined;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    vaultConfig = raw.vault;
  } catch {
    // no config or invalid — treat as legacy below
  }

  if (!vaultConfig?.root) {
    throw new VaultNotFoundError(legacyLayoutMessage(napkinDir, projectDir));
  }

  const contentPath = path.resolve(napkinDir, vaultConfig.root);
  const obsidianPath = vaultConfig.obsidian
    ? path.resolve(napkinDir, vaultConfig.obsidian)
    : path.join(contentPath, ".obsidian");
  return {
    name: path.basename(contentPath),
    contentPath,
    configPath: napkinDir,
    obsidianPath,
  };
}

/**
 * Read a JSON config file from .obsidian/ directory.
 * Returns parsed JSON or null if file doesn't exist.
 */
export function getVaultConfig(
  obsidianPath: string,
  configFile: string,
): Record<string, unknown> | null {
  const configPath = path.join(obsidianPath, configFile);
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
