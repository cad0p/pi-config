import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import initSqlJs, { type Database } from "sql.js";
import { listFiles } from "./files.js";
import { createFormulaEngine, evaluateFormulas } from "./formula.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { Ignorer } from "./ignore.js";
import { extractLinks, extractTags } from "./markdown.js";

export interface BaseView {
  type: string;
  name?: string;
  limit?: number;
  filters?: unknown;
  order?: string[];
  groupBy?: { property: string; direction?: string };
  summaries?: Record<string, string>;
}

export interface BaseConfig {
  filters?: unknown;
  formulas?: Record<string, string>;
  properties?: Record<string, { displayName?: string }>;
  summaries?: Record<string, string>;
  views?: BaseView[];
}

/**
 * Parse a .base YAML file. Bases are YAML format.
 */
export function parseBaseFile(content: string): BaseConfig {
  return yaml.load(content) as BaseConfig;
}

/**
 * Build an in-memory SQLite database from vault files.
 * Creates a `files` table with columns for file metadata and all frontmatter properties.
 */
export async function buildDatabase(
  vaultPath: string,
  ignore?: Ignorer,
): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  const files = listFiles(vaultPath, { ext: "md", ignore });

  // First pass: collect all property names across the vault
  const allProps = new Set<string>();
  const fileData: {
    path: string;
    name: string;
    basename: string;
    folder: string;
    ext: string;
    size: number;
    ctime: number;
    mtime: number;
    tags: string;
    links: string;
    properties: Record<string, unknown>;
  }[] = [];

  for (const file of files) {
    const fullPath = path.join(vaultPath, file);
    const stat = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const { properties } = parseFrontmatter(content);
    const tags = extractTags(content);
    const linkInfo = extractLinks(content);

    // Also get frontmatter tags
    if (Array.isArray(properties.tags)) {
      for (const t of properties.tags) tags.push(String(t));
    }

    for (const key of Object.keys(properties)) {
      if (key !== "tags") allProps.add(key);
    }

    fileData.push({
      path: file,
      name: path.basename(file),
      basename: path.basename(file, path.extname(file)),
      folder: path.dirname(file),
      ext: path.extname(file).slice(1),
      size: stat.size,
      ctime: stat.birthtimeMs,
      mtime: stat.mtimeMs,
      tags: JSON.stringify([...new Set(tags)]),
      links: JSON.stringify(linkInfo.wikilinks),
      properties,
    });
  }

  // Create table with file columns + property columns
  const propCols = [...allProps].map((p) => `"prop_${p}" TEXT`).join(", ");
  const createSQL = `CREATE TABLE files (
    path TEXT PRIMARY KEY,
    name TEXT,
    basename TEXT,
    folder TEXT,
    ext TEXT,
    size INTEGER,
    ctime REAL,
    mtime REAL,
    tags TEXT,
    links TEXT,
    backlinks TEXT,
    embeds TEXT,
    file_properties TEXT
    ${propCols ? `, ${propCols}` : ""}
  )`;
  db.run(createSQL);

  // Register REGEXP function for regex filter support
  db.create_function("REGEXP", (pattern: string, value: string) => {
    try {
      return new RegExp(pattern).test(value ?? "") ? 1 : 0;
    } catch {
      return 0;
    }
  });

  // Insert data
  // Compute backlinks: for each file, find which other files link to it
  const backlinkMap = new Map<string, string[]>();
  for (const f of fileData) {
    backlinkMap.set(f.path, []);
  }
  for (const f of fileData) {
    const links: string[] = JSON.parse(f.links);
    for (const link of links) {
      // Find target file by basename match (case-insensitive, like wikilinks)
      const linkLower = link.toLowerCase();
      for (const target of fileData) {
        if (
          target.basename.toLowerCase() === linkLower ||
          target.name.toLowerCase() === linkLower ||
          target.name.toLowerCase() === `${linkLower}.md`
        ) {
          const bl = backlinkMap.get(target.path) || [];
          bl.push(f.basename);
          backlinkMap.set(target.path, bl);
        }
      }
    }
  }

  // Extract embeds
  const embedRegex = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  const propNames = [...allProps];
  // 13 base columns + N prop columns
  const placeholders = [
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    ...propNames.map(() => "?"),
  ].join(", ");
  const insertSQL = `INSERT INTO files VALUES (${placeholders})`;

  for (const f of fileData) {
    const propValues = propNames.map((p) => {
      const v = f.properties[p];
      if (v === undefined || v === null) return null;
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    });

    const backlinks = JSON.stringify(backlinkMap.get(f.path) || []);

    // Extract embeds from content
    const fullPath = path.join(vaultPath, f.path);
    const content = fs.readFileSync(fullPath, "utf-8");
    const embeds: string[] = [];
    for (
      let em = embedRegex.exec(content);
      em !== null;
      em = embedRegex.exec(content)
    ) {
      embeds.push(em[1]);
    }
    embedRegex.lastIndex = 0;

    const fileProps = JSON.stringify(f.properties);

    db.run(insertSQL, [
      f.path,
      f.name,
      f.basename,
      f.folder,
      f.ext,
      f.size,
      f.ctime,
      f.mtime,
      f.tags,
      f.links,
      backlinks,
      JSON.stringify(embeds),
      fileProps,
      ...propValues,
    ]);
  }

  return db;
}

