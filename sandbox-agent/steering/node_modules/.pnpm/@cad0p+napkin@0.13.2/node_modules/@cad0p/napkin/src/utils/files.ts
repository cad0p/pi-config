import * as fs from "node:fs";
import * as path from "node:path";
import type { Ignorer } from "./ignore.js";

export interface FileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  created: number;
  modified: number;
}

export interface FileRef {
  path: string;
  heading?: string;
}

/**
 * Parse an Obsidian wikilink-style file reference.
 * Exact parsing order:
 * 1) Strip `[[` and `]]`
 * 2) Split by `|` and discard the alias portion
 * 3) Split the remaining string by the **last** `#` to safely separate the file path from the heading.
 */
export function parseFileRef(fileRef: string): FileRef {
  let ref = fileRef;
  if (ref.startsWith("[[") && ref.endsWith("]]")) {
    ref = ref.slice(2, -2);
  }

  const pipeIndex = ref.indexOf("|");
  if (pipeIndex !== -1) {
    ref = ref.slice(0, pipeIndex);
  }

  const hashIndex = ref.lastIndexOf("#");
  if (hashIndex !== -1) {
    return {
      path: ref.slice(0, hashIndex),
      heading: ref.slice(hashIndex + 1),
    };
  }

  return { path: ref };
}

export interface ListFilesOptions {
  folder?: string;
  ext?: string;
  /** When supplied, ignored files/dirs are excluded from the listing. */
  ignore?: Ignorer;
}

/**
 * Directory names that walkers skip unconditionally (internal Obsidian/napkin
 * state, VCS metadata, and package managers).
 *
 * Shared by listFiles, listFolders, walkMd (graph), and getVaultSize so all
 * four walkers agree on what to exclude. This matters especially when a vault
 * contains symlinks into external trees (e.g. Brazil workspace packages) whose
 * node_modules/ would otherwise balloon results.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".obsidian",
  ".git",
  ".trash",
  ".nanny",
  ".napkin",
  "node_modules",
]);

/** What a Dirent resolves to, following symlinks to their target. */
export type EntryKind = "dir" | "file" | null;

/**
 * Classify a Dirent. For symlinks, follows to the target and reports the
 * target kind. Returns null for broken symlinks, unreadable targets, and
 * non-regular entries (sockets, FIFOs, devices).
 *
 * Using this lets walkers treat symlinks to directories/files as first-class
 * entries while still gracefully skipping unreadable targets.
 */
export function direntKind(fullPath: string, entry: fs.Dirent): EntryKind {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) {
    try {
      const stat = fs.statSync(fullPath); // follows symlinks
      if (stat.isDirectory()) return "dir";
      if (stat.isFile()) return "file";
      return null; // socket / FIFO / device
    } catch {
      // Broken symlink or target inaccessible.
      return null;
    }
  }
  return null;
}

/**
 * Resolve a directory's real path for cycle detection. Returns null on
 * failure (permission errors, broken intermediate path, etc.) so callers
 * can fail closed rather than risk an unbounded walk.
 */
