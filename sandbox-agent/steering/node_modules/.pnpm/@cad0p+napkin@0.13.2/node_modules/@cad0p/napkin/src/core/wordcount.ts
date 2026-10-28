import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFile } from "../utils/files.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { Ignorer } from "../utils/ignore.js";

export interface WordCount {
  words: number;
  characters: number;
}

export function getWordCount(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): WordCount {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const content = fs.readFileSync(path.join(vaultPath, resolved.path), "utf-8");
  const { body } = parseFrontmatter(content);
  const text = body.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const characters = text.length;

  return { words, characters };
}
