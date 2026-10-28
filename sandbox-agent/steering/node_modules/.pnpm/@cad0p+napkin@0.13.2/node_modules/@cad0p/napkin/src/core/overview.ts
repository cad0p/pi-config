import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../utils/config.js";
import { listFiles } from "../utils/files.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { type Ignorer, loadIgnorer } from "../utils/ignore.js";
import { extractHeadings, extractTags } from "../utils/markdown.js";
import {
  loadOverviewCache,
  saveOverviewCache,
} from "../utils/overview-cache.js";

export interface OverviewFolder {
  path: string;
  notes: number;
  keywords: string[];
  tags: string[];
  /** Number of subfolders rolled up into this row (homogeneous-sibling collapse). */
  collapsedFolders?: number;
}

export interface VaultOverview {
  context?: string;
  overview: OverviewFolder[];
  /** Present only when maxRows capped the listing; rows/notes of dropped entries. */
  truncated?: { rows: number; notes: number };
  warnings?: string[];
}

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HEX_HASH_RE = /\b[a-f0-9]{8,}\b/g;
// Structured noise from imported/converted documents (OCR'd PDFs, DocuSign
// exports, HTML conversions). Stripped before tokenization so ID shrapnel
// ("DAB4-BCF3-..." → "dab", "bcf") never reaches keyword scoring.
const DASHED_HEX_RE = /\b[0-9a-f]{2,}(?:-[0-9a-f]{2,})+\b/gi;
const DIGIT_BLOB_RE = /\b(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{6,}\b/gi;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const HTML_ENTITY_RE = /&[a-z]+;|&#\d+;/gi;
const HEXLETTER_RUN_RE = /\b[a-f]{7,}\b/gi;

// Homogeneous-sibling collapse: parents with at least this many children
// whose term distributions are at least this similar (mean pairwise cosine
// over top terms) are rendered as a single aggregate row. Tuned against a
// corpus of real-world agent vaults — imported document dumps sit at ~0.15–0.25
// similarity, curated folder structures below ~0.05.
const COLLAPSE_MIN_CHILDREN = 5;
const COLLAPSE_SIMILARITY = 0.15;
const COLLAPSE_COSINE_TOP_TERMS = 60;
const COLLAPSE_PAIRWISE_CAP = 20;
const TOKEN_RE = /[a-z]{3,}/g;
const FRONTMATTER_RE = /^---[\s\S]*?---\n?/;
const ATX_HEADING_LINE_RE = /^#{1,6}\s+.+$/gm;
const WIKILINK_ONLY_RE = /^\[\[[^\]]+(?:\|[^\]]+)?\]\]$/;
const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "as",
  "be",
  "was",
  "are",
  "this",
  "that",
  "not",
  "has",
  "have",
  "had",
  "will",
  "can",
  "may",
  "do",
  "does",
  "did",
  "been",
  "being",
  "would",
  "could",
  "should",
  "its",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "we",
  "they",
  "you",
  "he",
  "she",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "about",
  "above",
  "after",
  "again",
  "also",
  "any",
  "because",
  "before",
  "between",
  "down",
  "during",
  "even",
  "first",
  "get",
  "how",
  "if",
  "into",
  "like",
  "made",
  "make",
  "many",
  "much",
  "new",
  "no",
  "now",
  "off",
  "old",
  "only",
  "one",
  "out",
  "over",
  "own",
  "same",
  "so",
  "still",
  "then",
  "there",
  "these",
  "those",
  "through",
  "under",
  "up",
  "use",
  "used",
  "using",
  "want",
  "way",
  "well",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "work",
  "see",
  "here",
  "need",
  "etc",
  "two",
  "next",
  "per",
  "via",
  "vs",
  "yet",
  "ago",
  "due",
  "tbd",
]); // prettier-ignore

interface WeightedTerms {
  /** Term → occurrence count for one source text. */
  counts: Map<string, number>;
  weight: number;
}

