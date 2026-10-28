import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_ERROR } from "../utils/exit-codes.js";
import {
  error,
  info,
  type OutputOptions,
  output,
  success,
} from "../utils/output.js";

const target = "@cad0p/napkin@latest";

interface RunOptions {
  silent: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<number>;

/** How the running napkin was installed globally. */
export type InstallMethod = "pnpm" | "npm" | "yarn" | "bun" | "unknown";

export interface ResolvedInstall {
  command: string;
  args: string[];
  method: InstallMethod;
}

export type PackageManagerResolver = () => ResolvedInstall;

/**
 * Detect the package manager that installed the running napkin from the
 * on-disk location of this module. Mirrors pi-coding-agent's
 * `detectInstallMethod` (dist/config.js): layout markers checked in order —
 * pnpm/yarn/bun installs also live under a `node_modules/` dir, so npm is
 * the catch-all for any remaining layout.
 */
export function detectInstallMethod(scriptPath: string): InstallMethod {
  const normalized = scriptPath.toLowerCase().replaceAll("\\", "/");
  if (normalized.includes("/pnpm/") || normalized.includes("/.pnpm/")) {
    return "pnpm";
  }
  if (normalized.includes("/yarn/") || normalized.includes("/.yarn/")) {
    return "yarn";
  }
  if (normalized.includes("/install/global/node_modules/")) {
    return "bun";
  }
  if (normalized.includes("/npm/") || normalized.includes("/node_modules/")) {
    return "npm";
  }
  return "unknown";
}

const INSTALLERS: Record<
  Exclude<InstallMethod, "unknown">,
  { command: string; args: string[] }
> = {
  pnpm: { command: platformBin("pnpm"), args: ["add", "-g", target] },
  npm: { command: platformBin("npm"), args: ["install", "-g", target] },
  yarn: { command: platformBin("yarn"), args: ["global", "add", target] },
  bun: { command: "bun", args: ["add", "-g", target] },
};

function platformBin(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export type GlobalRootResolver = (
  method: InstallMethod,
  modulePath: string,
) => string[];

/**
 * Global install roots reported by each package manager. Used to confirm the
 * running napkin is actually managed by that manager's global install — a
 * path marker alone can be fooled by local project installs (e.g.
 * `project/node_modules/.pnpm/…`).
 */
export function globalRootCandidates(
  method: InstallMethod,
  modulePath: string,
): string[] {
  switch (method) {
    case "pnpm": {
      const root = firstLine("pnpm", ["root", "-g"]);
      if (root) return [root];
      // pnpm unavailable on PATH: derive the global dir from the module path
      // (`<…>/global/<vN>/<hash>/node_modules/…`).
      const normalized = modulePath.replaceAll("\\", "/");
      const match = /^(.*\/global\/[^/]+\/[^/]+)\//.exec(normalized);
      return match ? [match[1]] : [];
    }
    case "npm": {
      const root = firstLine("npm", ["root", "-g"]);
      return root ? [root] : [];
    }
    case "yarn": {
      const dir = firstLine("yarn", ["global", "dir"]);
      return dir ? [dir, join(dir, "node_modules")] : [];
    }
    case "bun": {
      const bin = firstLine("bun", ["pm", "bin", "-g"]);
      const roots = [
        join(homedir(), ".bun", "install", "global", "node_modules"),
      ];
      if (bin)
        roots.push(join(dirname(bin), "install", "global", "node_modules"));
      return roots;
    }
    default:
      return [];
  }
}

function firstLine(command: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 && result.stdout) {
      const line = result.stdout.split("\n")[0]?.trim();
      return line || undefined;
    }
  } catch {
    // Command not found — caller decides (path-derived fallback or unmanaged).
  }
  return undefined;
}

/** Raw and symlink-resolved forms of a path, for prefix comparisons. */
function comparisonCandidates(p: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [tryRealpath(p), p]) {
    if (!candidate) continue;
    const normalized =
      process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
  }
  return candidates;
}