/**
 * Translate a Bases filter expression to SQL WHERE clause.
 * Handles the recursive and/or/not structure and simple comparison strings.
 */
export function filterToSQL(
  filter: unknown,
  thisFile?: { name: string; path: string; folder: string },
): string {
  if (!filter) return "1=1";

  if (typeof filter === "string") {
    return translateExpression(filter, thisFile);
  }

  if (typeof filter === "object" && filter !== null) {
    const obj = filter as Record<string, unknown>;

    if (obj.and) {
      const clauses = (obj.and as unknown[]).map((f) =>
        filterToSQL(f, thisFile),
      );
      return `(${clauses.join(" AND ")})`;
    }
    if (obj.or) {
      const clauses = (obj.or as unknown[]).map((f) =>
        filterToSQL(f, thisFile),
      );
      return `(${clauses.join(" OR ")})`;
    }
    if (obj.not) {
      const clauses = (obj.not as unknown[]).map((f) =>
        filterToSQL(f, thisFile),
      );
      return `NOT (${clauses.join(" AND ")})`;
    }
  }

  return "1=1";
}

/**
 * Translate a single filter expression string to SQL.
 * e.g. 'status != "done"' -> "prop_status != 'done'"
 * e.g. 'file.hasTag("book")' -> "tags LIKE '%\"book\"%'"
 */
