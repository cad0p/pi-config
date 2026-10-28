import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles } from "./files.js";
import type { Ignorer } from "./ignore.js";

const CACHE_FILE = "search-cache.json";

export interface CachedDoc {
  file: string;
  basename: string;
  mtime: number;
  size: number;
  /**
   * Full file content, persisted so the warm path can run the content scan
   * with correct recall (fixes #22).
   */
  content: string;
}

export interface SearchCacheData {
  /** Scope of this cache — null = full vault, otherwise folder path. */
  folder: string | null;
  /** file → {mtime,size} map, for incremental diffing. */
  fileMtimes: Record<string, FileStatSig>;
  /** JSON-serialized MiniSearch index. */
  index: string;
  /** Doc metadata (with content — needed by the warm-path content scan). */
  docs: CachedDoc[];
  /** file → inbound backlink count. */
  backlinkCounts: Record<string, number>;
  /** file → raw wikilink targets (for incremental backlink recompute). */
  outgoingLinks: Record<string, string[]>;
  /**
   * Fingerprint of the ignore-relevant state (config `ignore.*` + both
   * ignore files' {mtime,size}). A mismatch forces a cold rebuild — an
   * ignore change can hide/unhide files that incremental diffing would
   * miss.
   */
  ignoreFingerprint: string;
}

export interface FileMtimeEntry {
  file: string;
  mtime: number;
  /** File size in bytes — a second change signal alongside mtime. */
  size: number;
}

/**
 * Stat all .md files in the vault (within optional folder scope).
 * Single directory walk + per-file stat — the unavoidable per-search floor.
 *
 * Captures `mtimeMs` AND `size` because some filesystems (ext4/tmpfs) report
 * identical `mtimeMs` for rapid successive writes within the same tick — an
 * mtime-only diff would miss a same-tick content edit and serve a stale index.
 * Size catches the common case (any edit that changes byte length) at zero
 * extra cost. A same-tick AND same-size edit is a pathological corner that
 * would require content hashing to detect; we deliberately accept that
 * tradeoff to keep the warm path free of full-content reads.
 */
export function statAllFiles(
  contentPath: string,
  folder?: string,
  ignore?: Ignorer,
): FileMtimeEntry[] {
  const files = listFiles(contentPath, { folder, ext: "md", ignore });
  const entries: FileMtimeEntry[] = [];
  for (const file of files) {
    const stat = fs.statSync(path.join(contentPath, file));
    entries.push({ file, mtime: stat.mtimeMs, size: stat.size });
  }
  return entries;
}

/**
 * Compute a fingerprint of all .md files based on paths and mtimes.
 * Changes when files are added, removed, or modified.
 *
 * @deprecated Used by legacy tests; `searchVault` now uses `statAllFiles` +
 * `diffFileMtimes` for incremental updates. Kept for backward compatibility.
 */
export function computeFingerprint(
  contentPath: string,
  folder?: string,
): string {
  const entries = statAllFiles(contentPath, folder);
  const hash = crypto.createHash("md5");
  for (const { file, mtime, size } of entries) {
    hash.update(`${file}:${mtime}:${size}\n`);
  }
  return hash.digest("hex");
}

export interface FileDiff {
  /** New or modified files (need to be read + indexed). */
  toAdd: FileMtimeEntry[];
  /** Deleted files (need to be discarded from index). */
  toRemove: string[];
  /** True when nothing changed — the fast warm path. */
  unchanged: boolean;
}

/**
 * Cached per-file stat signature used for change detection.
 * Keyed by file path; a file is "changed" when mtime OR size differs.
 */
export interface FileStatSig {
  mtime: number;
  size: number;
}

/**
 * Diff cached file stats against current stat results.
 * Returns the set of files to add/modify and to remove.
 *
 * A file is treated as modified when its mtime OR its size differs from the
 * cached value. Comparing size in addition to mtime catches same-tick edits
 * (where the filesystem reports an unchanged mtimeMs) as long as the byte
 * length changed — the common case for real edits.
 */
export function diffFileMtimes(
  cached: Record<string, FileStatSig>,
  current: FileMtimeEntry[],
): FileDiff {
  const currentMap = new Map(current.map((e) => [e.file, e]));
  const toAdd: FileMtimeEntry[] = [];
  const toRemove: string[] = [];

  for (const entry of current) {
    const cachedSig = cached[entry.file];
    if (
      cachedSig === undefined ||
      cachedSig.mtime !== entry.mtime ||
      cachedSig.size !== entry.size
    ) {
      toAdd.push(entry);
    }
  }
  for (const file of Object.keys(cached)) {
    if (!currentMap.has(file)) {
      toRemove.push(file);
    }
  }

  return {
    toAdd,
    toRemove,
    unchanged: toAdd.length === 0 && toRemove.length === 0,
  };
}

/**
 * Load cached search index if it exists and is valid.
 * Returns null if no cache or corrupted data.
 * The caller is responsible for diffing fileMtimes to decide warm vs incremental.
 */
export function loadSearchCache(configPath: string): SearchCacheData | null {
  const cachePath = path.join(configPath, CACHE_FILE);
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as Partial<SearchCacheData>;
    // Shape validation — reject old-format caches (with `fingerprint` instead
    // of `fileMtimes`) and missing fields.
    if (
      !data.fileMtimes ||
      typeof data.fileMtimes !== "object" ||
      !data.index ||
      !Array.isArray(data.docs) ||
      !data.backlinkCounts ||
      !data.outgoingLinks ||
      typeof data.ignoreFingerprint !== "string"
    ) {
      return null;
    }
    // docs[].content must be present: v0.10.0 wrote content-less caches whose
    // warm path ran contentScan over empty content and lost recall (#22). If
    // any entry lacks content we reject here and cold-rebuild in the new format.
    for (const doc of data.docs) {
      if (typeof doc.content !== "string") return null;
    }
    return data as SearchCacheData;
  } catch {
    return null;
  }
}

/**
 * Save search index cache to disk.
 */
export function saveSearchCache(
  configPath: string,
  data: SearchCacheData,
): void {
  fs.writeFileSync(path.join(configPath, CACHE_FILE), JSON.stringify(data));
}
