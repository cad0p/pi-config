import * as fs from "node:fs";
import * as path from "node:path";
import {
  type FileInfo,
  getFileInfo,
  listFiles,
  listFolders,
  resolveFile,
} from "../utils/files.js";
import type { Ignorer } from "../utils/ignore.js";

export type { FileInfo };

export interface FolderInfo {
  path: string;
  files: number;
  folders: number;
  size: number;
}

export function getFileInfoResolved(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): FileInfo {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }
  return getFileInfo(vaultPath, resolved.path);
}

export function getFileList(
  vaultPath: string,
  opts?: { folder?: string; ext?: string },
  ignore?: Ignorer,
): string[] {
  return listFiles(vaultPath, { ...opts, ignore });
}

export function getFolderList(
  vaultPath: string,
  parentFolder?: string,
  ignore?: Ignorer,
): string[] {
  return listFolders(vaultPath, parentFolder, ignore);
}

export function getFolderInfo(
  vaultPath: string,
  folderPath: string,
  ignore?: Ignorer,
): FolderInfo {
  const fullPath = path.join(vaultPath, folderPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    throw new Error(`Folder not found: ${folderPath}`);
  }

  const fileCount = listFiles(vaultPath, {
    folder: folderPath,
    ignore,
  }).length;
  const folderCount = listFolders(vaultPath, folderPath, ignore).length;

  let size = 0;
  const allFiles = listFiles(vaultPath, { folder: folderPath, ignore });
  for (const f of allFiles) {
    size += fs.statSync(path.join(vaultPath, f)).size;
  }

  return { path: folderPath, files: fileCount, folders: folderCount, size };
}