function translateExpression(
  expr: string,
  thisFile?: { name: string; path: string; folder: string },
): string {
  expr = expr.trim();

  // Replace this.file.* references with literal values
  if (thisFile && expr.includes("this.")) {
    expr = expr
      .replace(/this\.file\.name/g, `"${thisFile.name}"`)
      .replace(/this\.file\.path/g, `"${thisFile.path}"`)
      .replace(/this\.file\.folder/g, `"${thisFile.folder}"`)
      .replace(/this\.file/g, `"${thisFile.path}"`);
  }

  // Handle ! prefix (NOT)
  if (expr.startsWith("!") && !expr.startsWith("!=")) {
    return `NOT (${translateExpression(expr.slice(1).trim(), thisFile)})`;
  }

  // Handle inline && and || (split respecting parentheses)
  const splitByBoolOp = splitOnBooleanOps(expr, thisFile);
  if (splitByBoolOp) {
    return splitByBoolOp;
  }

  // file.hasTag("tag1", "tag2") -> OR match on tags JSON array
  const hasTagMatch = expr.match(/^file\.hasTag\((.+)\)$/);
  if (hasTagMatch) {
    const args = parseStringArgs(hasTagMatch[1]);
    const clauses = args.map((t) => `tags LIKE '%"${escapeSql(t)}"%'`);
    return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
  }

  // file.hasLink("target")
  const hasLinkMatch = expr.match(/^file\.hasLink\((.+)\)$/);
  if (hasLinkMatch) {
    const args = parseStringArgs(hasLinkMatch[1]);
    const clauses = args.map((l) => `links LIKE '%"${escapeSql(l)}"%'`);
    return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
  }

  // file.inFolder("folder")
  const inFolderMatch = expr.match(/^file\.inFolder\("([^"]+)"\)$/);
  if (inFolderMatch) {
    const folder = inFolderMatch[1];
    return `(folder = '${escapeSql(folder)}' OR folder LIKE '${escapeSql(folder)}/%')`;
  }

  // file.hasProperty("name")
  const hasPropMatch = expr.match(/^file\.hasProperty\("([^"]+)"\)$/);
  if (hasPropMatch) {
    return `"prop_${escapeSql(hasPropMatch[1])}" IS NOT NULL`;
  }

  // prop.contains("value") — string LIKE
  const containsMatch = expr.match(/^(.+?)\.contains\((.+)\)$/);
  if (containsMatch && !containsMatch[1].startsWith("file.")) {
    const prop = translateProperty(containsMatch[1].trim());
    const args = parseStringArgs(containsMatch[2]);
    if (args.length === 1) return `${prop} LIKE '%${escapeSql(args[0])}%'`;
  }

  // prop.containsAll("a", "b")
  const containsAllMatch = expr.match(/^(.+?)\.containsAll\((.+)\)$/);
  if (containsAllMatch && !containsAllMatch[1].startsWith("file.")) {
    const prop = translateProperty(containsAllMatch[1].trim());
    const args = parseStringArgs(containsAllMatch[2]);
    const clauses = args.map((a) => `${prop} LIKE '%${escapeSql(a)}%'`);
    return `(${clauses.join(" AND ")})`;
  }

  // prop.containsAny("a", "b")
  const containsAnyMatch = expr.match(/^(.+?)\.containsAny\((.+)\)$/);
  if (containsAnyMatch && !containsAnyMatch[1].startsWith("file.")) {
    const prop = translateProperty(containsAnyMatch[1].trim());
    const args = parseStringArgs(containsAnyMatch[2]);
    const clauses = args.map((a) => `${prop} LIKE '%${escapeSql(a)}%'`);
    return `(${clauses.join(" OR ")})`;
  }

  // prop.startsWith("value")
  const startsWithMatch = expr.match(/^(.+?)\.startsWith\("([^"]+)"\)$/);
  if (startsWithMatch) {
    const prop = translateProperty(startsWithMatch[1].trim());
    return `${prop} LIKE '${escapeSql(startsWithMatch[2])}%'`;
  }

  // prop.endsWith("value")
  const endsWithMatch = expr.match(/^(.+?)\.endsWith\("([^"]+)"\)$/);
  if (endsWithMatch) {
    const prop = translateProperty(endsWithMatch[1].trim());
    return `${prop} LIKE '%${escapeSql(endsWithMatch[2])}'`;
  }

  // prop.isEmpty()
  const isEmptyMatch = expr.match(/^(.+?)\.isEmpty\(\)$/);
  if (isEmptyMatch) {
    const prop = translateProperty(isEmptyMatch[1].trim());
    return `(${prop} IS NULL OR ${prop} = '')`;
  }

  // /pattern/.matches(expr) — regex match
  const regexMatch = expr.match(/^\/(.+?)\/\.matches\((.+)\)$/);
  if (regexMatch) {
    const pattern = regexMatch[1];
    const target = regexMatch[2].trim();
    const col = translateProperty(target);
    return `${col} REGEXP '${escapeSql(pattern)}'`;
  }

  // Comparison expressions: property op value
  // e.g. status != "done", price > 2.1, file.ext == "md"
  const cmpMatch = expr.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (cmpMatch) {
    const leftRaw = cmpMatch[1].trim();
    const rightRaw = cmpMatch[3].trim();
    // Try resolving both sides as date expressions first
    const leftDate = resolveDateExpr(leftRaw);
    const rightDate = resolveDateExpr(rightRaw);
    const left =
      leftDate !== null ? String(leftDate) : translateProperty(leftRaw);
    const op = cmpMatch[2] === "==" ? "=" : cmpMatch[2];
    const right =
      rightDate !== null ? String(rightDate) : translateValue(rightRaw);
    return `${left} ${op} ${right}`;
  }

  // Fallback: treat as a property existence check
  return `"prop_${escapeSql(expr)}" IS NOT NULL`;
}

