import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EXIT_ERROR } from "../utils/exit-codes.js";
import {
  type CommandRunner,
  detectInstallMethod,
  type PackageManagerResolver,
  resolvePackageManager,
  update,
} from "./update.js";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

/** Fixed npm resolver so tests are deterministic regardless of host PATH. */
const npmOnly: PackageManagerResolver = () => ({
  command: npmCommand,
  args: ["install", "-g", "@cad0p/napkin@latest"],
  method: "npm",
});

const originalLog = console.log;
const originalError = console.error;
let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

async function captureExit(fn: () => Promise<void>): Promise<number> {
  const originalExit = process.exit;
  let exitCode = -1;
  (process as unknown as Record<string, unknown>).exit = (code: number) => {
    exitCode = code;
    throw new Error("exit");
  };

  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "exit") throw error;
  } finally {
    (process as unknown as Record<string, unknown>).exit = originalExit;
  }

  return exitCode;
}

describe("detectInstallMethod", () => {
  test("detects pnpm installs (global store and virtual store layouts)", () => {
    expect(
      detectInstallMethod(
        "/home/user/.local/share/pnpm/global/v11/hash/node_modules/@cad0p/napkin/src/commands/update.ts",
      ),
    ).toBe("pnpm");
    expect(
      detectInstallMethod(
        "/home/user/proj/node_modules/.pnpm/@cad0p+napkin@0.13.0/node_modules/@cad0p/napkin/src/commands/update.ts",
      ),
    ).toBe("pnpm");
  });

  test("detects npm installs (unix prefix and windows layouts)", () => {
    expect(
      detectInstallMethod(
        "/home/user/.local/lib/node_modules/@cad0p/napkin/src/commands/update.ts",
      ),
    ).toBe("npm");
    expect(
      detectInstallMethod(
        "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@cad0p\\napkin\\src\\commands\\update.ts",
      ),
    ).toBe("npm");
  });

  test("detects yarn classic and bun global installs", () => {
    expect(
      detectInstallMethod(
        "/home/user/.config/yarn/global/node_modules/@cad0p/napkin/src/commands/update.ts",
      ),
    ).toBe("yarn");
    expect(
      detectInstallMethod(
        "/home/user/.bun/install/global/node_modules/@cad0p/napkin/src/commands/update.ts",
      ),
    ).toBe("bun");
  });

  test("returns unknown for dev checkouts and unrecognized layouts", () => {
    expect(
      detectInstallMethod(
        "/home/user/open-source/github/napkin/src/commands/update.ts",
      ),
    ).toBe("unknown");
    expect(detectInstallMethod("")).toBe("unknown");
  });
});

describe("resolvePackageManager", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "napkin-update-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Create a fake module tree and return its update.ts path. */
  function moduleUnder(rel: string): string {
    const modulePath = join(base, rel, "src", "commands", "update.ts");
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, "");
    return modulePath;
  }

  test("reuses pnpm when the running module sits under pnpm's global root", () => {
    const root = join(
      base,
      "share",
      "pnpm",
      "global",
      "v11",
      "hash",
      "node_modules",
    );
    const modulePath = moduleUnder(
      "share/pnpm/global/v11/hash/node_modules/@cad0p/napkin",
    );
    expect(resolvePackageManager(modulePath, () => [root])).toEqual({
      command: pnpmCommand,
      args: ["add", "-g", "@cad0p/napkin@latest"],
      method: "pnpm",
    });
  });

  test("matches via the entrypoint when the module realpaths into the store (pnpm shim)", () => {
    const root = join(base, "share", "pnpm", "global", "v11");
    // Module realpath escapes the global root into the content-addressed store.
    const modulePath = moduleUnder(
      "share/pnpm/store/v11/links/@cad0p/napkin/0.13.0/hash/node_modules/@cad0p/napkin",
    );
    // The shim-exec'd entrypoint stays inside the global dir.
    const entrypoint = join(
      base,
      "share",
      "pnpm",
      "global",
      "v11",
      "hash",
      "node_modules",
      "@cad0p",
      "napkin",
      "bin",
      "napkin.js",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, "");
    expect(resolvePackageManager(modulePath, () => [root], entrypoint)).toEqual(
      {
        command: pnpmCommand,
        args: ["add", "-g", "@cad0p/napkin@latest"],
        method: "pnpm",
      },
    );
  });

  test("reuses npm when the running module sits under npm's global root", () => {
    const root = join(base, "lib", "node_modules");
    const modulePath = moduleUnder("lib/node_modules/@cad0p/napkin");
    expect(resolvePackageManager(modulePath, () => [root])).toEqual({
      command: npmCommand,
      args: ["install", "-g", "@cad0p/napkin@latest"],
      method: "npm",
    });
  });

  test("reuses yarn when the running module sits under yarn's global dir", () => {
    const root = join(base, ".config", "yarn", "global");
    const modulePath = moduleUnder(
      ".config/yarn/global/node_modules/@cad0p/napkin",
    );
    expect(
      resolvePackageManager(modulePath, () => [
        root,
        join(root, "node_modules"),
      ]),
    ).toEqual({
      command: yarnCommand,
      args: ["global", "add", "@cad0p/napkin@latest"],
      method: "yarn",
    });
  });

  test("reuses bun when the running module sits under bun's global root", () => {
    const root = join(base, ".bun", "install", "global", "node_modules");
    const modulePath = moduleUnder(
      ".bun/install/global/node_modules/@cad0p/napkin",
    );
    expect(resolvePackageManager(modulePath, () => [root])).toEqual({
      command: "bun",
      args: ["add", "-g", "@cad0p/napkin@latest"],
      method: "bun",
    });
  });

  test("does not self-update when the module is not under the global root", () => {
    const modulePath = moduleUnder("some-project/node_modules/@cad0p/napkin");
    expect(
      resolvePackageManager(
        modulePath,
        () => [join(base, "lib", "node_modules")],
        join(base, "some-project", "bin", "napkin"),
      ),
    ).toEqual({ command: "", args: [], method: "npm" });
  });

  test("does not self-update when the manager reports no global root", () => {
    const modulePath = moduleUnder(
      "share/pnpm/global/v11/hash/node_modules/@cad0p/napkin",
    );
    expect(resolvePackageManager(modulePath, () => [])).toEqual({
      command: "",
      args: [],
      method: "pnpm",
    });
  });

  test("returns unknown for unrecognized layouts without running installers", () => {
    const modulePath = moduleUnder("src/napkin");
    expect(resolvePackageManager(modulePath)).toEqual({
      command: "",
      args: [],
      method: "unknown",
    });
  });
});

