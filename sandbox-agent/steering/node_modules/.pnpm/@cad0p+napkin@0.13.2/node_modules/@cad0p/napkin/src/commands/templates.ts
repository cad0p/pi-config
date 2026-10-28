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

export async function templates(
  opts: OutputOptions & { vault?: string; total?: boolean },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const files = n.templates();

  output(opts, {
    json: () => (opts.total ? { total: files.length } : { templates: files }),
    human: () => {
      if (opts.total) console.log(files.length);
      else for (const f of files) console.log(f);
    },
  });
}

export async function templateRead(
  opts: OutputOptions & {
    vault?: string;
    name?: string;
    resolve?: boolean;
    title?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  if (!opts.name) {
    error("No template name specified. Use --name <template>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: { template: string; content: string };
  try {
    result = n.templateRead(opts.name, {
      resolve: opts.resolve,
      title: opts.title,
    });
  } catch (e: unknown) {
    error((e as Error).message);
    process.exit(EXIT_NOT_FOUND);
  }

  output(opts, {
    json: () => result,
    human: () => console.log(result.content),
  });
}

export async function templateInsert(
  opts: OutputOptions & {
    vault?: string;
    name?: string;
    file?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  const templateName = opts.name;
  const targetFile = opts.file;
  if (!templateName) {
    error("No template name specified. Use --name <template>");
    process.exit(EXIT_USER_ERROR);
  }
  if (!targetFile) {
    error("No target file specified. Use --file <name>");
    process.exit(EXIT_USER_ERROR);
  }

  let result: { file: string; template: string; inserted: boolean };
  try {
    result = n.templateInsert(templateName, targetFile);
  } catch (e: unknown) {
    if ((e as Error).message.includes("File not found")) {
      fileNotFound(
        targetFile,
        suggestFile(n.vault.contentPath, targetFile, ignore),
      );
    } else {
      error((e as Error).message);
    }
    process.exit(EXIT_NOT_FOUND);
  }

  output(opts, {
    json: () => result,
    human: () =>
      success(`Inserted template "${result.template}" into ${result.file}`),
  });
}