/**
 * Split an expression on && and || operators, respecting parentheses and quotes.
 * Returns null if no boolean operators found at the top level.
 */
function splitOnBooleanOps(
  expr: string,
  thisFile?: { name: string; path: string; folder: string },
): string | null {
  let depth = 0;
  let inString: string | null = null;

  // Find top-level && or ||
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      if (ch === inString && expr[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }

    if (depth === 0) {
      if (expr[i] === "&" && expr[i + 1] === "&") {
        const left = translateExpression(expr.slice(0, i).trim(), thisFile);
        const right = translateExpression(expr.slice(i + 2).trim(), thisFile);
        return `(${left} AND ${right})`;
      }
      if (expr[i] === "|" && expr[i + 1] === "|") {
        const left = translateExpression(expr.slice(0, i).trim(), thisFile);
        const right = translateExpression(expr.slice(i + 2).trim(), thisFile);
        return `(${left} OR ${right})`;
      }
    }
  }
  return null;
}

function translateProperty(prop: string): string {
  // file.* properties map to columns directly
  if (prop === "file.name") return "name";
  if (prop === "file.basename") return "basename";
  if (prop === "file.path") return "path";
  if (prop === "file.folder") return "folder";
  if (prop === "file.ext") return "ext";
  if (prop === "file.size") return "size";
  if (prop === "file.ctime") return "ctime";
  if (prop === "file.mtime") return "mtime";
  if (prop === "file.backlinks") return "backlinks";
  if (prop === "file.embeds") return "embeds";
  if (prop === "file.properties") return "file_properties";
  if (prop === "file.tags") return "tags";
  if (prop === "file.links") return "links";
  // note.* or bare property names -> prop_ columns
  const name = prop.startsWith("note.") ? prop.slice(5) : prop;
  return `"prop_${escapeSql(name)}"`;
}

function translateValue(val: string): string {
  // Date functions: now(), today(), date("...")
  const dateResolved = resolveDateExpr(val);
  if (dateResolved !== null) return String(dateResolved);

  // Quoted string
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return `'${escapeSql(val.slice(1, -1))}'`;
  }
  // Number
  if (!Number.isNaN(Number(val))) return val;
  // Boolean
  if (val === "true") return "1";
  if (val === "false") return "0";
  // Treat as property reference
  return translateProperty(val);
}

/**
 * Parse duration string like "7d", "1 week", "2h" into milliseconds.
 */
function parseDuration(dur: string): number {
  const match = dur.match(
    /^(\d+)\s*(y|year|years|M|month|months|d|day|days|w|week|weeks|h|hour|hours|m|minute|minutes|s|second|seconds)$/,
  );
  if (!match) return 0;
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "y":
    case "year":
    case "years":
      return n * 365.25 * 24 * 60 * 60 * 1000;
    case "M":
    case "month":
    case "months":
      return n * 30.44 * 24 * 60 * 60 * 1000;
    case "w":
    case "week":
    case "weeks":
      return n * 7 * 24 * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return n * 24 * 60 * 60 * 1000;
    case "h":
    case "hour":
    case "hours":
      return n * 60 * 60 * 1000;
    case "m":
    case "minute":
    case "minutes":
      return n * 60 * 1000;
    case "s":
    case "second":
    case "seconds":
      return n * 1000;
    default:
      return 0;
  }
}

/**
 * Resolve date expressions to epoch milliseconds.
 * Handles: now(), today(), date("..."), and arithmetic like now() - "7d"
 * Returns null if not a date expression.
 */
