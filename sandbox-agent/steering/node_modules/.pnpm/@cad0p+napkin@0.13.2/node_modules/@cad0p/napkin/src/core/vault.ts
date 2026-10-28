import * as fs from "node:fs";
import { listFiles, listFolders, walkDir } from "../utils/files.js";
import { type Ignorer, loadIgnorer } from "../utils/ignore.js";
import type { VaultInfo } from "../utils/vault.js";

export interface VaultMetadata {
  name: string;
  path: string;
  files: number;
  folders: number;
  size: number;
}

function getVaultSize(vaultPath: string, ignore?: Ignorer): number {
  let total = 0;
  walkDir(vaultPath, {
    onEntry: (fullPath, _entry, kind) => {
      if (kind !== "file") return;
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        // Entry disappeared between readdir and stat — skip.
      }
    },
    // Direct walkDir call: root === vaultPath, so relToRoot IS vault-relative.
    // Dirs get a trailing "/" so dir-only gitignore patterns match them.
    ignore: ignore
      ? (relToRoot, kind) =>
          ignore.ignores(kind === "dir" ? `${relToRoot}/` : relToRoot)
      : undefined,
  });
  return total;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getVaultMetadata(v: VaultInfo): VaultMetadata {
  const { ignorer: ignore } = loadIgnorer(v.contentPath, v.configPath);
  const files = listFiles(v.contentPath, { ignore });
  const folders = listFolders(v.contentPath, undefined, ignore);
  const size = getVaultSize(v.contentPath, ignore);

  return {
    name: v.name,
    path: v.contentPath,
    files: files.length,
    folders: folders.length,
    size,
  };
}
