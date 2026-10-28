import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles, resolveFile } from "../utils/files.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { Ignorer } from "../utils/ignore.js";

export interface AliasEntry {
  alias: string;
  file: string;
}

export function collectAliases(
  vaultPath: string,
  fileFilter?: string,
  ignore?: Ignorer,
): AliasEntry[] {
  const files = fileFilter
    ? (() => {
        const r = resolveFile(vaultPath, fileFilter, ignore);
        return r ? [r.path] : [];
      })()
    : listFiles(vaultPath, { ext: "md", ignore });

  const results: AliasEntry[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(vaultPath, file), "utf-8");
    const { properties } = parseFrontmatter(content);
    const aliases = properties.aliases;
    if (Array.isArray(aliases)) {
      for (const a of aliases) results.push({ alias: String(a), file });
    } else if (typeof aliases === "string" && aliases) {
      results.push({ alias: aliases, file });
    }
  }
  return results;
}