interface HeadingSignals {
  lineCount: Map<string, number>;
  weightedTerms: Map<string, number>;
}

interface FolderData {
  tf: Map<string, number>;
  /**
   * Term frequencies from note content (bodies and heading lines, unweighted;
   * no filename or title terms). Used for sibling-collapse similarity so
   * shared naming conventions cannot fake content homogeneity.
   */
  bodyTF: Map<string, number>;
  headingLineCount: Map<string, number>;
  hasNonHeading: Set<string>;
  tags: Set<string>;
  noteCount: number;
}

const DIGIT_RE = /\d/;

/**
 * Each replace is guarded by a necessary condition of its pattern (an email
 * must contain "@", a URL "http", ...) so clean prose skips the expensive
 * regex scans entirely. Guards never change the result: when the guard is
 * false the pattern cannot match. HEX_HASH_RE can skip when no digit remains
 * because HEXLETTER_RUN_RE has already removed pure-letter hex runs ≥7.
 */
function stripNoise(text: string): string {
  let out = text;
  if (out.includes("```")) out = out.replace(CODE_BLOCK_RE, "");
  if (out.includes("`")) out = out.replace(INLINE_CODE_RE, "");
  if (out.includes("http")) out = out.replace(URL_RE, "");
  if (out.includes("@")) out = out.replace(EMAIL_RE, "");
  if (out.includes("<")) out = out.replace(HTML_TAG_RE, " ");
  if (out.includes("&")) out = out.replace(HTML_ENTITY_RE, " ");
  const hasDigit = DIGIT_RE.test(out);
  if (out.includes("-")) out = out.replace(DASHED_HEX_RE, " ");
  if (hasDigit) out = out.replace(DIGIT_BLOB_RE, " ");
  out = out.replace(HEXLETTER_RUN_RE, " ");
  if (hasDigit) out = out.replace(HEX_HASH_RE, "");
  return out;
}

function tokenize(text: string): string[] {
  const cleaned = stripNoise(text);
  return (cleaned.toLowerCase().match(TOKEN_RE) || []).filter(
    (w) => !STOP_WORDS.has(w),
  );
}

/**
 * Term → occurrence count for one text, from a single tokenize() pass.
 * Unigrams are inserted before bigrams, each in first-occurrence order —
 * the same insertion order occurrence-wise accumulation produced, so
 * downstream keyword tie-breaking (stable sort over Map order) is unchanged.
 */
function termCounts(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }
  return counts;
}

/** Merge per-text counts into an accumulator, scaled by an integer weight. */
function mergeCounts(
  target: Map<string, number>,
  counts: Map<string, number>,
  weight: number,
): void {
  for (const [term, count] of counts) {
    target.set(term, (target.get(term) || 0) + count * weight);
  }
}

function addWeightedTerms(
  target: Map<string, number>,
  sourceTerms: Iterable<string>,
  weight: number,
): void {
  for (const term of sourceTerms) {
    target.set(term, (target.get(term) || 0) + weight);
  }
}

function buildTF(sources: WeightedTerms[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const source of sources) {
    mergeCounts(freq, source.counts, source.weight);
  }
  return freq;
}

/** Depth of a folder path: root `/` is 0, `amazon` is 1, `amazon/features` is 2. */
function folderDepth(folder: string): number {
  return folder === "/" ? 0 : folder.split("/").length;
}

function folderKeywordTokens(folderPath: string): Set<string> {
  const tokens = new Set<string>();
  for (const segment of folderPath.split("/")) {
    for (const token of tokenize(segment)) {
      tokens.add(token);
      tokens.add(token.endsWith("s") ? token.slice(0, -1) : `${token}s`);
    }
  }
  return tokens;
}

function shouldSkipOverviewFile(
  file: string,
  folder: string,
  templatesFolder: string,
): boolean {
  const basename = path.basename(file);
  const topLevelFolder = folder === "/" ? "" : folder.split("/")[0];

  return (
    topLevelFolder === templatesFolder ||
    (folder === "/" && basename === "NAPKIN.md") ||
    basename === "_about.md"
  );
}