export function safeRealpath(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * Options for {@link walkDir}.
 */
export interface WalkDirOptions {
  /**
   * Called once per visited file or directory entry (after skip-dir
   * filtering and symlink resolution). Never invoked with kind=null;
   * non-regular and broken entries are filtered out by the walker.
   */
  onEntry: (fullPath: string, entry: fs.Dirent, kind: "dir" | "file") => void;
  /**
   * Optional predicate to prune directories. Called for each directory
   * entry (including symlinked dirs) AFTER the SKIP_DIRS check. Return
   * false to skip the directory entirely: it is neither reported via
   * onEntry nor walked. Not consulted for files.
   *
   * Use this to apply stricter pruning than SKIP_DIRS (e.g. walkMd and
   * listFolders prune all dot-prefixed directories).
   */
  shouldEnter?: (fullPath: string, entry: fs.Dirent) => boolean;
  /**
   * Optional ignore predicate. Receives the entry path RELATIVE TO THE
   * WALK ROOT plus its kind. Dirs for which it returns true are pruned
   * (neither reported nor walked, composed with shouldEnter); files for
   * which it returns true are filtered out before onEntry. Callers whose
   * patterns are anchored elsewhere (e.g. vault-relative) must wrap this
   * with their own relative-path computation.
   */
  ignore?: (relToRoot: string, kind: "dir" | "file") => boolean;
}

/**
 * Walk a directory tree, invoking onEntry for each file and directory.
 *
 * Skip semantics:
 * - Directory names in SKIP_DIRS are never entered or reported.
 * - If shouldEnter is provided, directories for which it returns false
 *   are also neither entered nor reported. This lets callers prune
 *   subtrees (e.g. dotdirs) symmetrically with SKIP_DIRS — filtering
 *   inside onEntry would only hide the report while still walking the
 *   subtree.
 * - If ignore is provided, directories for which it returns true are
 *   pruned the same way, and files for which it returns true are dropped
 *   before onEntry. When neither shouldEnter nor ignore is supplied,
 *   behavior is exactly SKIP_DIRS-only.
 *
 * Symlink semantics:
 * - Symlinks to regular files/directories are classified via direntKind
 *   and reported with kind "dir" or "file".
 * - A symlink that resolves to a directory is walked recursively.
 * - Broken symlinks, sockets, FIFOs, and devices are silently skipped.
 *
 * Cycle detection: uses an on-stack set of realpaths for the current
 * recursion path. A symlink that resolves to an ancestor in the descent
 * is skipped exactly once; two sibling symlinks to the same target are
 * both walked. realpathSync is only invoked when crossing a symlink
 * boundary (or at the root), so symlink-free vaults pay no extra cost
 * versus the pre-fix baseline.
 *
 * Fail-closed: if realpathSync fails on a subtree entered via a symlink,
 * that subtree is skipped to avoid potential unbounded recursion.
 */
export function walkDir(root: string, opts: WalkDirOptions): void {
  const onStack = new Set<string>();
  // Seed with the root's real path so a symlink back to the root is
  // detected even though we don't mark the top-level descent as
  // "via symlink".
  const rootReal = safeRealpath(root);
  if (rootReal !== null) onStack.add(rootReal);

  function walk(dir: string, viaSymlink: boolean): void {
    let stackKey: string | null = null;
    if (viaSymlink) {
      stackKey = safeRealpath(dir);
      if (stackKey === null) return; // inaccessible symlinked subtree
      if (onStack.has(stackKey)) return; // cycle
      onStack.add(stackKey);
    }
    try {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const kind = direntKind(fullPath, entry);
        if (kind === null) continue;
        if (kind === "dir") {
          // Check shouldEnter BEFORE reporting so that a pruned
          // directory is neither emitted nor walked, matching the
          // pre-consolidation semantics of listFolders/walkMd.
          if (opts.shouldEnter && !opts.shouldEnter(fullPath, entry)) continue;
          if (opts.ignore?.(path.relative(root, fullPath), "dir")) continue;
          opts.onEntry(fullPath, entry, kind);
          walk(fullPath, viaSymlink || entry.isSymbolicLink());
        } else {
          if (opts.ignore?.(path.relative(root, fullPath), "file")) continue;
          opts.onEntry(fullPath, entry, kind);
        }
      }
    } finally {
      if (stackKey !== null) onStack.delete(stackKey);
    }
  }

  walk(root, false);
}

/**
 * Recursively list files in a vault.
 *
 * - Skips the directories in SKIP_DIRS (".obsidian", ".git", etc.).
 * - Follows symlinks to files and directories. Note that symlinked content
 *   may physically live outside vaultPath; callers that feed results to
 *   downstream consumers (e.g. LLM prompts via the SDK) should be aware
 *   that `readFile` of a returned path may access external data.
 * - Detects symlink cycles via realpath tracking on the current recursion
 *   path, so a symlink pointing back to an ancestor is entered at most
 *   once. Sibling symlinks to the same target are both walked (each
 *   contributes its own prefixed entries).
 * - Broken symlinks, sockets, FIFOs, and unreadable entries are silently
 *   skipped.
 */
export function listFiles(
  vaultPath: string,
  opts?: ListFilesOptions,
): string[] {
  const results: string[] = [];
  // Internal napkin files that shouldn't appear in vault content listings.
  // .napkinignore is napkin's own ignore config file — same class as
  // config.json/search-cache.json — and must not leak into listings even
  // when the dotfiles rule is disabled (ignore.dotfiles: false).
  const skipFiles = new Set([
    "config.json",
    "search-cache.json",
    ".napkinignore",
  ]);

  const baseDir = opts?.folder ? path.join(vaultPath, opts.folder) : vaultPath;
  if (!fs.existsSync(baseDir)) return results;

  const ignore = opts?.ignore;
  walkDir(baseDir, {
    onEntry: (fullPath, _entry, kind) => {
      if (kind !== "file") return;
      // Skip internal config files at vault root
      if (
        path.dirname(fullPath) === vaultPath &&
        skipFiles.has(path.basename(fullPath))
      )
        return;
      const rel = path.relative(vaultPath, fullPath);
      if (opts?.ext) {
        if (path.extname(fullPath).slice(1) === opts.ext) {
          results.push(rel);
        }
      } else {
        results.push(rel);
      }
    },
    // When an ignorer is supplied, prune ignored dirs at descent and drop
    // ignored files before onEntry. relToRoot is relative to the walk root
    // (baseDir), which may be vaultPath/folder for folder-scoped calls —
    // patterns are vault-anchored, so re-relative to vaultPath here. Dirs
    // get a trailing "/" so dir-only gitignore patterns (e.g. `build/`)
    // match them.
    ignore: ignore
      ? (relToRoot, kind) => {
          const rel = path.relative(vaultPath, path.join(baseDir, relToRoot));
          return ignore.ignores(kind === "dir" ? `${rel}/` : rel);
        }
      : undefined,
  });
  return results.sort();
}