function resolveDateExpr(expr: string): number | null {
  expr = expr.trim();

  // now() +/- "duration"
  const nowArith = expr.match(/^now\(\)\s*([+-])\s*"([^"]+)"$/);
  if (nowArith) {
    const ms = parseDuration(nowArith[2]);
    return nowArith[1] === "+" ? Date.now() + ms : Date.now() - ms;
  }

  // today() +/- "duration"
  const todayArith = expr.match(/^today\(\)\s*([+-])\s*"([^"]+)"$/);
  if (todayArith) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ms = parseDuration(todayArith[2]);
    return todayArith[1] === "+" ? today.getTime() + ms : today.getTime() - ms;
  }

  // date("...") +/- "duration"
  const dateArith = expr.match(/^date\("([^"]+)"\)\s*([+-])\s*"([^"]+)"$/);
  if (dateArith) {
    const ts = new Date(dateArith[1]).getTime();
    if (Number.isNaN(ts)) return null;
    const ms = parseDuration(dateArith[3]);
    return dateArith[2] === "+" ? ts + ms : ts - ms;
  }

  // now()
  if (expr === "now()") return Date.now();

  // today()
  if (expr === "today()") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  }

  // date("...")
  const dateMatch = expr.match(/^date\("([^"]+)"\)$/);
  if (dateMatch) {
    const ts = new Date(dateMatch[1]).getTime();
    return Number.isNaN(ts) ? null : ts;
  }

  return null;
}

function parseStringArgs(argsStr: string): string[] {
  const args: string[] = [];
  const regex = /"([^"]+)"|'([^']+)'/g;
  for (let m = regex.exec(argsStr); m !== null; m = regex.exec(argsStr)) {
    args.push(m[1] || m[2]);
  }
  return args;
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Build ORDER BY clause from view config.
 */
export function orderToSQL(order?: string[]): string {
  if (!order || order.length === 0) return "";
  const cols = order.map((o) => translateProperty(o));
  return `ORDER BY ${cols.join(", ")}`;
}

/**
 * Query the database using a base view config.
 */
