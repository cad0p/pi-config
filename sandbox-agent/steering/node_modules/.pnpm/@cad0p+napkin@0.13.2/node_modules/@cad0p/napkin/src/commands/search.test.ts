import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { searchVaultPaginated } from "../core/search.js";
import { createTempVault } from "../utils/test-helpers.js";
import { search } from "./search.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

async function captureJson(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const orig = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  await fn();
  console.log = orig;
  return JSON.parse(logs.join(""));
}

async function captureHuman(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  await fn();
  console.log = orig;
  return logs.join("\n");
}

beforeEach(() => {
  v = createTempVault({
    "Projects/alpha.md": "# Alpha\nThis is the alpha project\nWith TODO items",
    "Projects/beta.md": "# Beta\nBeta has no tasks",
    "Resources/guide.md": "# Guide\nRefer to the [[alpha]] project here",
    "README.md": "# Vault\nWelcome to the vault",
  });
});

afterEach(() => {
  v.cleanup();
});

describe("search", () => {
  test("finds files matching query with scores", async () => {
    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha" }),
    );
    const results = data.results as { file: string; score?: number }[];
    const files = results.map((r) => r.file);
    expect(files).toContain("Projects/alpha.md");
    expect(files).toContain("Resources/guide.md");
    // Score hidden by default
    expect(results[0].score).toBeUndefined();

    // Score shown with --score flag
    const withScore = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha", score: true }),
    );
    const scored = withScore.results as { score: number }[];
    expect(scored[0].score).toBeGreaterThan(0);
  });

  test("results include snippets by default", async () => {
    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "TODO" }),
    );
    const results = data.results as {
      file: string;
      snippets: { line: number; text: string }[];
    }[];
    expect(results.length).toBeGreaterThan(0);
    const alpha = results.find((r) => r.file === "Projects/alpha.md");
    expect(alpha).toBeDefined();
    expect(alpha?.snippets.length).toBeGreaterThan(0);
    expect(alpha?.snippets.some((s) => s.text.includes("TODO"))).toBe(true);
  });

  test("no-snippets returns files only", async () => {
    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "alpha",
        snippets: false,
      }),
    );
    const results = data.results as { file: string; snippets?: unknown }[];
    expect(results[0].snippets).toBeUndefined();
  });

  test("filters by folder", async () => {
    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "alpha",
        path: "Projects",
      }),
    );
    const results = data.results as { file: string }[];
    expect(results.length).toBe(1);
    expect(results[0].file).toBe("Projects/alpha.md");
  });

  test("returns total", async () => {
    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha", total: true }),
    );
    expect(data.total).toBe(2);
  });

  test("limits results", async () => {
    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "the", limit: "1" }),
    );
    const results = data.results as { file: string }[];
    expect(results.length).toBe(1);
  });

  test("results include backlink count", async () => {
    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha" }),
    );
    const results = data.results as { file: string; links: number }[];
    const alpha = results.find((r) => r.file === "Projects/alpha.md");
    expect(alpha).toBeDefined();
    // guide.md links to [[alpha]], so alpha should have links >= 1
    expect(alpha?.links).toBeGreaterThanOrEqual(1);
  });

  test("results include modified time", async () => {
    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha" }),
    );
    const results = data.results as { file: string; modified: string }[];
    expect(results[0].modified).toMatch(/ago$/);
  });

  test("--context-lines adds context around matches", async () => {
    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "TODO",
        contextLines: "1",
      }),
    );
    const results = data.results as {
      snippets: { line: number; text: string }[];
    }[];
    const alpha = results.find((r) => r.file === "Projects/alpha.md");
    expect(alpha).toBeDefined();
    // With context=1, should include lines around the match
    expect(alpha?.snippets.length).toBeGreaterThan(1);
  });

  test("--context-lines merges overlapping ranges", async () => {
    const vault = createTempVault({
      "test.md": "Line 1\nLine 2 match\nLine 3 match\nLine 4\nLine 5",
    });
    const data = await captureJson(() =>
      search({
        json: true,
        vault: vault.path,
        query: "match",
        contextLines: "1",
      }),
    );
    const results = data.results as {
      snippets: { line: number; text: string }[];
    }[];
    expect(results.length).toBe(1);
    // Overlapping matches should be merged into a single continuous snippet
    expect(results[0].snippets.length).toBe(4); // Lines 1-4
    expect(results[0].snippets.map((s) => s.line)).toEqual([1, 2, 3, 4]);
    vault.cleanup();
  });

  test("empty query returns no results", async () => {
    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "xyznonexistent999",
      }),
    );
    const results = data.results as unknown[];
    expect(results.length).toBe(0);
  });

  test("does not index the .gitignore file itself", async () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".gitignore"),
      "gitignore-only-marker\n",
    );

    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "gitignore-only-marker",
      }),
    );
    const results = data.results as { file: string }[];
    expect(results).toEqual([]);
  });

  test("excludes Markdown files matched by .gitignore (respectGitignore default)", async () => {
    fs.writeFileSync(path.join(v.vaultPath, ".gitignore"), "generated/\n");
    fs.mkdirSync(path.join(v.vaultPath, "generated"), { recursive: true });
    fs.writeFileSync(
      path.join(v.vaultPath, "generated", "ignored.md"),
      "# Generated\nignored-markdown-marker\n",
    );

    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "ignored-markdown-marker",
      }),
    );
    const results = data.results as { file: string }[];
    expect(results.map((result) => result.file)).not.toContain(
      "generated/ignored.md",
    );
  });

  test("indexes .gitignore-matched files when respectGitignore is false", async () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(v.vaultPath, "config.json"), "utf-8"),
    );
    config.ignore = { ...config.ignore, respectGitignore: false };
    fs.writeFileSync(
      path.join(v.vaultPath, "config.json"),
      JSON.stringify(config),
    );

    fs.writeFileSync(path.join(v.vaultPath, ".gitignore"), "generated/\n");
    fs.mkdirSync(path.join(v.vaultPath, "generated"), { recursive: true });
    fs.writeFileSync(
      path.join(v.vaultPath, "generated", "ignored.md"),
      "# Generated\nignored-markdown-marker\n",
    );

    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "ignored-markdown-marker",
      }),
    );
    const results = data.results as { file: string }[];
    expect(results.map((result) => result.file)).toContain(
      "generated/ignored.md",
    );
  });

  test("excludes files matched by .napkinignore", async () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );

    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "beta" }),
    );
    const results = data.results as { file: string }[];
    expect(results.map((result) => result.file)).not.toContain(
      "Projects/beta.md",
    );
  });

  test("excludes dotfiles and dotdirs by default", async () => {
    fs.mkdirSync(path.join(v.vaultPath, ".hidden-dir"), { recursive: true });
    fs.writeFileSync(
      path.join(v.vaultPath, ".hidden-dir", "secret.md"),
      "# Secret\nsecret-dotdir-marker\n",
    );
    fs.writeFileSync(
      path.join(v.vaultPath, ".hidden-note.md"),
      "# Hidden\nhidden-dotfile-marker\n",
    );

    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "marker" }),
    );
    const results = data.results as { file: string }[];
    expect(results.map((result) => result.file)).not.toContain(
      ".hidden-dir/secret.md",
    );
    expect(results.map((result) => result.file)).not.toContain(
      ".hidden-note.md",
    );
  });

  test("indexes dotfiles and dotdirs when ignore.dotfiles is false", async () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(v.vaultPath, "config.json"), "utf-8"),
    );
    config.ignore = { ...config.ignore, dotfiles: false };
    fs.writeFileSync(
      path.join(v.vaultPath, "config.json"),
      JSON.stringify(config),
    );

    fs.mkdirSync(path.join(v.vaultPath, ".hidden-dir"), { recursive: true });
    fs.writeFileSync(
      path.join(v.vaultPath, ".hidden-dir", "secret.md"),
      "# Secret\nsecret-dotdir-marker\n",
    );

    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "secret-dotdir-marker" }),
    );
    const results = data.results as { file: string }[];
    expect(results.map((result) => result.file)).toContain(
      ".hidden-dir/secret.md",
    );
  });

  test("--score includes score in json output", async () => {
    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "alpha",
        score: true,
      }),
    );
    const results = data.results as { score: number }[];
    expect(typeof results[0].score).toBe("number");
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("creates cache file after first search", async () => {
    const cachePath = path.join(v.vaultPath, "search-cache.json");
    expect(fs.existsSync(cachePath)).toBe(false);

    await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha" }),
    );

    expect(fs.existsSync(cachePath)).toBe(true);
  });

  test("second search uses cache and returns same results", async () => {
    // First search — builds and caches
    const data1 = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha", score: true }),
    );

    // Second search — should use cache
    const data2 = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha", score: true }),
    );

    const results1 = data1.results as { file: string; score: number }[];
    const results2 = data2.results as { file: string; score: number }[];
    expect(results1.map((r) => r.file)).toEqual(results2.map((r) => r.file));
    expect(results1.map((r) => r.score)).toEqual(results2.map((r) => r.score));
  });

  test("cache invalidated when file changes", async () => {
    // First search — builds cache
    await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha" }),
    );

    // Modify a file
    const filePath = path.join(v.vaultPath, "Projects/alpha.md");
    const futureTime = Date.now() + 2000;
    fs.utimesSync(filePath, futureTime / 1000, futureTime / 1000);

    // Second search — cache should be invalidated, still returns results
    const data = await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha" }),
    );
    const results = data.results as { file: string }[];
    expect(results.map((r) => r.file)).toContain("Projects/alpha.md");
  });

  test("does not crash on ambiguous file references in backlinks", async () => {
    const vault = createTempVault({
      "NAPKIN.md": "# Vault context\nThis is the vault root context",
      "projects/napkin.md": "# Napkin project\nThe napkin tool itself",
      "notes/reference.md":
        "# Reference\nSee [[napkin]] for details on decisions",
    });

    const data = await captureJson(() =>
      search({ json: true, vault: vault.path, query: "decisions" }),
    );
    const results = data.results as { file: string; links: number }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.file)).toContain("notes/reference.md");

    // [[napkin]] resolves to shallowest path (NAPKIN.md), which gets the backlink
    const withLinks = await captureJson(() =>
      search({ json: true, vault: vault.path, query: "napkin", score: true }),
    );
    const allResults = withLinks.results as { file: string; links: number }[];
    const napkinRoot = allResults.find((r) => r.file === "NAPKIN.md");
    expect(napkinRoot).toBeDefined();
    expect(napkinRoot?.links).toBeGreaterThanOrEqual(1);

    vault.cleanup();
  });

  test("cache not used when searching a subfolder", async () => {
    // Cache is folder-specific — searching with --path shouldn't use full-vault cache
    await captureJson(() =>
      search({ json: true, vault: v.path, query: "alpha" }),
    );

    const data = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "alpha",
        path: "Projects",
      }),
    );
    const results = data.results as { file: string }[];
    expect(results.length).toBe(1);
    expect(results[0].file).toBe("Projects/alpha.md");
  });

  test("paginates results with --page", async () => {
    // Create enough files to exceed resultsPerPage (default 10)
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(
        path.join(v.vaultPath, `extra-${i}.md`),
        `# Extra ${i}\n\nunique-token-zzz content for pagination test\n`,
      );
    }

    const page1 = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "unique-token-zzz",
        page: "1",
      }),
    );
    const page2 = await captureJson(() =>
      search({
        json: true,
        vault: v.path,
        query: "unique-token-zzz",
        page: "2",
      }),
    );

    const p1Results = page1.results as { file: string }[];
    const p2Results = page2.results as { file: string }[];
    const p1Files = p1Results.map((r) => r.file);
    const p2Files = p2Results.map((r) => r.file);

    expect(p1Results.length).toBeLessThanOrEqual(10);
    expect(page1.totalPages).toBe(2);
    expect(page1.currentPage).toBe(1);
    expect(p2Results.length).toBeGreaterThan(0);
    expect(page2.currentPage).toBe(2);
    // No overlap between pages
    for (const f of p2Files) {
      expect(p1Files).not.toContain(f);
    }
  });

  test("human output on first page includes page hint and outline hint", async () => {
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(
        path.join(v.vaultPath, `hint-extra-${i}.md`),
        `# Hint Extra ${i}\n\nhint-unique-token-zzz content for pagination test\n`,
      );
    }

    const out = await captureHuman(() =>
      search({
        vault: v.path,
        query: "hint-unique-token-zzz",
        page: "1",
      }),
    );

    expect(out).toContain("[Page 1 of 2. Use --page 2 to continue.]");
    expect(out).toContain(
      "HINT: Use napkin read <file> to open a full file. Use napkin outline --file <file> to see its structure.",
    );
  });

  test("human output on last page includes outline hint but no page hint", async () => {
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(
        path.join(v.vaultPath, `hint-extra-${i}.md`),
        `# Hint Extra ${i}\n\nhint-unique-token-zzz content for pagination test\n`,
      );
    }

    const out = await captureHuman(() =>
      search({
        vault: v.path,
        query: "hint-unique-token-zzz",
        page: "2",
      }),
    );

    expect(out).not.toContain("[Page");
    expect(out).toContain(
      "HINT: Use napkin read <file> to open a full file. Use napkin outline --file <file> to see its structure.",
    );
  });

  test("page < 1 throws an error", () => {
    expect(() =>
      searchVaultPaginated(v.vaultPath, v.vaultPath, "alpha", { page: 0 }),
    ).toThrow("Page must be >= 1");
    expect(() =>
      searchVaultPaginated(v.vaultPath, v.vaultPath, "alpha", { page: -1 }),
    ).toThrow("Page must be >= 1");
  });

  test("page exceeding totalPages throws an error", () => {
    expect(() =>
      searchVaultPaginated(v.vaultPath, v.vaultPath, "alpha", { page: 999 }),
    ).toThrow(/exceeds total pages/);
  });

  test("empty results returns default pagination fields", () => {
    const data = searchVaultPaginated(
      v.vaultPath,
      v.vaultPath,
      "unique-token-single-result-test",
    );
    // No files contain this token, so 0 results
    expect(data.results.length).toBe(0);
    expect(data.totalPages).toBe(1);
    expect(data.currentPage).toBe(1);
    expect(data.totalResults).toBe(0);
  });

  test("limit and page work together", () => {
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(
        path.join(v.vaultPath, `limit-test-${i}.md`),
        `# Limit Test ${i}\n\nunique-limit-token content for pagination test\n`,
      );
    }

    // limit=5 caps total results to 5; with resultsPerPage=10, all fit on 1 page
    const page1 = searchVaultPaginated(
      v.vaultPath,
      v.vaultPath,
      "unique-limit-token",
      { limit: 5, page: 1 },
    );

    expect(page1.totalResults).toBe(5);
    expect(page1.results.length).toBe(5);
    expect(page1.totalPages).toBe(1);
    expect(page1.currentPage).toBe(1);

    // page 2 should throw since all 5 results fit on page 1
    expect(() =>
      searchVaultPaginated(v.vaultPath, v.vaultPath, "unique-limit-token", {
        limit: 5,
        page: 2,
      }),
    ).toThrow(/exceeds total pages/);
  });
});