/**
 * List folders in a vault. Same symlink semantics as listFiles.
 *
 * When an ignorer is supplied, its dotfiles rule and ignore-file patterns
 * decide what is pruned (replacing the hardcoded dotdir prune). Without one,
 * the legacy behavior is retained: all dot-prefixed directories are pruned
 * at descent time.
 */
export function listFolders(
  vaultPath: string,
  parentFolder?: string,
  ignore?: Ignorer,
): string[] {
  const results: string[] = [];

  const baseDir = parentFolder ? path.join(vaultPath, parentFolder) : vaultPath;
  if (!fs.existsSync(baseDir)) return results;

  walkDir(baseDir, {
    onEntry: (fullPath, _entry, kind) => {
      if (kind !== "dir") return;
      results.push(path.relative(vaultPath, fullPath));
    },
    // Legacy default: prune dotdirs at descent time so their subtree is not
    // walked (matches pre-consolidation listFolders behavior). walkDir
    // already filters SKIP_DIRS; this is the additional dotdir policy. When
    // an ignorer IS supplied it decides instead (dotfiles rule + patterns;
    // ignore.dotfiles: false surfaces dotdirs, consistent with listFiles).
    ...(ignore
      ? {
          ignore: (relToRoot: string, kind: "dir" | "file") => {
            const rel = path.relative(vaultPath, path.join(baseDir, relToRoot));
            return ignore.ignores(kind === "dir" ? `${rel}/` : rel);
          },
        }
      : {
          shouldEnter: (_fullPath: string, entry: fs.Dirent) =>
            !entry.name.startsWith("."),
        }),
  });
  return results.sort();
}

/**
 * Find all .md files matching a wikilink-style name or exact path.
 *
 * Exact paths bypass the ignorer (an explicit path is an explicit intent —
 * the escape hatch for reading ignored files); basename resolution honors
 * it, so ignored files are invisible to wikilink-style references.
 */
function findMatches(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): string[] {
  // Exact path
  if (fileRef.includes("/") || fileRef.endsWith(".md")) {
    const ref = fileRef.endsWith(".md") ? fileRef : `${fileRef}.md`;
    const fullPath = path.join(vaultPath, ref);
    return fs.existsSync(fullPath) ? [ref] : [];
  }

  // Wikilink-style: search by basename
  const target = fileRef.toLowerCase();
  const allFiles = listFiles(vaultPath, { ext: "md", ignore });
  return allFiles.filter(
    (file) => path.basename(file, ".md").toLowerCase() === target,
  );
}

/**
 * Resolve a file reference (wikilink-style name or exact path) to a relative path in the vault.
 * Throws on ambiguous matches so the user can disambiguate.
 */
export function resolveFile(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): FileRef | null {
  const parsed = parseFileRef(fileRef);
  const matches = findMatches(vaultPath, parsed.path, ignore);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous file reference "${fileRef}" matches ${matches.length} files: ${matches.join(", ")}. Use the full path to disambiguate.`,
    );
  }
  return matches[0] ? { path: matches[0], heading: parsed.heading } : null;
}

/**
 * Like resolveFile but never throws on ambiguous matches.
 * Returns the shallowest match (fewest path segments), matching Obsidian's behavior.
 */
export function resolveFileLoose(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): FileRef | null {
  const parsed = parseFileRef(fileRef);
  const matches = findMatches(vaultPath, parsed.path, ignore);
  if (matches.length > 1) {
    matches.sort((a, b) => a.split("/").length - b.split("/").length);
  }
  return matches[0] ? { path: matches[0], heading: parsed.heading } : null;
}

/**
 * Suggest similar filenames when a file isn't found.
 * Returns up to 3 suggestions sorted by similarity.
 */
export function suggestFile(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): string[] {
  const target = fileRef.toLowerCase();
  const allFiles = listFiles(vaultPath, { ext: "md", ignore });
  const scored = allFiles
    .map((f) => {
      const basename = path.basename(f, ".md").toLowerCase();
      // Simple substring match scoring
      let score = 0;
      if (basename.includes(target) || target.includes(basename)) score += 3;
      // Shared prefix
      let prefix = 0;
      while (
        prefix < basename.length &&
        prefix < target.length &&
        basename[prefix] === target[prefix]
      )
        prefix++;
      score += prefix;
      return { file: f, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return scored.map((s) => s.file);
}

/**
 * Read a file's contents, resolving by name or path.
 */
export function readFile(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): { path: string; content: string } {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }
  const fullPath = path.join(vaultPath, resolved.path);
  const content = fs.readFileSync(fullPath, "utf-8");
  return { path: resolved.path, content };
}

/**
 * Get file info for a resolved file path.
 */
export function getFileInfo(vaultPath: string, relativePath: string): FileInfo {
  const fullPath = path.join(vaultPath, relativePath);
  const stat = fs.statSync(fullPath);
  const ext = path.extname(relativePath);
  return {
    path: relativePath,
    name: path.basename(relativePath, ext),
    extension: ext.slice(1),
    size: stat.size,
    created: stat.birthtimeMs,
    modified: stat.mtimeMs,
  };
}