function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * True when the running napkin sits under the manager's global install root.
 * Both the module path and the entrypoint (argv[1]) are compared in raw and
 * symlink-resolved form — pnpm global installs symlink into the content-
 * addressed store, so the realpath of the module escapes the global root
 * while the entrypoint (shim-exec'd path) stays inside it.
 */
function isManagedGlobalInstall(
  method: InstallMethod,
  modulePath: string,
  roots: GlobalRootResolver,
  entrypoint: string | undefined,
): boolean {
  const packageDirs = [modulePath, entrypoint].filter((p): p is string =>
    Boolean(p),
  );
  const packageCandidates = packageDirs.flatMap(comparisonCandidates);
  return roots(method, modulePath).some((root) => {
    const rootCandidates = comparisonCandidates(root);
    return rootCandidates.some((resolvedRoot) => {
      const prefix = resolvedRoot.endsWith(sep)
        ? resolvedRoot
        : `${resolvedRoot}${sep}`;
      return packageCandidates.some(
        (p) => p === resolvedRoot || p.startsWith(prefix),
      );
    });
  });
}

/**
 * Resolve the package manager to use for self-update from the actual install
 * location — pi-coding-agent's `isManagedByGlobalPackageManager` approach:
 * marker detection plus a global-root cross-check, so `napkin update` always
 * reuses the installer that owns the running copy and never guesses. Returns
 * an empty command when the install is unrecognized or not a global install
 * (dev checkout, local project dependency, npx, …).
 */
export const resolvePackageManager: PackageManagerResolver = (
  modulePath = runningModulePath(),
  roots: GlobalRootResolver = globalRootCandidates,
  entrypoint: string | undefined = process.argv[1],
) => {
  const method = detectInstallMethod(modulePath);
  if (
    method !== "unknown" &&
    isManagedGlobalInstall(method, modulePath, roots, entrypoint)
  ) {
    const { command, args } = INSTALLERS[method];
    return { command, args, method };
  }
  return { command: "", args: [], method };
};

/** Real on-disk path of this module — embeds the global install root. */
function runningModulePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] ?? "";
  }
}

/** Guidance when no safe self-update command exists for this install. */
function unavailableInstruction(method: InstallMethod): string {
  if (method !== "unknown") {
    return `This napkin is not managed by a global ${method} install — update it with the package manager or source checkout that provides it.`;
  }
  return "Could not determine how this napkin was installed — update it with the package manager or source checkout that provides it.";
}

/** Guidance when a location-derived installer cannot be started. */
function installerHint(resolved: ResolvedInstall): string {
  if (resolved.method === "unknown") return "";
  const { command, args } = resolved;
  return ` (napkin is installed via ${resolved.method} — add ${command} to your PATH, or run \`${command} ${args.join(" ")}\` manually)`;
}

export async function update(
  opts: OutputOptions,
  runner: CommandRunner = runCommand,
  resolver: PackageManagerResolver = resolvePackageManager,
): Promise<void> {
  const resolved = resolver();
  const { command, args, method } = resolved;

  if (!command) {
    fail(opts, unavailableInstruction(method));
  }

  const commandLine = `${command} ${args.join(" ")}`;

  if (!opts.quiet && !opts.json) info(`Updating napkin with ${commandLine}`);

  let status: number;
  try {
    status = await runner(command, args, {
      silent: Boolean(opts.quiet || opts.json),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    fail(
      opts,
      `Could not run ${command}: ${message}${installerHint(resolved)}`,
    );
  }

  if (status !== 0) fail(opts, `${commandLine} exited with status ${status}`);

  output(opts, {
    json: () => ({ updated: true, target }),
    quiet: () => {},
    human: () => success(`Updated ${target}`),
  });
}

function fail(opts: OutputOptions, message: string): never {
  if (opts.json) {
    output(opts, {
      json: () => ({ updated: false, target, error: message }),
      human: () => {},
    });
  } else {
    error(`Update failed: ${message}`);
  }
  process.exit(EXIT_ERROR);
}

function runCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.silent ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
}
