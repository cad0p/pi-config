import type { SearchResult } from "../core/search.js";
import { Napkin } from "../sdk.js";
import { EXIT_USER_ERROR } from "../utils/exit-codes.js";
import {
  bold,
  dim,
  error,
  type OutputOptions,
  output,
} from "../utils/output.js";

interface SearchOpts extends OutputOptions {
  vault?: string;
  query?: string;
  path?: string;
  limit?: string;
  page?: string;
  total?: boolean;
  contextLines?: string;
  snippets?: boolean;
  score?: boolean;
}

interface PaginationMeta {
  totalPages: number;
  currentPage: number;
  totalResults: number;
}

function renderSearchResults(
  results: SearchResult[],
  opts: SearchOpts,
  paginationMeta?: PaginationMeta,
) {
  const total = paginationMeta?.totalResults ?? results.length;

  output(opts, {
    json: () => {
      if (opts.total) return { total };
      const mapResult = (r: SearchResult) => {
        const { score: _score, snippets, ...rest } = r;
        const out: Record<string, unknown> = { ...rest };
        if (opts.score) out.score = r.score;
        if (opts.snippets !== false) out.snippets = snippets;
        return out;
      };
      const base = { results: results.map(mapResult) };
      if (paginationMeta) {
        return {
          ...base,
          totalPages: paginationMeta.totalPages,
          currentPage: paginationMeta.currentPage,
          totalResults: paginationMeta.totalResults,
        };
      }
      return base;
    },
    human: () => {
      if (opts.total) {
        console.log(total);
        return;
      }
      for (const r of results) {
        console.log(
          `${bold(r.file)} ${dim(`(${opts.score ? `score: ${r.score}, ` : ""}links: ${r.links}, modified: ${r.modified})`)}`,
        );
        for (const s of r.snippets) {
          console.log(`  ${dim(`${s.line}:`)} ${s.text}`);
        }
      }
      if (
        paginationMeta &&
        paginationMeta.currentPage < paginationMeta.totalPages
      ) {
        console.log("");
        console.log(
          dim(
            `[Page ${paginationMeta.currentPage} of ${paginationMeta.totalPages}. Use --page ${paginationMeta.currentPage + 1} to continue.]`,
          ),
        );
      }
      console.log("");
      console.log(
        dim(
          "HINT: Use napkin read <file> to open a full file. Use napkin outline --file <file> to see its structure.",
        ),
      );
    },
  });
}

export async function search(opts: SearchOpts) {
  const n = new Napkin(opts.vault || process.cwd());
  if (!opts.query) {
    error("No query specified. Use --query <text>");
    process.exit(EXIT_USER_ERROR);
  }

  const searchOpts = {
    path: opts.path,
    limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
    contextLines: opts.contextLines
      ? Number.parseInt(opts.contextLines, 10)
      : undefined,
    snippets: opts.snippets,
  };

  const page = opts.page ? Number.parseInt(opts.page, 10) : 1;
  const paginated = n.searchPaginated(opts.query, { ...searchOpts, page });
  renderSearchResults(paginated.results, opts, {
    totalPages: paginated.totalPages,
    currentPage: paginated.currentPage,
    totalResults: paginated.totalResults,
  });
}
