import { Napkin } from "../sdk.js";
import { EXIT_NOT_FOUND, EXIT_USER_ERROR } from "../utils/exit-codes.js";
import { suggestFile } from "../utils/files.js";
import { loadIgnorer } from "../utils/ignore.js";
import {
  dim,
  error,
  fileNotFound,
  type OutputOptions,
  output,
} from "../utils/output.js";

export async function outline(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    format?: string;
    total?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!opts.file) {
    error("No file specified. Use --file <name>");
    process.exit(EXIT_USER_ERROR);
  }

  let headings: { level: number; text: string; line: number }[];
  try {
    headings = n.outline(opts.file);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.startsWith("File not found:")) {
      fileNotFound(
        opts.file,
        suggestFile(n.vault.contentPath, opts.file, ignore),
      );
      process.exit(EXIT_NOT_FOUND);
    }
    throw e;
  }

  output(opts, {
    json: () => (opts.total ? { total: headings.length } : { headings }),
    human: () => {
      if (opts.total) {
        console.log(headings.length);
        return;
      }

      const fmt = opts.format || "tree";
      if (fmt === "json") {
        console.log(JSON.stringify(headings, null, 2));
      } else if (fmt === "md") {
        for (const h of headings) {
          console.log(`${"#".repeat(h.level)} ${h.text}`);
        }
      } else {
        // tree format
        for (const h of headings) {
          const indent = "  ".repeat(h.level - 1);
          console.log(`${dim(`${h.line}:`)} ${indent}${h.text}`);
        }
      }
    },
  });
}