function frontmatterText(properties: Record<string, unknown>): string[] {
  const values: string[] = [];

  const visit = (value: unknown) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };

  for (const [key, value] of Object.entries(properties)) {
    if (key === "title" || key === "tags") continue;
    visit(value);
  }

  return values.filter((value) => {
    const trimmed = value.trim();
    return (
      trimmed.length > 0 &&
      !WIKILINK_ONLY_RE.test(trimmed) &&
      !ISO_DATE_PREFIX_RE.test(trimmed)
    );
  });
}

function markdownBodyText(content: string): string {
  return content.replace(FRONTMATTER_RE, "").replace(ATX_HEADING_LINE_RE, "");
}

function buildHeadingSignals(
  headingCounts: Iterable<Map<string, number>>,
): HeadingSignals {
  const lineCount = new Map<string, number>();
  const weightedTerms = new Map<string, number>();
  const uniqueTerms = new Set<string>();

  for (const counts of headingCounts) {
    for (const term of counts.keys()) {
      uniqueTerms.add(term);
      lineCount.set(term, (lineCount.get(term) || 0) + 1);
    }
  }

  addWeightedTerms(weightedTerms, uniqueTerms, 3);
  return { lineCount, weightedTerms };
}

function isCandidateKeyword(
  term: string,
  tf: number,
  folderTokens: Set<string>,
  headingLineCount: Map<string, number>,
  hasNonHeading: Set<string>,
): boolean {
  if (term.includes(" ")) {
    const [a, b] = term.split(" ");
    if (tf < 2 || a === b) return false;
  } else if (folderTokens.has(term)) {
    return false;
  }

  // Require corroboration: real keywords either appear outside headings or in
  // multiple heading lines. Single heading-only terms are usually section labels.
  return hasNonHeading.has(term) || (headingLineCount.get(term) || 0) >= 2;
}

function extractKeywordsTFIDF(
  folderTF: Map<string, number>,
  documentFrequency: Map<string, number>,
  totalFolders: number,
  maxKeywords: number,
  folderPath: string,
  headingLineCount: Map<string, number>,
  hasNonHeading: Set<string>,
): string[] {
  const folderTokens = folderKeywordTokens(folderPath);
  const scored: [string, number][] = [];

  for (const [term, tf] of folderTF) {
    if (
      !isCandidateKeyword(
        term,
        tf,
        folderTokens,
        headingLineCount,
        hasNonHeading,
      )
    ) {
      continue;
    }

    const df = documentFrequency.get(term) || 1;
    const idf = Math.log(1 + totalFolders / df);
    scored.push([term, tf * idf]);
  }

  const sorted = scored.sort((a, b) => b[1] - a[1]);
  const selected: string[] = [];
  const suppressed = new Set<string>();

  for (const [term] of sorted) {
    if (selected.length >= maxKeywords) break;
    if (suppressed.has(term)) continue;

    selected.push(term);
    if (term.includes(" ")) {
      for (const part of term.split(" ")) {
        suppressed.add(part);
      }
    }
  }

  return selected;
}

