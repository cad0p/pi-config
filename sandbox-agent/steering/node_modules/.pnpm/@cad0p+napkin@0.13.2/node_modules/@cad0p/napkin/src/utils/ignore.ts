import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { loadConfig } from "./config.js";

const NAPKINIGNORE_FILE = ".napkinignore";
const GITIGNORE_FILE = ".gitignore";

/**
 * A compiled set of ignore rules for one vault.
 */
export interface Ignorer {
  /**
   * Returns true when the vault-relative path is ignored.
   *
   * Directory paths must be passed with a trailing "/" so dir-only gitignore
   * patterns (e.g. `build/`) match them; file paths are passed as-is.
   */
  ignores(relPath: string): boolean;
}

/** Shared no-op ignorer used when nothing is configured to ignore. */
const NEVER_IGNORE: Ignorer = { ignores: () => false };

/**
 * A vault's ignore state: the compiled ignorer plus the fingerprint of the
 * ignore-relevant inputs it was built from. Returning both lets callers that
 * persist caches (search) reuse the single fingerprint computation instead of
 * re-hashing the ignore files.
 */
export interface IgnoreState {
  ignorer: Ignorer;
  fingerprint: string;
}

// loadIgnorer is memoized per (contentPath, configPath, fingerprint) so
// repeat callers (every command/core function holding VaultInfo) pay the
// stat+hash cost once per ignore-state change instead of once per call.
const memo = new Map<string, Ignorer>();

function memoKey(
  contentPath: string,
  configPath: string,
  fingerprint: string,
): string {
  return `${contentPath}\0${configPath}\0${fingerprint}`;
}

/**
 * Load the ignorer for a vault — union of three sources, each evaluated on
 * vault-relative paths:
 *
 * 1. `.napkinignore` (vault root): gitignore-style patterns, always honored
 *    when the file is present (empty file = no-op). No config flag.
 * 2. `.gitignore` (vault root): honored when config `ignore.respectGitignore`
 *    is true (default). Only the vault-root file; nested `.gitignore` files
 *    and monorepo roots above the vault are NOT consulted.
 * 3. Dotfiles rule: config `ignore.dotfiles` (default true) excludes
 *    dot-prefixed entries — files AND folders (Obsidian "hidden files"
 *    parity). When false, dotdirs and dotfiles surface everywhere.
 *
 * A path is ignored when ANY source matches. Negation (`!`) works within
 * each source; cross-source negation is not supported (a `.napkinignore`
 * line cannot un-ignore a gitignored file).
 *
 * Memoized by fingerprint — repeated calls are cheap; a change to the config
 * or either ignore file produces a new fingerprint and a fresh ignorer.
 *
 * Returns `{ ignorer, fingerprint }`: the fingerprint is the memo key's
 * basis, so it is computed exactly once per call and handed back to callers
 * that need it (e.g. search's disk-cache validity check).
 */
export function loadIgnorer(
  contentPath: string,
  configPath: string,
): IgnoreState {
  const fingerprint = ignoreFingerprint(contentPath, configPath);
  const key = memoKey(contentPath, configPath, fingerprint);
  const cached = memo.get(key);
  if (cached) return { ignorer: cached, fingerprint };
  const ignorer = buildIgnorer(contentPath, configPath);
  memo.set(key, ignorer);
  return { ignorer, fingerprint };
}

/**
 * md5 fingerprint of the ignore-relevant state: the `ignore.*` config values
 * plus the ignore files' {mtime, size} (absent file = "none" marker). The
 * search cache folds this in so any ignore change triggers a cold rebuild.
 *
 * `.gitignore` is only hashed when `respectGitignore` is true — when the
 * flag is off the file has no effect on ignore state, so editing it must not
 * invalidate the cache.
 */
export function ignoreFingerprint(
  contentPath: string,
  configPath: string,
): string {
  const config = loadConfig(configPath);
  const hash = crypto.createHash("md5");
  hash.update(
    `respectGitignore=${config.ignore.respectGitignore}\ndotfiles=${config.ignore.dotfiles}\n`,
  );
  hash.update(fileSig(path.join(contentPath, NAPKINIGNORE_FILE)));
  if (config.ignore.respectGitignore) {
    hash.update(fileSig(path.join(contentPath, GITIGNORE_FILE)));
  }
  return hash.digest("hex");
}

function fileSig(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}\0mtime=${stat.mtimeMs},size=${stat.size}\n`;
  } catch {
    return `${filePath}\0none\n`;
  }
}

function buildIgnorer(contentPath: string, configPath: string): Ignorer {
  const config = loadConfig(configPath);
  const dotfiles = config.ignore.dotfiles;

  const matchers: ReturnType<typeof ignore>[] = [];
  const napkinignore = readIgnoreFile(
    path.join(contentPath, NAPKINIGNORE_FILE),
  );
  if (napkinignore.length > 0) matchers.push(ignore().add(napkinignore));
  if (config.ignore.respectGitignore) {
    const gitignore = readIgnoreFile(path.join(contentPath, GITIGNORE_FILE));
    if (gitignore.length > 0) matchers.push(ignore().add(gitignore));
  }

  if (!dotfiles && matchers.length === 0) return NEVER_IGNORE;

  return {
    ignores(relPath: string): boolean {
      if (dotfiles && path.basename(relPath).startsWith(".")) return true;
      if (matchers.length === 0) return false;
      for (const matcher of matchers) {
        if (matcher.ignores(relPath)) return true;
      }
      return false;
    },
  };
}

/** Read an ignore file into non-empty lines (gitignore line semantics). */
function readIgnoreFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split(/\r?\n/).filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}
