import type { Bookmark } from "../core/bookmarks.js";
import { Napkin } from "../sdk.js";
import { EXIT_USER_ERROR } from "../utils/exit-codes.js";
import {
  dim,
  error,
  type OutputOptions,
  output,
  success,
} from "../utils/output.js";

export async function bookmarks(
  opts: OutputOptions & {
    vault?: string;
    total?: boolean;
    verbose?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const flat = n.bookmarks();

  output(opts, {
    json: () => (opts.total ? { total: flat.length } : { bookmarks: flat }),
    human: () => {
      if (opts.total) {
        console.log(flat.length);
      } else {
        for (const b of flat) {
          const label = b.title || b.path || b.query || b.url || "(untitled)";
          console.log(opts.verbose ? `${label}\t${dim(b.type)}` : label);
        }
      }
    },
  });
}

export async function bookmark(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    subpath?: string;
    folder?: string;
    search?: string;
    url?: string;
    title?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());

  let entry: Bookmark;
  if (opts.file) {
    entry = {
      type: "file",
      path: opts.file,
      title: opts.title,
      subpath: opts.subpath,
    };
  } else if (opts.folder) {
    entry = { type: "folder", path: opts.folder, title: opts.title };
  } else if (opts.search) {
    entry = { type: "search", query: opts.search, title: opts.title };
  } else if (opts.url) {
    entry = { type: "url", url: opts.url, title: opts.title };
  } else {
    error("Specify --file, --folder, --search, or --url to bookmark");
    process.exit(EXIT_USER_ERROR);
  }

  const result = n.bookmarkAdd(entry);

  output(opts, {
    json: () => result,
    human: () =>
      success(
        `Bookmarked ${result.added.path || result.added.query || result.added.url}`,
      ),
  });
}
