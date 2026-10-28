import { Napkin } from "../sdk.js";
import { EXIT_NOT_FOUND, EXIT_USER_ERROR } from "../utils/exit-codes.js";
import { suggestFile } from "../utils/files.js";
import { loadIgnorer } from "../utils/ignore.js";
import { HeadingNotFoundError } from "../utils/markdown.js";
import {
  error,
  fileNotFound,
  type OutputOptions,
  output,
  success,
} from "../utils/output.js";

export async function read(
  fileRef: string | undefined,
  opts: OutputOptions & {
    vault?: string;
    section?: string;
    page?: string;
    pageSize?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!fileRef) {
    error("No file specified. Usage: napkin read <file>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: {
    path: string;
    content: string;
    totalPages?: number;
    currentPage?: number;
  };
  try {
    result = n.read(fileRef, {
      section: opts.section,
      page: opts.page ? Number.parseInt(opts.page, 10) : undefined,
      pageSize: opts.pageSize ? Number.parseInt(opts.pageSize, 10) : undefined,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.startsWith("File not found:")) {
      fileNotFound(fileRef, suggestFile(n.vault.contentPath, fileRef, ignore));
      process.exit(EXIT_NOT_FOUND);
    }
    if (e instanceof HeadingNotFoundError) {
      error(e.message);
      process.exit(EXIT_NOT_FOUND);
    }
    throw e;
  }

  output(opts, {
    json: () => result,
    human: () => console.log(result.content),
  });
}

export async function create(
  opts: OutputOptions & {
    vault?: string;
    name?: string;
    path?: string;
    content?: string;
    template?: string;
    overwrite?: boolean;
    open?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());

  let result: { path: string; created: boolean };
  try {
    result = n.create({
      name: opts.name,
      path: opts.path,
      content: opts.content,
      template: opts.template,
      overwrite: opts.overwrite,
    });
  } catch (e: unknown) {
    error((e as Error).message);
    process.exit(EXIT_USER_ERROR);
  }

  output(opts, {
    json: () => result,
    human: () => success(`Created ${result.path}`),
  });
}

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks).toString("utf-8").trimEnd();
  return result || undefined;
}

export async function append(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    content?: string;
    inline?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!opts.file) {
    error("No file specified. Use: napkin append <file> [content]");
    process.exit(EXIT_USER_ERROR);
  }
  if (!opts.content) {
    opts.content = await readStdin();
  }
  if (!opts.content) {
    error("No content specified. Use: napkin append <file> <content>");
    process.exit(EXIT_USER_ERROR);
  }

  let resolved: string;
  try {
    resolved = n.append(opts.file, opts.content, opts.inline);
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
    json: () => ({ path: resolved, appended: true }),
    human: () => success(`Appended to ${resolved}`),
  });
}

export async function prepend(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    content?: string;
    inline?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!opts.file) {
    error("No file specified. Use: napkin prepend <file> [content]");
    process.exit(EXIT_USER_ERROR);
  }
  if (!opts.content) {
    opts.content = await readStdin();
  }
  if (!opts.content) {
    error("No content specified. Use: napkin prepend <file> <content>");
    process.exit(EXIT_USER_ERROR);
  }

  let resolved: string;
  try {
    resolved = n.prepend(opts.file, opts.content, opts.inline);
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
    json: () => ({ path: resolved, prepended: true }),
    human: () => success(`Prepended to ${resolved}`),
  });
}

export async function move(
  opts: OutputOptions & { vault?: string; file?: string; to?: string },
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
  if (!opts.to) {
    error("No destination specified. Use --to <path>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: { from: string; to: string };
  try {
    result = n.move(opts.file, opts.to);
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
    human: () => success(`Moved ${result.from} → ${result.to}`),
  });
}

export async function rename(
  opts: OutputOptions & { vault?: string; file?: string; name?: string },
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
  if (!opts.name) {
    error("No new name specified. Use --name <name>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: { from: string; to: string };
  try {
    result = n.rename(opts.file, opts.name);
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
    human: () => success(`Renamed ${result.from} → ${result.to}`),
  });
}

export async function del(
  opts: OutputOptions & { vault?: string; file?: string; permanent?: boolean },
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

  let result: { path: string; deleted: boolean; permanent: boolean };
  try {
    result = n.delete(opts.file, opts.permanent);
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
      success(
        `Deleted ${result.path}${result.permanent ? " (permanent)" : " (moved to .trash)"}`,
      ),
  });
}
