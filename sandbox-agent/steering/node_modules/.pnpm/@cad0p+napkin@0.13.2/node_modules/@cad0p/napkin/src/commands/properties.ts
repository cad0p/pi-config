import { Napkin } from "../sdk.js";
import { EXIT_NOT_FOUND, EXIT_USER_ERROR } from "../utils/exit-codes.js";
import { suggestFile } from "../utils/files.js";
import { loadIgnorer } from "../utils/ignore.js";
import {
  error,
  fileNotFound,
  type OutputOptions,
  output,
  success,
} from "../utils/output.js";

export async function properties(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    counts?: boolean;
    total?: boolean;
    sort?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const propCounts = n.properties(opts.file);

  const entries = [...propCounts.entries()];
  if (opts.sort === "count") {
    entries.sort((a, b) => b[1] - a[1]);
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
  }

  output(opts, {
    json: () => {
      if (opts.total) return { total: entries.length };
      if (opts.counts) return { properties: Object.fromEntries(entries) };
      return { properties: entries.map(([p]) => p) };
    },
    human: () => {
      if (opts.total) {
        console.log(entries.length);
      } else {
        for (const [prop, count] of entries) {
          console.log(opts.counts ? `${prop}\t${count}` : prop);
        }
      }
    },
  });
}

export async function propertySet(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    name?: string;
    value?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!opts.name || opts.value === undefined) {
    error("Usage: property:set --name <name> --value <value> --file <file>");
    process.exit(EXIT_USER_ERROR);
  }
  if (!opts.file) {
    error("No file specified. Use --file <name>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: { path: string; property: string; value: unknown };
  try {
    result = n.propertySet(opts.file, opts.name, opts.value);
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
    json: () => result,
    human: () =>
      success(`Set ${result.property} = ${opts.value} on ${result.path}`),
  });
}

export async function propertyRemove(
  opts: OutputOptions & { vault?: string; file?: string; name?: string },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!opts.name) {
    error("No property name specified. Use --name <name>");
    process.exit(EXIT_USER_ERROR);
  }
  if (!opts.file) {
    error("No file specified. Use --file <name>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: { path: string; removed: string };
  try {
    result = n.propertyRemove(opts.file, opts.name);
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
    json: () => result,
    human: () => success(`Removed ${result.removed} from ${result.path}`),
  });
}

export async function propertyRead(
  opts: OutputOptions & { vault?: string; file?: string; name?: string },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!opts.name) {
    error("No property name specified. Use --name <name>");
    process.exit(EXIT_USER_ERROR);
  }
  if (!opts.file) {
    error("No file specified. Use --file <name>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: { property: string; value: unknown };
  try {
    result = n.propertyGet(opts.file, opts.name);
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
    json: () => result,
    human: () => console.log(result.value !== null ? String(result.value) : ""),
  });
}
