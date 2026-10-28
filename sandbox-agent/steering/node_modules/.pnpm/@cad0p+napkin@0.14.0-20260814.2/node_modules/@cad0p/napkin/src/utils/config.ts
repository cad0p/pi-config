import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Default number of search results per page.
 *
 * Balances token budget (10 results × ~80 tokens/snippet ≈ 800 tokens per
 * page) with enough context for AI agents to make follow-up decisions.
 */
export const DEFAULT_SEARCH_RESULTS_PER_PAGE = 10;

export interface VaultLayout {
  /**
   * Content root relative to the .napkin/ dir. REQUIRED — a `.napkin/`
   * whose config lacks it is the refused legacy embedded layout. ".." for
   * the sibling layout (content alongside `.napkin/`, the init/goldmine
   * standard), "." to keep content inside `.napkin/`.
   */
  root: string;
  /**
   * .obsidian/ dir relative to .napkin/ dir (e.g. "../.obsidian" for
   * sibling layout). Optional — defaults to `<contentRoot>/.obsidian`.
   */
  obsidian?: string;
}

export interface NapkinConfig {
  vault?: VaultLayout;
  overview: {
    depth: number;
    keywords: number;
    /** Roll up numerous, lexically homogeneous sibling folders into one row. */
    collapse: boolean;
    /** Collapse targets must be at least this deep; 1 = only the vault root is protected (upstream default). */
    collapseDepth: number;
    /** Max rows in the overview listing; 0 = unlimited. */
    maxRows: number;
  };
  search: {
    limit: number;
    contextLines: number;
    resultsPerPage: number;
  };
  daily: {
    folder: string;
    format: string;
  };
  templates: {
    folder: string;
  };
  graph: {
    renderer: "auto" | "glimpse" | "browser";
  };
  ignore: {
    /** Respect .gitignore at the vault root (gitignore-style patterns). */
    respectGitignore: boolean;
    /** Exclude dot-prefixed files and folders (Obsidian "hidden files" parity). */
    dotfiles: boolean;
  };
}

export const DEFAULT_CONFIG: NapkinConfig = {
  overview: {
    depth: 3,
    keywords: 8,
    collapse: true,
    // Fork defaults: maxRows caps session-context bloat (pi-napkin relies on
    // it) and collapseDepth protects the curated top-level taxonomy from
    // homogeneous-sibling collapse. Upstream-identical behavior is available
    // via explicit opts/config (maxRows 0, collapseDepth 1) and is what the
    // equivalence + golden oracle suites pin.
    collapseDepth: 2,
    maxRows: 100,
  },
  search: {
    limit: 30,
    contextLines: 5,
    resultsPerPage: DEFAULT_SEARCH_RESULTS_PER_PAGE,
  },
  daily: {
    folder: "daily",
    format: "YYYY-MM-DD",
  },
  templates: {
    folder: "Templates",
  },
  graph: {
    renderer: "auto",
  },
  ignore: {
    respectGitignore: true,
    dotfiles: true,
  },
};

/**
 * Load napkin config from config.json in the .napkin/ directory.
 * Missing fields fall back to defaults.
 */
export function loadConfig(napkinDir: string): NapkinConfig {
  const configPath = path.join(napkinDir, "config.json");
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return deepMerge(DEFAULT_CONFIG, raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save napkin config to config.json in the .napkin/ directory and sync to .obsidian/.
 * If obsidianDir is not provided, resolves it from config.vault or defaults to .napkin/.obsidian/.
 */
export function saveConfig(
  napkinDir: string,
  config: NapkinConfig,
  obsidianDir?: string,
): void {
  const configPath = path.join(napkinDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const resolvedObsidian =
    obsidianDir ||
    (config.vault?.obsidian
      ? path.resolve(napkinDir, config.vault.obsidian)
      : config.vault?.root
        ? path.join(path.resolve(napkinDir, config.vault.root), ".obsidian")
        : path.join(napkinDir, ".obsidian"));
  syncObsidianConfig(resolvedObsidian, config);
}

/**
 * Update specific config fields, save, and sync.
 */
export function updateConfig(
  napkinDir: string,
  partial: Record<string, unknown>,
): NapkinConfig {
  const current = loadConfig(napkinDir);
  const updated = deepMerge(current, partial) as NapkinConfig;
  saveConfig(napkinDir, updated);
  return updated;
}

/**
 * Write .obsidian/ config files derived from napkin config.
 * napkin is the source of truth — Obsidian reads from these.
 */
function syncObsidianConfig(obsidianDir: string, config: NapkinConfig): void {
  if (!fs.existsSync(obsidianDir)) {
    fs.mkdirSync(obsidianDir, { recursive: true });
  }

  // daily-notes.json
  fs.writeFileSync(
    path.join(obsidianDir, "daily-notes.json"),
    JSON.stringify(
      {
        folder: config.daily.folder,
        format: config.daily.format,
        template: `${config.templates.folder}/Daily Note`,
      },
      null,
      2,
    ),
  );

  // templates.json
  fs.writeFileSync(
    path.join(obsidianDir, "templates.json"),
    JSON.stringify(
      {
        folder: config.templates.folder,
      },
      null,
      2,
    ),
  );

  // app.json
  const appPath = path.join(obsidianDir, "app.json");
  let app: Record<string, unknown> = {};
  if (fs.existsSync(appPath)) {
    try {
      app = JSON.parse(fs.readFileSync(appPath, "utf-8"));
    } catch {
      // ignore
    }
  }
  app.alwaysUpdateLinks = true;
  fs.writeFileSync(appPath, JSON.stringify(app, null, 2));
}

// biome-ignore lint/suspicious/noExplicitAny: deep merge requires flexible types
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Record<string, any>,
): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (target as Record<string, any>)[key];
    if (
      srcVal &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, any>)[key] = deepMerge(tgtVal, srcVal);
    } else {
      (result as Record<string, any>)[key] = srcVal;
    }
  }
  return result;
}