/** Cosine similarity over the top-N terms of two TF maps. */
function tfCosine(a: Map<string, number>, b: Map<string, number>): number {
  const top = (m: Map<string, number>) =>
    new Map(
      [...m.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, COLLAPSE_COSINE_TOP_TERMS),
    );
  const ta = top(a);
  const tb = top(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of ta) na += v * v;
  for (const [, v] of tb) nb += v * v;
  for (const [k, v] of ta) {
    const w = tb.get(k);
    if (w) dot += v * w;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function mergeFolderData(items: FolderData[]): FolderData {
  const tf = new Map<string, number>();
  const bodyTF = new Map<string, number>();
  const headingLineCount = new Map<string, number>();
  const hasNonHeading = new Set<string>();
  const tags = new Set<string>();
  let noteCount = 0;
  for (const d of items) {
    for (const [k, v] of d.tf) tf.set(k, (tf.get(k) || 0) + v);
    for (const [k, v] of d.bodyTF) bodyTF.set(k, (bodyTF.get(k) || 0) + v);
    for (const [k, v] of d.headingLineCount) {
      headingLineCount.set(k, (headingLineCount.get(k) || 0) + v);
    }
    for (const k of d.hasNonHeading) hasNonHeading.add(k);
    for (const t of d.tags) tags.add(t);
    noteCount += d.noteCount;
  }
  return { tf, bodyTF, headingLineCount, hasNonHeading, tags, noteCount };
}

/**
 * Collapse numerous, lexically homogeneous sibling folders into their parent
 * so repetitive subtrees (imported document dumps, per-entity folder fans)
 * render as one aggregate row instead of dominating the overview. The vault
 * root is never a collapse target: top-level folders are the taxonomy.
 * Parents shallower than `collapseDepth` are also skipped, so curated
 * top-level namespaces cannot be absorbed by a similarity artifact.
 */
function collapseHomogeneousSiblings(
  folderData: Map<string, FolderData>,
  collapseDepth: number,
): {
  data: Map<string, FolderData>;
  collapsed: Map<string, number>;
} {
  const byParent = new Map<string, string[]>();
  for (const folder of folderData.keys()) {
    if (folder === "/") continue;
    const idx = folder.lastIndexOf("/");
    const parent = idx === -1 ? "/" : folder.slice(0, idx);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)?.push(folder);
  }

  // Deepest parents first so collapses can cascade upward.
  const parents = [...byParent.keys()].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );

  const data = new Map(folderData);
  const collapsed = new Map<string, number>();

  for (const parent of parents) {
    // Root is depth 0 and always skipped; parents shallower than
    // collapseDepth can never be collapse targets.
    if (parent === "/" || folderDepth(parent) < collapseDepth) continue;
    const children = (byParent.get(parent) || []).filter((c) => data.has(c));
    if (children.length < COLLAPSE_MIN_CHILDREN) continue;

    const cap = Math.min(children.length, COLLAPSE_PAIRWISE_CAP);
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < cap; i++) {
      for (let j = i + 1; j < cap; j++) {
        const a = data.get(children[i]);
        const b = data.get(children[j]);
        if (!a || !b) continue;
        sum += tfCosine(a.bodyTF, b.bodyTF);
        pairs++;
      }
    }
    if (pairs === 0 || sum / pairs < COLLAPSE_SIMILARITY) continue;

    const toMerge: FolderData[] = [];
    let mergedFolderCount = 0;
    for (const child of children) {
      const d = data.get(child);
      if (!d) continue;
      toMerge.push(d);
      mergedFolderCount += 1 + (collapsed.get(child) || 0);
      data.delete(child);
      collapsed.delete(child);
    }
    const existing = data.get(parent);
    const merged = existing
      ? mergeFolderData([existing, ...toMerge])
      : mergeFolderData(toMerge);
    data.set(parent, merged);
    collapsed.set(parent, (collapsed.get(parent) || 0) + mergedFolderCount);
  }

  return { data, collapsed };
}

function groupFilesByFolder(
  files: string[],
  templatesFolder: string,
): Map<string, string[]> {
  const folderFiles = new Map<string, string[]>();

  for (const file of files) {
    const dir = path.dirname(file);
    const folder = dir === "." ? "/" : dir;
    if (shouldSkipOverviewFile(file, folder, templatesFolder)) continue;

    if (!folderFiles.has(folder)) folderFiles.set(folder, []);
    folderFiles.get(folder)?.push(file);
  }

  return folderFiles;
}

