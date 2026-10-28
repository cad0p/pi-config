import { type AliasEntry, collectAliases } from "./core/aliases.js";
import {
  type BaseQueryResult,
  type BaseView,
  createBaseItem,
  getBaseViews,
  listBases,
  queryBaseFile,
  resolveBaseFile,
} from "./core/bases.js";
import {
  addBookmark,
  type Bookmark,
  flattenBookmarks,
  readBookmarks,
} from "./core/bookmarks.js";
import {
  addCanvasEdge,
  addCanvasNode,
  type Canvas,
  createCanvas,
  listCanvases,
  removeCanvasNode,
  resolveCanvas,
} from "./core/canvas.js";
import { getConfigValue, loadConfig, setConfigValue } from "./core/config.js";
import {
  appendFile,
  type CreateOptions,
  type CreateResult,
  createFile,
  type DeleteResult,
  deleteFile,
  type MoveResult,
  moveFile,
  prependFile,
  type ReadOptions,
  type ReadResult,
  readFile,
  renameFile,
} from "./core/crud.js";
import {
  appendDaily,
  ensureDaily,
  getDailyPath,
  prependDaily,
  readDaily,
} from "./core/daily.js";
import {
  type FileInfo,
  type FolderInfo,
  getFileInfoResolved,
  getFileList,
  getFolderInfo,
  getFolderList,
} from "./core/files.js";
import {
  type AddTemplateResult,
  addTemplate,
  getInitTemplates,
  type ScaffoldResult,
  scaffoldVault,
  type TemplateInfo,
} from "./core/init.js";
import {
  getBacklinks,
  getDeadends,
  getOrphans,
  getOutgoingLinks,
  getUnresolvedLinks,
} from "./core/links.js";
import { getOutline } from "./core/outline.js";
import { getOverview, type VaultOverview } from "./core/overview.js";
import {
  collectProperties,
  readProperty,
  removeProperty,
  setProperty,
} from "./core/properties.js";
import {
  type PaginatedSearchResults,
  type SearchOptions,
  type SearchResult,
  searchVault,
  searchVaultPaginated,
} from "./core/search.js";
import { collectTags, getTagInfo, type TagInfo } from "./core/tags.js";
import {
  collectTasks,
  filterTasks,
  showTask,
  type TaskShowResult,
  type TaskWithFile,
  updateTask,
} from "./core/tasks.js";
import {
  insertTemplate,
  listTemplates,
  readTemplate,
} from "./core/templates.js";
import { getVaultMetadata, type VaultMetadata } from "./core/vault.js";
import { getWordCount, type WordCount } from "./core/wordcount.js";
import { registerTemplate } from "./templates/index.js";
import type { VaultTemplate } from "./templates/types.js";
import { type Ignorer, loadIgnorer } from "./utils/ignore.js";
import type { Heading } from "./utils/markdown.js";
import { findVault, type VaultInfo } from "./utils/vault.js";

export class Napkin {
  readonly vault: VaultInfo;

  constructor(path: string) {
    this.vault = findVault(path);
  }

  /** Ignorer for this vault (memoized by fingerprint — cheap on repeat). */
  private ignorer(): Ignorer {
    return loadIgnorer(this.vault.contentPath, this.vault.configPath).ignorer;
  }

  // ── Vault ───────────────────────────────────────────────────────

  info(): VaultMetadata {
    return getVaultMetadata(this.vault);
  }

  overview(opts?: {
    depth?: number;
    keywords?: number;
    collapse?: boolean;
    collapseDepth?: number;
    maxRows?: number;
  }): VaultOverview & { root: string } {
    // Root is attached fresh at the SDK layer, after the (possibly cached)
    // core result — it must never be persisted into the overview cache, or a
    // moved vault would serve a stale root.
    return {
      ...getOverview(this.vault.contentPath, this.vault.configPath, opts),
      root: this.vault.contentPath,
    };
  }

  // ── Search ──────────────────────────────────────────────────────

  search(query: string, opts?: SearchOptions): SearchResult[] {
    return searchVault(
      this.vault.contentPath,
      this.vault.configPath,
      query,
      opts,
    );
  }

  searchPaginated(query: string, opts?: SearchOptions): PaginatedSearchResults {
    return searchVaultPaginated(
      this.vault.contentPath,
      this.vault.configPath,
      query,
      opts,
    );
  }

  // ── CRUD ────────────────────────────────────────────────────────

  read(file: string, opts?: ReadOptions): ReadResult {
    return readFile(this.vault.contentPath, file, opts, this.ignorer());
  }

  create(opts: CreateOptions): CreateResult {
    return createFile(this.vault, opts);
  }

