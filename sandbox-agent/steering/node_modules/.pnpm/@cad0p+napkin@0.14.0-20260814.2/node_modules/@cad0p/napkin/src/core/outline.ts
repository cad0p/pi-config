import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFile } from "../utils/files.js";
import type { Ignorer } from "../utils/ignore.js";
import { extractHeadings, type Heading } from "../utils/markdown.js";

export type { Heading };

export function getOutline(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): Heading[] {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const content = fs.readFileSync(path.join(vaultPath, resolved.path), "utf-8");
  return extractHeadings(content);
}