describe("update command", () => {
  test("runs npm install globally for the latest napkin package", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { silent: boolean };
    }> = [];

    await update(
      {},
      async (command, args, options) => {
        calls.push({ command, args, options });
        return 0;
      },
      npmOnly,
    );

    expect(calls).toEqual([
      {
        command: npmCommand,
        args: ["install", "-g", "@cad0p/napkin@latest"],
        options: { silent: false },
      },
    ]);
    expect(logs.join("\n")).toContain("Updated @cad0p/napkin@latest");
  });

  test("returns structured JSON and silences npm output", async () => {
    let silent = false;

    await update(
      { json: true },
      async (_command, _args, options) => {
        silent = options.silent;
        return 0;
      },
      npmOnly,
    );

    expect(silent).toBe(true);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      updated: true,
      target: "@cad0p/napkin@latest",
    });
    expect(errors).toEqual([]);
  });

  test("suppresses command and npm output in quiet mode", async () => {
    let silent = false;

    await update(
      { quiet: true },
      async (_command, _args, options) => {
        silent = options.silent;
        return 0;
      },
      npmOnly,
    );

    expect(silent).toBe(true);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("reports a non-zero npm exit status", async () => {
    const exitCode = await captureExit(() =>
      update({}, async () => 7, npmOnly),
    );

    expect(exitCode).toBe(EXIT_ERROR);
    expect(errors.join("\n")).toContain("exited with status 7");
  });

  test("returns structured JSON for a failed update", async () => {
    const exitCode = await captureExit(() =>
      update({ json: true }, async () => 2, npmOnly),
    );

    expect(exitCode).toBe(EXIT_ERROR);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      updated: false,
      target: "@cad0p/napkin@latest",
      error: `${npmCommand} install -g @cad0p/napkin@latest exited with status 2`,
    });
    expect(errors).toEqual([]);
  });

  test("adds context when npm cannot be started", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("not found");
    };
    const exitCode = await captureExit(() => update({}, runner, npmOnly));

    expect(exitCode).toBe(EXIT_ERROR);
    expect(errors.join("\n")).toContain(
      `Update failed: Could not run ${npmCommand}: not found`,
    );
  });

  test("uses a pnpm resolver's command when update is run via pnpm", async () => {
    const pnpmResolver: PackageManagerResolver = () => ({
      command: pnpmCommand,
      args: ["add", "-g", "@cad0p/napkin@latest"],
      method: "pnpm",
    });
    const calls: Array<{ command: string; args: string[] }> = [];

    await update(
      {},
      async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
      pnpmResolver,
    );

    expect(calls).toEqual([
      {
        command: pnpmCommand,
        args: ["add", "-g", "@cad0p/napkin@latest"],
      },
    ]);
  });

  test("adds an installer hint when a derived installer cannot be started", async () => {
    const exitCode = await captureExit(() =>
      update(
        {},
        async () => {
          throw new Error("not found");
        },
        () => ({
          command: pnpmCommand,
          args: ["add", "-g", "@cad0p/napkin@latest"],
          method: "pnpm",
        }),
      ),
    );

    expect(exitCode).toBe(EXIT_ERROR);
    expect(errors.join("\n")).toContain(
      `Update failed: Could not run ${pnpmCommand}: not found (napkin is installed via pnpm`,
    );
  });

  test("explains when napkin is not managed by a global install", async () => {
    const exitCode = await captureExit(() =>
      update(
        {},
        async () => {
          throw new Error("should not run");
        },
        () => ({ command: "", args: [], method: "npm" }),
      ),
    );

    expect(exitCode).toBe(EXIT_ERROR);
    expect(errors.join("\n")).toContain(
      "This napkin is not managed by a global npm install",
    );
  });

  test("explains when the install method is unknown", async () => {
    const exitCode = await captureExit(() =>
      update(
        {},
        async () => {
          throw new Error("should not run");
        },
        () => ({ command: "", args: [], method: "unknown" }),
      ),
    );

    expect(exitCode).toBe(EXIT_ERROR);
    expect(errors.join("\n")).toContain(
      "Could not determine how this napkin was installed",
    );
  });
});