function buildFolderData(
  vaultPath: string,
  folderFileList: string[],
  warnings: string[],
): FolderData {
  const allTags = new Set<string>();
  // Term counts per unique heading text (first-seen order), computed once and
  // reused for both bodyTF (per occurrence) and heading signals (per unique).
  const headingCountCache = new Map<string, Map<string, number>>();
  const weightedSources: WeightedTerms[] = [];
  const bodyTF = new Map<string, number>();

  for (const file of folderFileList) {
    const content = fs.readFileSync(path.join(vaultPath, file), "utf-8");
    let properties: Record<string, unknown> = {};

    try {
      ({ properties } = parseFrontmatter(content));
    } catch {
      warnings.push(`Skipping ${file} (malformed YAML frontmatter)`);
      continue;
    }

    for (const tag of extractTags(content)) allTags.add(tag);
    if (Array.isArray(properties.tags)) {
      for (const tag of properties.tags) allTags.add(String(tag));
    }

    const fileHeadings = extractHeadings(content);
    for (const heading of fileHeadings) {
      const key = heading.text.trim();
      let headingCounts = headingCountCache.get(key);
      if (!headingCounts) {
        headingCounts = termCounts(heading.text);
        headingCountCache.set(key, headingCounts);
      }
      mergeCounts(bodyTF, headingCounts, 1);
    }

    weightedSources.push({
      counts: termCounts(path.basename(file, ".md")),
      weight: 2,
    });
    if (properties.title) {
      weightedSources.push({
        counts: termCounts(String(properties.title)),
        weight: 2,
      });
    }
    for (const value of frontmatterText(properties)) {
      weightedSources.push({ counts: termCounts(value), weight: 2 });
    }
    const bodyCounts = termCounts(markdownBodyText(content));
    weightedSources.push({ counts: bodyCounts, weight: 1 });
    mergeCounts(bodyTF, bodyCounts, 1);
  }

  const tf = buildTF(weightedSources);
  const hasNonHeading = new Set(tf.keys());
  const headingSignals = buildHeadingSignals(headingCountCache.values());

  for (const [term, weight] of headingSignals.weightedTerms) {
    tf.set(term, (tf.get(term) || 0) + weight);
  }

  return {
    tf,
    bodyTF,
    headingLineCount: headingSignals.lineCount,
    hasNonHeading,
    tags: allTags,
    noteCount: folderFileList.length,
  };
}