  append(file: string, content: string, inline?: boolean): string {
    return appendFile(
      this.vault.contentPath,
      file,
      content,
      inline,
      this.ignorer(),
    );
  }

  prepend(file: string, content: string, inline?: boolean): string {
    return prependFile(
      this.vault.contentPath,
      file,
      content,
      inline,
      this.ignorer(),
    );
  }

  move(file: string, destination: string): MoveResult {
    return moveFile(this.vault.contentPath, file, destination, this.ignorer());
  }

  rename(file: string, newName: string): MoveResult {
    return renameFile(this.vault.contentPath, file, newName, this.ignorer());
  }

  delete(file: string, permanent?: boolean): DeleteResult {
    return deleteFile(this.vault.contentPath, file, permanent, this.ignorer());
  }

  // ── Files ───────────────────────────────────────────────────────

  fileInfo(file: string): FileInfo {
    return getFileInfoResolved(this.vault.contentPath, file, this.ignorer());
  }

  fileList(opts?: { folder?: string; ext?: string }): string[] {
    return getFileList(this.vault.contentPath, opts, this.ignorer());
  }

  folders(parentFolder?: string): string[] {
    return getFolderList(this.vault.contentPath, parentFolder, this.ignorer());
  }

  folderInfo(folderPath: string): FolderInfo {
    return getFolderInfo(this.vault.contentPath, folderPath, this.ignorer());
  }

  outline(file: string): Heading[] {
    return getOutline(this.vault.contentPath, file, this.ignorer());
  }

  wordcount(file: string): WordCount {
    return getWordCount(this.vault.contentPath, file, this.ignorer());
  }

  // ── Daily ───────────────────────────────────────────────────────

  dailyPath(date?: Date): string {
    return getDailyPath(this.vault.configPath, date);
  }

  dailyEnsure(): { path: string; created: boolean } {
    return ensureDaily(this.vault);
  }

  dailyRead(): { path: string; content: string } {
    return readDaily(this.vault);
  }

  dailyAppend(content: string, inline?: boolean): string {
    return appendDaily(this.vault, content, inline);
  }

  dailyPrepend(content: string, inline?: boolean): string {
    return prependDaily(this.vault, content, inline);
  }

  // ── Tags ────────────────────────────────────────────────────────

  tags(fileFilter?: string): {
    tagCounts: Map<string, number>;
    tagFiles: Map<string, string[]>;
  } {
    return collectTags(this.vault.contentPath, fileFilter, this.ignorer());
  }

  tagInfo(tagName: string): TagInfo {
    return getTagInfo(this.vault.contentPath, tagName, this.ignorer());
  }

  // ── Aliases ─────────────────────────────────────────────────────

  aliases(fileFilter?: string): AliasEntry[] {
    return collectAliases(this.vault.contentPath, fileFilter, this.ignorer());
  }

  // ── Properties ──────────────────────────────────────────────────

  properties(fileFilter?: string): Map<string, number> {
    return collectProperties(
      this.vault.contentPath,
      fileFilter,
      this.ignorer(),
    );
  }

  propertyGet(
    file: string,
    name: string,
  ): { property: string; value: unknown } {
    return readProperty(this.vault.contentPath, file, name, this.ignorer());
  }

  propertySet(
    file: string,
    name: string,
    value: string,
  ): { path: string; property: string; value: unknown } {
    return setProperty(
      this.vault.contentPath,
      file,
      name,
      value,
      this.ignorer(),
    );
  }

  propertyRemove(
    file: string,
    name: string,
  ): { path: string; removed: string } {
    return removeProperty(this.vault.contentPath, file, name, this.ignorer());
  }

  // ── Tasks ───────────────────────────────────────────────────────

  tasks(opts?: {
    file?: string;
    daily?: boolean;
    done?: boolean;
    todo?: boolean;
    status?: string;
  }): TaskWithFile[] {
    const all = collectTasks(this.vault, {
      file: opts?.file,
      daily: opts?.daily,
    });
    return filterTasks(all, {
      done: opts?.done,
      todo: opts?.todo,
      status: opts?.status,
    });
  }

  taskShow(
    file: string,
    line: number,
  ): { currentStatus: string; text: string } {
    return showTask(this.vault.contentPath, file, line);
  }

  taskUpdate(file: string, line: number, newStatus: string): TaskShowResult {
    return updateTask(this.vault.contentPath, file, line, newStatus);
  }

  // ── Links ───────────────────────────────────────────────────────

  linksOut(file: string): string[] {
    return getOutgoingLinks(this.vault.contentPath, file, this.ignorer());
  }

  linksBack(file: string): string[] {
    return getBacklinks(this.vault.contentPath, file, this.ignorer());
  }

