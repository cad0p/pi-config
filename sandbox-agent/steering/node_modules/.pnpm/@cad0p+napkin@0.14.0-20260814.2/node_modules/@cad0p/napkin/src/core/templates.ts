import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../utils/config.js";
import { listFiles, resolveFile } from "../utils/files.js";
import { loadIgnorer } from "../utils/ignore.js";
import type { VaultInfo } from "../utils/vault.js";

function getTemplateFolder(configPath: string): string {
  const config = loadConfig(configPath);
  return config.templates.folder;
}

export function listTemplates(v: VaultInfo): string[] {
  const folder = getTemplateFolder(v.configPath);
  const { ignorer: ignore } = loadIgnorer(v.contentPath, v.configPath);
  return listFiles(v.contentPath, { folder, ext: "md", ignore }).map((f) =>
    path.basename(f, ".md"),
  );
}

function resolveVariables(content: string, title?: string): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return content
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{title\}\}/g, title || "Untitled");
}

export function readTemplate(
  v: VaultInfo,
  name: string,
  opts?: { resolve?: boolean; title?: string },
): { template: string; content: string } {
  const folder = getTemplateFolder(v.configPath);
  const { ignorer: ignore } = loadIgnorer(v.contentPath, v.configPath);
  const resolved =
    resolveFile(v.contentPath, `${folder}/${name}`, ignore) ||
    resolveFile(v.contentPath, name, ignore);
  if (!resolved) {
    const templateFiles = listFiles(v.contentPath, {
      folder,
      ext: "md",
      ignore,
    }).map((f) => path.basename(f, ".md"));
    throw new Error(
      `Template not found: ${name}. Available: ${templateFiles.slice(0, 3).join(", ")}`,
    );
  }

  let content = fs.readFileSync(
    path.join(v.contentPath, resolved.path),
    "utf-8",
  );

  if (opts?.resolve) {
    content = resolveVariables(content, opts.title);
  }

  return { template: name, content };
}

export function insertTemplate(
  v: VaultInfo,
  templateName: string,
  fileRef: string,
): { file: string; template: string; inserted: boolean } {
  const folder = getTemplateFolder(v.configPath);
  const { ignorer: ignore } = loadIgnorer(v.contentPath, v.configPath);
  const templateResolved =
    resolveFile(v.contentPath, `${folder}/${templateName}`, ignore) ||
    resolveFile(v.contentPath, templateName, ignore);
  if (!templateResolved) {
    const templateFiles = listFiles(v.contentPath, {
      folder,
      ext: "md",
      ignore,
    }).map((f) => path.basename(f, ".md"));
    throw new Error(
      `Template not found: ${templateName}. Available: ${templateFiles.slice(0, 3).join(", ")}`,
    );
  }

  const targetResolved = resolveFile(v.contentPath, fileRef, ignore);
  if (!targetResolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const title = path.basename(targetResolved.path, ".md");
  let templateContent = fs.readFileSync(
    path.join(v.contentPath, templateResolved.path),
    "utf-8",
  );
  templateContent = resolveVariables(templateContent, title);

  const targetPath = path.join(v.contentPath, targetResolved.path);
  const existing = fs.readFileSync(targetPath, "utf-8");
  fs.writeFileSync(targetPath, existing + templateContent);

  return { file: targetResolved.path, template: templateName, inserted: true };
}