function buildOverviewFolders(
  vaultPath: string,
  maxDepth: number,
  maxKeywords: number,
  templatesFolder: string,
  collapse: boolean,
  collapseDepth: number,
  maxRows: number,
  ignore?: Ignorer,
): { folders: OverviewFolder[]; warnings: string[] } {
  const files = listFiles(vaultPath, { ext: "md", ignore });
  const warnings: string[] = [];
  const folderFiles = groupFilesByFolder(files, templatesFolder);
  let folderData = new Map<string, FolderData>();

  for (const [folder, folderFileList] of folderFiles) {
    if (folderDepth(folder) > maxDepth) continue;

    folderData.set(
      folder,
      buildFolderData(vaultPath, folderFileList, warnings),
    );
  }

  let collapsedCounts = new Map<string, number>();
  if (collapse) {
    const result = collapseHomogeneousSiblings(folderData, collapseDepth);
    folderData = result.data;
    collapsedCounts = result.collapsed;
  }

  const documentFrequency = new Map<string, number>();
  for (const { tf } of folderData.values()) {
    for (const term of tf.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const totalFolders = folderData.size;
  const folders: OverviewFolder[] = [];

  // Upstream default: purely lexical order. Only when a row cap is active
  // (maxRows > 0) does the fork's priority order apply — shallow first, then
  // note count descending, then lexical — so the most informative rows
  // survive the cut. Unset/0 keeps output byte-identical to upstream.
  const entries = [...folderData.entries()].sort((a, b) => {
    if (maxRows > 0) {
      const depthDiff = folderDepth(a[0]) - folderDepth(b[0]);
      if (depthDiff !== 0) return depthDiff;
      if (a[1].noteCount !== b[1].noteCount) {
        return b[1].noteCount - a[1].noteCount;
      }
    }
    return a[0].localeCompare(b[0]);
  });

  for (const [folder, data] of entries) {
    folders.push({
      path: folder,
      notes: data.noteCount,
      keywords: extractKeywordsTFIDF(
        data.tf,
        documentFrequency,
        totalFolders,
        maxKeywords,
        folder,
        data.headingLineCount,
        data.hasNonHeading,
      ),
      tags: [...data.tags].sort(),
      ...(collapsedCounts.has(folder)
        ? { collapsedFolders: collapsedCounts.get(folder) }
        : {}),
    });
  }

  return { folders, warnings };
}

/**
 * Whole-vault fingerprint: file paths + mtimes only. The shared
 * search-cache helper hashes size too (its own tradeoff); the overview
 * cache must treat a frozen-mtime content rewrite as invisible, so it
 * fingerprints independently.
 */
function overviewFingerprint(contentPath: string, ignore?: Ignorer): string {
  const entries: string[] = [];
  for (const file of listFiles(contentPath, { ext: "md", ignore })) {
    const stat = fs.statSync(path.join(contentPath, file));
    entries.push(`${file}:${stat.mtimeMs}`);
  }
  return crypto.createHash("md5").update(entries.join("\n")).digest("hex");
}

export function getOverview(
  contentPath: string,
  configPath: string,
  opts?: {
    depth?: number;
    keywords?: number;
    collapse?: boolean;
    collapseDepth?: number;
    maxRows?: number;
  },
): VaultOverview {
  const config = loadConfig(configPath);
  const { ignorer } = loadIgnorer(contentPath, configPath);
  const maxDepth = opts?.depth ?? config.overview.depth;
  const maxKeywords = opts?.keywords ?? config.overview.keywords;
  const collapse = opts?.collapse ?? config.overview.collapse;
  const collapseDepth = opts?.collapseDepth ?? config.overview.collapseDepth;
  const maxRows = opts?.maxRows ?? config.overview.maxRows;

  // Whole-vault cache: one stat pass instead of reading + tokenizing every
  // note. Any file add/remove/touch changes the fingerprint; NAPKIN.md is a
  // vault .md file, so context changes invalidate too. Resolved options are
  // part of the key because they change the result.
  const fingerprint = overviewFingerprint(contentPath, ignorer);
  const optionsKey = `${maxDepth}|${maxKeywords}|${collapse}|${collapseDepth}|${maxRows}|${config.templates.folder}`;
  const cached = loadOverviewCache<VaultOverview>(
    configPath,
    fingerprint,
    optionsKey,
  );
  if (cached) return cached;

  const { folders, warnings } = buildOverviewFolders(
    contentPath,
    maxDepth,
    maxKeywords,
    config.templates.folder,
    collapse,
    collapseDepth,
    maxRows,
    ignorer,
  );

  const contextPath = path.join(contentPath, "NAPKIN.md");
  const context = fs.existsSync(contextPath)
    ? fs.readFileSync(contextPath, "utf-8").trim()
    : undefined;

  // Row cap (fork extension): maxRows > 0 truncates the listing and reports
  // what was dropped; 0/unset is unlimited (upstream behavior).
  let overview = folders;
  let truncated: { rows: number; notes: number } | undefined;
  if (maxRows > 0 && folders.length > maxRows) {
    overview = folders.slice(0, maxRows);
    const dropped = folders.slice(maxRows);
    truncated = {
      rows: dropped.length,
      notes: dropped.reduce((sum, f) => sum + f.notes, 0),
    };
  }

  const result: VaultOverview = {
    ...(context ? { context } : {}),
    overview,
    ...(truncated ? { truncated } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  saveOverviewCache(configPath, { fingerprint, optionsKey, result });
  return result;
}

// Exported for differential testing against the pre-optimization oracle
// (src/core/__tests__/overview.equivalence.test.ts). Not public API.
export { stripNoise as _stripNoise, termCounts as _termCounts };