  linksUnresolved(): [string, string[]][] {
    return getUnresolvedLinks(this.vault.contentPath, this.ignorer());
  }

  orphans(): string[] {
    return getOrphans(this.vault.contentPath, this.ignorer());
  }

  deadends(): string[] {
    return getDeadends(this.vault.contentPath, this.ignorer());
  }

  // ── Templates ───────────────────────────────────────────────────

  templates(): string[] {
    return listTemplates(this.vault);
  }

  templateRead(
    name: string,
    opts?: { resolve?: boolean; title?: string },
  ): { template: string; content: string } {
    return readTemplate(this.vault, name, opts);
  }

  templateInsert(
    templateName: string,
    file: string,
  ): { file: string; template: string; inserted: boolean } {
    return insertTemplate(this.vault, templateName, file);
  }

  // ── Bookmarks ───────────────────────────────────────────────────

  bookmarks(): Bookmark[] {
    const items = readBookmarks(this.vault.obsidianPath);
    return flattenBookmarks(items);
  }

  bookmarkAdd(entry: Bookmark): { added: Bookmark } {
    return addBookmark(this.vault.obsidianPath, entry);
  }

  // ── Config ──────────────────────────────────────────────────────

  config(): Record<string, unknown> {
    return loadConfig(this.vault.configPath) as unknown as Record<
      string,
      unknown
    >;
  }

  configGet(key: string): unknown {
    return getConfigValue(this.vault.configPath, key);
  }

  configSet(
    key: string,
    value: string,
  ): { config: Record<string, unknown>; parsed: unknown } {
    return setConfigValue(this.vault.configPath, key, value);
  }

  // ── Bases ───────────────────────────────────────────────────────

  bases(): string[] {
    return listBases(this.vault.contentPath, this.ignorer());
  }

  baseViews(opts: { file?: string; path?: string }): BaseView[] {
    const baseFile = resolveBaseFile(
      this.vault.contentPath,
      opts,
      this.ignorer(),
    );
    if (!baseFile) throw new Error("Base file not found");
    return getBaseViews(this.vault.contentPath, baseFile);
  }

  async baseQuery(
    opts: { file?: string; path?: string },
    viewName?: string,
  ): Promise<BaseQueryResult> {
    const baseFile = resolveBaseFile(
      this.vault.contentPath,
      opts,
      this.ignorer(),
    );
    if (!baseFile) throw new Error("Base file not found");
    return queryBaseFile(
      this.vault.contentPath,
      baseFile,
      viewName,
      this.ignorer(),
    );
  }

  baseCreate(opts: { name: string; path?: string; content?: string }): {
    path: string;
    created: boolean;
  } {
    return createBaseItem(this.vault.contentPath, opts);
  }

  // ── Canvas ──────────────────────────────────────────────────────

  canvases(): string[] {
    return listCanvases(this.vault.contentPath, this.ignorer());
  }

  canvasRead(file: string): { canvas: Canvas; filePath: string } {
    return resolveCanvas(this.vault.contentPath, file, this.ignorer());
  }

  canvasCreate(
    fileName: string,
    folder?: string,
  ): { path: string; created: boolean } {
    return createCanvas(this.vault.contentPath, fileName, folder);
  }

  canvasAddNode(
    file: string,
    opts: {
      type?: string;
      text?: string;
      noteFile?: string;
      subpath?: string;
      url?: string;
      label?: string;
      x?: string;
      y?: string;
      width?: string;
      height?: string;
      color?: string;
    },
  ): { id: string; type: string; added: boolean } {
    return addCanvasNode(this.vault.contentPath, file, opts, this.ignorer());
  }

  canvasAddEdge(
    file: string,
    opts: {
      from: string;
      to: string;
      fromSide?: string;
      toSide?: string;
      label?: string;
      color?: string;
    },
  ): { id: string; from: string; to: string; added: boolean } {
    return addCanvasEdge(this.vault.contentPath, file, opts, this.ignorer());
  }

  canvasRemoveNode(
    file: string,
    nodeId: string,
  ): { id: string; removed: boolean } {
    return removeCanvasNode(
      this.vault.contentPath,
      file,
      nodeId,
      this.ignorer(),
    );
  }

  // ── Init (static) ──────────────────────────────────────────────

  static scaffold(path: string, opts?: { template?: string }): ScaffoldResult {
    return scaffoldVault(path, opts?.template);
  }

  static vaultTemplates(): TemplateInfo[] {
    return getInitTemplates();
  }

  static registerTemplate(template: VaultTemplate): void {
    registerTemplate(template);
  }

  static addTemplate(path: string, template: string): AddTemplateResult {
    return addTemplate(path, template);
  }
}
