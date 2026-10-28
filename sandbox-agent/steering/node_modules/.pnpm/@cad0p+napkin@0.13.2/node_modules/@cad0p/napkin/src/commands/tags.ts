import { Napkin } from "../sdk.js";
import { EXIT_USER_ERROR } from "../utils/exit-codes.js";
import {
  bold,
  dim,
  error,
  type OutputOptions,
  output,
} from "../utils/output.js";

export async function tags(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    counts?: boolean;
    total?: boolean;
    sort?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { tagCounts } = n.tags(opts.file);

  const entries = [...tagCounts.entries()];
  if (opts.sort === "count") {
    entries.sort((a, b) => b[1] - a[1]);
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
  }

  output(opts, {
    json: () => {
      if (opts.total) return { total: entries.length };
      if (opts.counts) return { tags: Object.fromEntries(entries) };
      return { tags: entries.map(([t]) => t) };
    },
    human: () => {
      if (opts.total) {
        console.log(entries.length);
      } else {
        for (const [tag, count] of entries) {
          console.log(opts.counts ? `${tag}\t${count}` : tag);
        }
      }
    },
  });
}

export async function tag(
  opts: OutputOptions & { vault?: string; name?: string; verbose?: boolean },
) {
  const n = new Napkin(opts.vault || process.cwd());
  if (!opts.name) {
    error("No tag name specified. Use --name <tag>");
    process.exit(EXIT_USER_ERROR);
  }

  const { tag: _tag, count, files } = n.tagInfo(opts.name);

  output(opts, {
    json: () => ({ tag: opts.name, count, ...(opts.verbose ? { files } : {}) }),
    human: () => {
      console.log(
        `${bold(opts.name as string)}  ${count} occurrence${count !== 1 ? "s" : ""}`,
      );
      if (opts.verbose) {
        for (const f of files) console.log(`  ${dim(f)}`);
      }
    },
  });
}
