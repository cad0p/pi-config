import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../utils/config.js";
import { listFiles, resolveFile } from "../utils/files.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { type Ignorer, loadIgnorer } from "../utils/ignore.js";
import { extractSection } from "../utils/markdown.js";
import type { VaultInfo } from "../utils/vault.js";

/**
 * Default page size for `readFile` pagination, in bytes.
 *
 * 50KB is large enough to hold a typical section or a moderate file in a
 * single page, while keeping the per-call token cost bounded for AI agents.
 * Empirically, 50KB is ~12,500 tokens — well within typical AI tool-result
 * budgets (e.g., Pi's native edit tool accepts ~200KB of context).
 */
const DEFAULT_READ_PAGE_SIZE_BYTES = 50000;

export interface ReadOptions {
  section?: string;
  page?: number;
  pageSize?: number;
}

export interface ReadResult {
  path: string;
  content: string;
  totalPages?: number;
  currentPage?: number;
}

export interface CreateOptions {
  name?: string;
  path?: string;
  content?: string;
  template?: string;
  overwrite?: boolean;
}

export interface CreateResult {
  path: string;
  created: boolean;
}

export interface MoveResult {
  from: string;
  to: string;
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  permanent: boolean;
}

export function readFile(
  vaultPath: string,
  fileRef: string,
  opts?: ReadOptions,
  ignore?: Ignorer,
): ReadResult {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  let content = fs.readFileSync(path.join(vaultPath, resolved.path), "utf-8");

  const section = opts?.section ?? resolved.heading;
  if (section) {
    content = extractSection(content, section);
  }

  const pageSize = opts?.pageSize ?? DEFAULT_READ_PAGE_SIZE_BYTES;
  if (content.length <= pageSize) {
    return { path: resolved.path, content };
  }

  // Reserve room for the always-appended suffix (page hint + outline nudge)
  // so paginated page output never exceeds the advertised page size. The
  // initial reserve covers page counts up to 6 digits (files > ~50GB at the
  // default page size); for tiny page sizes the suffix rides on top
  // (unchanged behavior).
  const MAX_PAGE_HINT =
    "\n\n[Page 999999 of 999999. Use --page 1000000 to continue.]";
  const NUDGE =
    "\n\nHINT: Use napkin outline --file <file> to see its structure.";
  // Worst-case page-hint length for `digits`-digit page counts: the hint is
  // longest when the current page is all 9s and the next page rolls over to
  // one more digit ("…Page 999999 of 1000000. Use --page 1000000…"), i.e.
  // 39 + 3·digits chars. The 6-digit constant above (58 chars) covers this
  // exactly for page counts ≤ 999999 (worst hint there is 57 chars:
  // "…Page 999998 of 999999. Use --page 999999…").
  const worstPageHintLen = (digits: number): number => 39 + 3 * digits;

  let chunkBudget =
    pageSize > MAX_PAGE_HINT.length + NUDGE.length
      ? pageSize - MAX_PAGE_HINT.length - NUDGE.length
      : pageSize;
  let totalPages = Math.ceil(content.length / chunkBudget);
  // The 6-digit MAX_PAGE_HINT reserve silently under-reserves by 1+ chars
  // once totalPages rolls past 999999 ("…Page 999999 of 1000000…" is 59
  // chars), which would emit pageSize+1 output on files > ~50GB. Recompute
  // the budget with the exact worst-case hint for the actual page-count
  // magnitude. Page counts only grow when the budget shrinks, so the digit
  // count is non-decreasing and bounded by digits(content.length)+1 — the
  // loop terminates in ≤ that many passes (2 for any realistic file).
  for (
    let digits = String(totalPages).length;
    digits > 6;
    digits = String(totalPages).length
  ) {
    const budget =
      pageSize > worstPageHintLen(digits) + NUDGE.length
        ? pageSize - worstPageHintLen(digits) - NUDGE.length
        : pageSize;
    if (budget === chunkBudget) break;
    chunkBudget = budget;
    totalPages = Math.ceil(content.length / chunkBudget);
  }
  const page = opts?.page ?? 1;

  if (page < 1 || page > totalPages) {
    throw new Error(`Invalid page: ${page}. Valid range: 1-${totalPages}`);
  }

  const start = (page - 1) * chunkBudget;
  const end = Math.min(start + chunkBudget, content.length);
  const chunk = content.slice(start, end);

  const pageHint =
    page < totalPages
      ? `\n\n[Page ${page} of ${totalPages}. Use --page ${page + 1} to continue.]`
      : "";
  const suffix = `${pageHint}${NUDGE}`;

  return {
    path: resolved.path,
    content: chunk + suffix,
    totalPages,
    currentPage: page,
  };
}

