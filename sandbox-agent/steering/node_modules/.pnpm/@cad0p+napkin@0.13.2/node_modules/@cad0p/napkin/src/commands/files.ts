import { exec } from "node:child_process";
import type { FileInfo, FolderInfo } from "../core/files.js";
import { Napkin } from "../sdk.js";
import { EXIT_NOT_FOUND } from "../utils/exit-codes.js";
import { resolveFile, suggestFile } from "../utils/files.js";
import { loadIgnorer } from "../utils/ignore.js";
import {
  bold,
  dim,
  error,
  fileNotFound,
  type OutputOptions,
  output,
} from "../utils/output.js";

export async function file(
  fileRef: string | undefined,
  opts: OutputOptions & { vault?: string },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  if (!fileRef) {
    error("No file specified. Usage: obsidian-cli file <name>");
    process.exit(EXIT_NOT_FOUND);
  }

  let info: FileInfo;
  try {
    info = n.fileInfo(fileRef);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.startsWith("File not found:")) {
      fileNotFound(fileRef, suggestFile(n.vault.contentPath, fileRef, ignore));
      process.exit(EXIT_NOT_FOUND);
    }
    throw e;
  }

  output(opts, {
    json: () => info,
    human: () => {
      console.log(`${dim("path")}       ${info.path}`);
      console.log(`${dim("name")}       ${bold(info.name)}`);
      console.log(`${dim("extension")}  ${info.extension}`);
      console.log(`${dim("size")}       ${info.size}`);
      console.log(`${dim("created")}    ${Math.floor(info.created)}`);
      console.log(`${dim("modified")}   ${Math.floor(info.modified)}`);
    },
  });
}

export async function files(
  opts: OutputOptions & {
    vault?: string;
    folder?: string;
    ext?: string;
    total?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const result = n.fileList({
    folder: opts.folder,
    ext: opts.ext,
  });

  output(opts, {
    json: () => (opts.total ? { total: result.length } : { files: result }),
    human: () => {
      if (opts.total) {
        console.log(result.length);
      } else {
        for (const f of result) console.log(f);
      }
    },
  });
}

export async function folders(
  opts: OutputOptions & { vault?: string; folder?: string; total?: boolean },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const result = n.folders(opts.folder);

  output(opts, {
    json: () => (opts.total ? { total: result.length } : { folders: result }),
    human: () => {
      if (opts.total) {
        console.log(result.length);
      } else {
        for (const f of result) console.log(f);
      }
    },
  });
}

export async function folder(
  folderPath: string | undefined,
  opts: OutputOptions & { vault?: string; info?: string },
) {
  const n = new Napkin(opts.vault || process.cwd());
  if (!folderPath) {
    error("No folder specified. Usage: obsidian-cli folder <path>");
    process.exit(EXIT_NOT_FOUND);
  }

  let fi: FolderInfo;
  try {
    fi = n.folderInfo(folderPath);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.startsWith("Folder not found:")) {
      error(msg);
      process.exit(EXIT_NOT_FOUND);
    }
    throw e;
  }

  if (opts.info) {
    const val =
      opts.info === "files"
        ? fi.files
        : opts.info === "folders"
          ? fi.folders
          : fi.size;
    output(opts, {
      json: () => ({ [opts.info as string]: val }),
      human: () => console.log(val),
    });
    return;
  }

  output(opts, {
    json: () => fi,
    human: () => {
      console.log(`${dim("path")}      ${fi.path}`);
      console.log(`${dim("files")}     ${fi.files}`);
      console.log(`${dim("folders")}   ${fi.folders}`);
      console.log(`${dim("size")}      ${fi.size}`);
    },
  });
}

export async function open(
  fileRef: string | undefined,
  opts: OutputOptions & { vault?: string; newtab?: boolean },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );
  const vaultName = encodeURIComponent(n.vault.name);

  let uri: string;
  if (fileRef) {
    const resolved = resolveFile(n.vault.contentPath, fileRef, ignore);
    if (!resolved) {
      fileNotFound(fileRef, suggestFile(n.vault.contentPath, fileRef, ignore));
      process.exit(EXIT_NOT_FOUND);
    }
    const encodedFile = encodeURIComponent(resolved.path.replace(/\.md$/, ""));
    uri = `obsidian://open?vault=${vaultName}&file=${encodedFile}`;
  } else {
    uri = `obsidian://open?vault=${vaultName}`;
  }

  exec(`open "${uri}"`);

  output(opts, {
    json: () => ({ uri }),
    human: () => console.log(uri),
  });
}
