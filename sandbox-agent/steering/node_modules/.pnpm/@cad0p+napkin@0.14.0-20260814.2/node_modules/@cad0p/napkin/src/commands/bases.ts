import type { BaseQueryResult } from "../core/bases.js";
import { Napkin } from "../sdk.js";
import { EXIT_USER_ERROR } from "../utils/exit-codes.js";
import {
  bold,
  dim,
  error,
  type OutputOptions,
  output,
  success,
} from "../utils/output.js";

export async function bases(opts: OutputOptions & { vault?: string }) {
  const n = new Napkin(opts.vault || process.cwd());
  const files = n.bases();

  output(opts, {
    json: () => ({ bases: files }),
    human: () => {
      if (files.length === 0) {
        console.log("No .base files found");
      } else {
        for (const f of files) console.log(f);
      }
    },
  });
}

export async function baseViews(
  opts: OutputOptions & { vault?: string; file?: string; path?: string },
) {
  const n = new Napkin(opts.vault || process.cwd());
  let views: { name: string; type: string }[];
  try {
    views = n.baseViews(opts);
  } catch (e: unknown) {
    error((e as Error).message);
    process.exit(EXIT_USER_ERROR);
  }

  output(opts, {
    json: () => ({ views }),
    human: () => {
      for (const view of views) {
        console.log(`${bold(view.name)}  ${dim(view.type)}`);
      }
    },
  });
}

export async function baseQuery(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    path?: string;
    view?: string;
    format?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  let result: BaseQueryResult;
  try {
    result = await n.baseQuery(opts, opts.view);
  } catch (e: unknown) {
    error((e as Error).message);
    process.exit(EXIT_USER_ERROR);
  }
  const fmt = opts.format || "json";

  const displayCols = result.columns.map((c) => result.displayNames?.[c] || c);

  output(opts, {
    json: () => {
      if (fmt === "paths") {
        const pathIdx = result.columns.indexOf("path");
        return { paths: result.rows.map((r) => r[pathIdx]) };
      }
      // Convert to array of objects
      const rows = result.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < result.columns.length; i++) {
          obj[result.columns[i]] = row[i];
        }
        return obj;
      });
      const out: Record<string, unknown> = { columns: result.columns, rows };
      if (result.displayNames && Object.keys(result.displayNames).length > 0) {
        out.displayNames = result.displayNames;
      }
      if (result.groups) {
        out.groups = result.groups.map((g) => ({
          key: g.key,
          rows: g.rows.map((row) => {
            const obj: Record<string, unknown> = {};
            for (let i = 0; i < result.columns.length; i++) {
              obj[result.columns[i]] = row[i];
            }
            return obj;
          }),
        }));
      }
      if (result.summaries) out.summaries = result.summaries;
      return out;
    },
    human: () => {
      if (result.rows.length === 0) {
        console.log("No results");
        return;
      }

      if (fmt === "paths") {
        const pathIdx = result.columns.indexOf("path");
        for (const row of result.rows) console.log(row[pathIdx]);
        return;
      }

      if (fmt === "csv" || fmt === "tsv") {
        const sep = fmt === "csv" ? "," : "\t";
        console.log(displayCols.join(sep));
        for (const row of result.rows) {
          console.log(row.map((v) => (v === null ? "" : String(v))).join(sep));
        }
        return;
      }

      if (fmt === "md") {
        console.log(`| ${displayCols.join(" | ")} |`);
        console.log(`| ${displayCols.map(() => "---").join(" | ")} |`);
        for (const row of result.rows) {
          console.log(
            `| ${row.map((v) => (v === null ? "" : String(v))).join(" | ")} |`,
          );
        }
        return;
      }

      // Default: table-like
      for (const row of result.rows) {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < result.columns.length; i++) {
          if (row[i] !== null) obj[result.columns[i]] = row[i];
        }
        console.log(JSON.stringify(obj));
      }
    },
  });
}

export async function baseCreate(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    path?: string;
    name?: string;
    content?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  if (!opts.name) {
    error("No name specified. Use --name <name>");
    process.exit(EXIT_USER_ERROR);
  }

  const result = n.baseCreate({
    name: opts.name,
    path: opts.path,
    content: opts.content,
  });

  output(opts, {
    json: () => result,
    human: () => success(`Created ${result.path}`),
  });
}