export function createFile(v: VaultInfo, opts: CreateOptions): CreateResult {
  const { ignorer: ignore } = loadIgnorer(v.contentPath, v.configPath);
  let targetPath: string;
  if (opts.path) {
    targetPath = opts.path.endsWith(".md") ? opts.path : `${opts.path}.md`;
  } else {
    const name = opts.name || "Untitled";
    targetPath = `${name}.md`;
  }

  const fullPath = path.join(v.contentPath, targetPath);

  if (fs.existsSync(fullPath) && !opts.overwrite) {
    throw new Error(
      `File already exists: ${targetPath}. Use --overwrite to replace.`,
    );
  }

  let content = opts.content || "";

  if (opts.template) {
    const config = loadConfig(v.configPath);
    const templateRef =
      resolveFile(v.contentPath, opts.template, ignore) ||
      resolveFile(
        v.contentPath,
        `${config.templates.folder}/${opts.template}`,
        ignore,
      );
    if (templateRef) {
      content = fs.readFileSync(
        path.join(v.contentPath, templateRef.path),
        "utf-8",
      );
    } else {
      const tmplFiles = listFiles(v.contentPath, {
        folder: config.templates.folder,
        ext: "md",
        ignore,
      }).map((f: string) => path.basename(f, ".md"));
      throw new Error(
        `Template not found: ${opts.template}. Available: ${tmplFiles.slice(0, 3).join(", ")}`,
      );
    }
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);

  return { path: targetPath, created: true };
}

export function appendFile(
  vaultPath: string,
  fileRef: string,
  content: string,
  inline?: boolean,
  ignore?: Ignorer,
): string {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);
  const existing = fs.readFileSync(fullPath, "utf-8");
  const separator = inline ? "" : "\n";
  fs.writeFileSync(fullPath, existing + separator + content);

  return resolved.path;
}

export function prependFile(
  vaultPath: string,
  fileRef: string,
  content: string,
  inline?: boolean,
  ignore?: Ignorer,
): string {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);
  const existing = fs.readFileSync(fullPath, "utf-8");
  const separator = inline ? "" : "\n";

  const { properties, body, raw } = parseFrontmatter(existing);
  if (Object.keys(properties).length > 0) {
    const frontmatter = `---\n${raw}\n---\n`;
    fs.writeFileSync(fullPath, frontmatter + content + separator + body);
  } else {
    fs.writeFileSync(fullPath, content + separator + existing);
  }

  return resolved.path;
}

export function moveFile(
  vaultPath: string,
  fileRef: string,
  destination: string,
  ignore?: Ignorer,
): MoveResult {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  let destPath = destination;
  if (!destPath.endsWith(".md")) {
    destPath = path.join(destPath, path.basename(resolved.path));
  }

  const srcFull = path.join(vaultPath, resolved.path);
  const destFull = path.join(vaultPath, destPath);
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.renameSync(srcFull, destFull);

  return { from: resolved.path, to: destPath };
}

export function renameFile(
  vaultPath: string,
  fileRef: string,
  newName: string,
  ignore?: Ignorer,
): MoveResult {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const name = newName.endsWith(".md") ? newName : `${newName}.md`;
  const destPath = path.join(path.dirname(resolved.path), name);
  const srcFull = path.join(vaultPath, resolved.path);
  const destFull = path.join(vaultPath, destPath);
  fs.renameSync(srcFull, destFull);

  return { from: resolved.path, to: destPath };
}

export function deleteFile(
  vaultPath: string,
  fileRef: string,
  permanent?: boolean,
  ignore?: Ignorer,
): DeleteResult {
  const resolved = resolveFile(vaultPath, fileRef, ignore);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);

  if (permanent) {
    fs.unlinkSync(fullPath);
  } else {
    const trashDir = path.join(vaultPath, ".trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const trashPath = path.join(trashDir, path.basename(resolved.path));
    fs.renameSync(fullPath, trashPath);
  }

  return { path: resolved.path, deleted: true, permanent: !!permanent };
}
