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

export async function wordcount(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    words?: boolean;
    characters?: boolean;
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

  let result: { words: number; characters: number };
  try {
    result = n.wordcount(opts.file);
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

  const { words, characters } = result;

  output(opts, {
    json: () => {
      if (opts.words) return { words };
      if (opts.characters) return { characters };
      return { words, characters };
    },
    human: () => {
      if (opts.words) console.log(words);
      else if (opts.characters) console.log(characters);
      else {
        console.log(`${dim("words")}       ${words}`);
        console.log(`${dim("characters")}  ${characters}`);
      }
    },
  });
}
