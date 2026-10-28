import * as fs from "node:fs";
import * as path from "node:path";
import { buildDatabase, parseBaseFile, queryBase } from "../utils/bases.js";
import { listFiles } from "../utils/files.js";
import type { Ignorer } from "../utils/ignore.js";

export interface BaseView {
  name: string;
  type: string;
}

export interface BaseQueryResult {
  columns: string[];
  rows: unknown[][];
  displayNames?: Record<string, string>;
  groups?: { key: string; rows: unknown[][] }[];
  summaries?: Record<string, unknown>;
}

export function listBases(vaultPath: string, ignore?: Ignorer): string[] {
  return listFiles(vaultPath, { ignore }).filter((f) => f.endsWith(".base"));
}

export function resolveBaseFile(
  vaultPath: string,
  opts: { file?: string; path?: string },
  ignore?: Ignorer,
): string | null {
  if (opts.path) {
    const p = opts.path.endsWith(".base") ? opts.path : `${opts.path}.base`;
    if (fs.existsSync(path.join(vaultPath, p))) return p;
    return null;
  }
  if (opts.file) {
    const allFiles = listFiles(vaultPath, { ignore }).filter((f) =>
      f.endsWith(".base"),
    );
    const target = opts.file.toLowerCase();
    for (const f of allFiles) {
      const basename = path.basename(f, ".base").toLowerCase();
      if (basename === target) return f;
    }
    const withExt = opts.file.endsWith(".base")
      ? opts.file
      : `${opts.file}.base`;
    if (fs.existsSync(path.join(vaultPath, withExt))) return withExt;
    return null;
  }
  return null;
}

export function getBaseViews(vaultPath: string, baseFile: string): BaseView[] {
  const content = fs.readFileSync(path.join(vaultPath, baseFile), "utf-8");
  const config = parseBaseFile(content);
  return (config.views || []).map((view) => ({
    name: view.name || "(unnamed)",
    type: view.type,
  }));
}

export async function queryBaseFile(
  vaultPath: string,
  baseFile: string,
  viewName?: string,
  ignore?: Ignorer,
): Promise<BaseQueryResult> {
  const content = fs.readFileSync(path.join(vaultPath, baseFile), "utf-8");
  const config = parseBaseFile(content);
  const db = await buildDatabase(vaultPath, ignore);
  try {
    const thisFile = {
      name: path.basename(baseFile),
      path: baseFile,
      folder: path.dirname(baseFile),
    };
    const result = await queryBase(db, config, viewName, thisFile);
    return result;
  } finally {
    db.close();
  }
}

export function createBaseItem(
  vaultPath: string,
  opts: { name: string; path?: string; content?: string },
): { path: string; created: boolean } {
  const targetPath = opts.path
    ? opts.path.endsWith(".md")
      ? opts.path
      : `${opts.path}/${opts.name}.md`
    : `${opts.name}.md`;

  const fullPath = path.join(vaultPath, targetPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, opts.content || "");

  return { path: targetPath, created: true };
}
