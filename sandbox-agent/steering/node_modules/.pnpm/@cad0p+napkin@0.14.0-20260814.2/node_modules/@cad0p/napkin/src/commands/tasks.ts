import { resolveTaskLocation, type TaskWithFile } from "../core/tasks.js";
import { Napkin } from "../sdk.js";
import { EXIT_NOT_FOUND, EXIT_USER_ERROR } from "../utils/exit-codes.js";
import { suggestFile } from "../utils/files.js";
import { loadIgnorer } from "../utils/ignore.js";
import {
  bold,
  dim,
  error,
  fileNotFound,
  type OutputOptions,
  output,
} from "../utils/output.js";

export async function tasks(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    done?: boolean;
    todo?: boolean;
    total?: boolean;
    verbose?: boolean;
    daily?: boolean;
    status?: string;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const result = n.tasks({
    file: opts.file,
    daily: opts.daily,
    done: opts.done,
    todo: opts.todo,
    status: opts.status,
  });

  output(opts, {
    json: () => (opts.total ? { total: result.length } : { tasks: result }),
    human: () => {
      if (opts.total) {
        console.log(result.length);
      } else if (opts.verbose) {
        const byFile = new Map<string, TaskWithFile[]>();
        for (const t of result) {
          if (!byFile.has(t.file)) byFile.set(t.file, []);
          byFile.get(t.file)?.push(t);
        }
        for (const [file, tasks] of byFile) {
          console.log(bold(file));
          for (const t of tasks) {
            console.log(`  ${dim(`${t.line}:`)} [${t.status}] ${t.text}`);
          }
        }
      } else {
        for (const t of result) {
          console.log(`[${t.status}] ${t.text}`);
        }
      }
    },
  });
}

export async function task(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    line?: string;
    ref?: string;
    toggle?: boolean;
    done?: boolean;
    todo?: boolean;
    status?: string;
    daily?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const { ignorer: ignore } = loadIgnorer(
    n.vault.contentPath,
    n.vault.configPath,
  );

  let filePath: string;
  let lineNum: number;
  try {
    ({ filePath, lineNum } = resolveTaskLocation(n.vault, opts));
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.includes("File not found")) {
      const ref = opts.ref?.split(":")[0] || opts.file || "";
      fileNotFound(ref, suggestFile(n.vault.contentPath, ref, ignore));
      process.exit(EXIT_NOT_FOUND);
    }
    error(msg);
    process.exit(EXIT_USER_ERROR);
  }

  let taskInfo: { currentStatus: string; text: string };
  try {
    taskInfo = n.taskShow(filePath, lineNum);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    error(msg);
    process.exit(
      msg.includes("is not a task") ? EXIT_USER_ERROR : EXIT_NOT_FOUND,
    );
  }

  const { currentStatus } = taskInfo;
  const isMutating = opts.toggle || opts.done || opts.todo || opts.status;

  if (isMutating) {
    let newStatus: string;
    if (opts.status) newStatus = opts.status;
    else if (opts.done) newStatus = "x";
    else if (opts.todo) newStatus = " ";
    else if (opts.toggle) newStatus = currentStatus === " " ? "x" : " ";
    else newStatus = currentStatus;

    const result = n.taskUpdate(filePath, lineNum, newStatus);

    output(opts, {
      json: () => result,
      human: () => console.log(`[${result.status}] ${result.text}`),
    });
  } else {
    output(opts, {
      json: () => ({
        file: filePath,
        line: lineNum,
        status: currentStatus,
        text: taskInfo.text,
        done: currentStatus === "x" || currentStatus === "X",
      }),
      human: () => {
        console.log(`${dim("file")}    ${filePath}`);
        console.log(`${dim("line")}    ${lineNum}`);
        console.log(`${dim("status")}  [${currentStatus}]`);
        console.log(`${dim("text")}    ${taskInfo.text}`);
      },
    });
  }
}