export async function queryBase(
  db: Database,
  baseConfig: BaseConfig,
  viewName?: string,
  thisFile?: { name: string; path: string; folder: string },
): Promise<{
  columns: string[];
  rows: unknown[][];
  groups?: { key: string; rows: unknown[][] }[];
  summaries?: Record<string, unknown>;
  displayNames?: Record<string, string>;
}> {
  const view = viewName
    ? baseConfig.views?.find((v) => v.name === viewName)
    : baseConfig.views?.[0];

  // Build WHERE from global filters + view filters
  const globalWhere = filterToSQL(baseConfig.filters, thisFile);
  const viewWhere = view?.filters ? filterToSQL(view.filters, thisFile) : "1=1";
  const where = `(${globalWhere}) AND (${viewWhere})`;

  const orderBy = orderToSQL(view?.order);
  const limit = view?.limit ? `LIMIT ${view.limit}` : "";

  const sql = `SELECT * FROM files WHERE ${where} ${orderBy} ${limit}`;

  try {
    const result = db.exec(sql);
    if (result.length === 0) return { columns: [], rows: [] };

    // Clean up column names (remove prop_ prefix for display)
    const columns = result[0].columns.map((c: string) =>
      c.startsWith("prop_") ? c.slice(5) : c,
    );
    let rows = result[0].values;

    // Evaluate formulas if any
    const formulas = baseConfig.formulas;
    if (formulas && Object.keys(formulas).length > 0) {
      const engine = createFormulaEngine();
      const formulaNames = Object.keys(formulas).map((k) => `formula.${k}`);

      const newRows: unknown[][] = [];
      for (const row of rows) {
        const formulaResults = await evaluateFormulas(
          engine,
          formulas,
          columns,
          row,
          thisFile,
        );
        const newRow = [...row, ...Object.values(formulaResults)];
        newRows.push(newRow);
      }
      columns.push(...formulaNames);
      rows = newRows;
    }

    // Build displayName mapping
    const displayNames: Record<string, string> = {};
    if (baseConfig.properties) {
      for (const [key, config] of Object.entries(baseConfig.properties)) {
        if (config.displayName) {
          displayNames[key] = config.displayName;
        }
      }
    }

    // GroupBy
    let groups: { key: string; rows: unknown[][] }[] | undefined;
    if (view?.groupBy) {
      const groupProp = view.groupBy.property;
      const groupIdx =
        columns.indexOf(groupProp) !== -1
          ? columns.indexOf(groupProp)
          : columns.indexOf(
              groupProp.startsWith("note.") ? groupProp.slice(5) : groupProp,
            );

      if (groupIdx !== -1) {
        const groupMap = new Map<string, unknown[][]>();
        for (const row of rows) {
          const key = String(row[groupIdx] ?? "(empty)");
          if (!groupMap.has(key)) groupMap.set(key, []);
          groupMap.get(key)?.push(row);
        }
        groups = [...groupMap.entries()].map(([key, rows]) => ({ key, rows }));
        if (view.groupBy.direction === "DESC") groups.reverse();
      }
    }

    // Summaries
    let summaries: Record<string, unknown> | undefined;
    const viewSummaries = view?.summaries as Record<string, string> | undefined;
    if (viewSummaries) {
      summaries = {};
      for (const [prop, fn] of Object.entries(viewSummaries)) {
        const colIdx =
          columns.indexOf(prop) !== -1
            ? columns.indexOf(prop)
            : columns.indexOf(prop.startsWith("note.") ? prop.slice(5) : prop);
        if (colIdx === -1) continue;

        const values = rows
          .map((r: unknown[]) => r[colIdx])
          .filter((v: unknown) => v !== null && v !== undefined);
        summaries[prop] = computeSummary(fn, values, baseConfig);
      }
    }

    return { columns, rows, groups, summaries, displayNames };
  } catch (e) {
    throw new Error(`Base query failed: ${(e as Error).message}\nSQL: ${sql}`);
  }
}

/**
 * Compute a summary function over a list of values.
 */
function computeSummary(
  fn: string,
  values: unknown[],
  baseConfig: BaseConfig,
): unknown {
  // Check custom summaries first
  if (
    baseConfig.summaries &&
    fn in (baseConfig.summaries as Record<string, string>)
  ) {
    // Custom summary formula — evaluate with jexl
    // For now, use built-in fallback
  }

  const nums = values.map(Number).filter((n) => !Number.isNaN(n));
  const dates = values
    .map((v) => new Date(v as string).getTime())
    .filter((n) => !Number.isNaN(n));

  switch (fn) {
    case "Sum":
      return nums.reduce((a, b) => a + b, 0);
    case "Average":
      return nums.length > 0
        ? nums.reduce((a, b) => a + b, 0) / nums.length
        : 0;
    case "Min":
      return nums.length > 0 ? Math.min(...nums) : null;
    case "Max":
      return nums.length > 0 ? Math.max(...nums) : null;
    case "Range":
      return nums.length > 0 ? Math.max(...nums) - Math.min(...nums) : null;
    case "Median": {
      if (nums.length === 0) return null;
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    case "Stddev": {
      if (nums.length === 0) return null;
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance =
        nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
      return Math.sqrt(variance);
    }
    case "Earliest":
      return dates.length > 0 ? Math.min(...dates) : null;
    case "Latest":
      return dates.length > 0 ? Math.max(...dates) : null;
    case "Checked":
      return values.filter(
        (v) => v === "true" || v === true || v === 1 || v === "1",
      ).length;
    case "Unchecked":
      return values.filter(
        (v) => v === "false" || v === false || v === 0 || v === "0",
      ).length;
    case "Empty":
      return values.filter((v) => v === null || v === undefined || v === "")
        .length;
    case "Filled":
      return values.filter((v) => v !== null && v !== undefined && v !== "")
        .length;
    case "Unique":
      return new Set(values.map(String)).size;
    default:
      return null;
  }
}
