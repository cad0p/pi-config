import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles, resolveFile } from "../utils/files.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { Ignorer } from "../utils/ignore.js";
import { extractTags } from "../utils/markdown.js";

export interface TagData {
  tagCounts: Map<string, number>;
  tagFiles: Map<string, string[]>;
}

export interface TagInfo {
  tag: string;
  count: number;
  files: string[];
}

export function collectTags(
  vaultPath: string,
  fileFilter?: string,
  ignore?: Ignorer,
): TagData {
  const tagCounts = new Map<string, number>();
  const tagFiles = new Map<string, string[]>();

  const files = fileFilter
    ? (() => {
        const r = resolveFile(vaultPath, fileFilter, ignore);
        return r ? [r.path] : [];
      })()
    : listFiles(vaultPath, { ext: "md", ignore });

  for (const file of files) {
    const content = fs.readFileSync(path.join(vaultPath, file), "utf-8");
    const { properties } = parseFrontmatter(content);
    const inlineTags = extractTags(content);

    const allTags = new Set(inlineTags);
    if (Array.isArray(properties.tags)) {
      for (const t of properties.tags) allTags.add(String(t));
    }

    for (const tag of allTags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      if (!tagFiles.has(tag)) tagFiles.set(tag, []);
      tagFiles.get(tag)?.push(file);
    }
  }

  return { tagCounts, tagFiles };
}

export function getTagInfo(
  vaultPath: string,
  tagName: string,
  ignore?: Ignorer,
): TagInfo {
  const { tagCounts, tagFiles } = collectTags(vaultPath, undefined, ignore);
  return {
    tag: tagName,
    count: tagCounts.get(tagName) || 0,
    files: tagFiles.get(tagName) || [],
  };
}
