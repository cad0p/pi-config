import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  v = createTempVault({
    "README.md": "# Vault\nWelcome",
    "Projects/note.md": "---\ntitle: Note\n---\nBody content",
  });
});

afterEach(() => {
  v.cleanup();
});

function run(
  args: string[],
  stdin?: string,
): { stdout: string; stderr: string; exitCode: number } {
  // Spawn the CLI as a real subprocess (node --import tsx) so these
  // tests exercise the same argv parsing and stdio path as a real
  // `napkin` invocation. spawnSync keeps the helper synchronous and
  // simple; none of these tests need streaming. cwd is the repo root
  // (not the vault) so node resolves the tsx loader from node_modules;
  // vault discovery goes through --vault, not cwd.
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      path.resolve("src/main.ts"),
      "--vault",
      v.path,
      ...args,
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf-8",
      input: stdin,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(v.vaultPath, rel), "utf-8");
}

describe("positional args", () => {
  test("create <name>", async () => {
    const { exitCode } = run(["create", "Test Note", "--json"]);
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(v.vaultPath, "Test Note.md"))).toBe(true);
  });

  test("create <name> [content]", async () => {
    const { exitCode } = run(["create", "Test Note", "hello world", "--json"]);
    expect(exitCode).toBe(0);
    expect(readFile("Test Note.md")).toBe("hello world");
  });

  test("append <file> [content]", async () => {
    const { exitCode } = run(["append", "README", "new line", "--json"]);
    expect(exitCode).toBe(0);
    expect(readFile("README.md")).toContain("Welcome\nnew line");
  });

  test("append <file> with stdin", async () => {
    const { exitCode } = run(["append", "README", "--json"], "from stdin");
    expect(exitCode).toBe(0);
    expect(readFile("README.md")).toContain("Welcome\nfrom stdin");
  });

  test("append positional content takes precedence over stdin", async () => {
    const { exitCode } = run(
      ["append", "README", "positional", "--json"],
      "from stdin",
    );
    expect(exitCode).toBe(0);
    expect(readFile("README.md")).toContain("positional");
    expect(readFile("README.md")).not.toContain("from stdin");
  });

  test("prepend <file> [content]", async () => {
    const { exitCode } = run(["prepend", "README", "top line", "--json"]);
    expect(exitCode).toBe(0);
    const content = readFile("README.md");
    expect(content.indexOf("top line")).toBeLessThan(
      content.indexOf("Welcome"),
    );
  });

  test("prepend <file> with stdin", async () => {
    const { exitCode } = run(["prepend", "README", "--json"], "from stdin");
    expect(exitCode).toBe(0);
    const content = readFile("README.md");
    expect(content.indexOf("from stdin")).toBeLessThan(
      content.indexOf("Welcome"),
    );
  });

  test("move <file> <to>", async () => {
    const { exitCode } = run(["move", "README", "Projects", "--json"]);
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(v.vaultPath, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.vaultPath, "Projects/README.md"))).toBe(
      true,
    );
  });

  test("rename <file> <name>", async () => {
    const { exitCode } = run(["rename", "README", "INDEX", "--json"]);
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(v.vaultPath, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.vaultPath, "INDEX.md"))).toBe(true);
  });

  test("delete <file>", async () => {
    const { exitCode } = run(["delete", "README", "--permanent", "--json"]);
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(v.vaultPath, "README.md"))).toBe(false);
  });

  test("file outline <file>", async () => {
    const { stdout, exitCode } = run(["outline", "README", "--json"]);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.headings.length).toBeGreaterThan(0);
  });

  test("file wordcount <file>", async () => {
    const { stdout, exitCode } = run(["file", "wordcount", "README", "--json"]);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.words).toBeGreaterThan(0);
  });

  test("daily append [content]", async () => {
    // Create today's daily note first
    run(["daily", "today", "--json"]);
    const { exitCode } = run(["daily", "append", "daily entry", "--json"]);
    expect(exitCode).toBe(0);
  });

  test("daily prepend [content]", async () => {
    run(["daily", "today", "--json"]);
    const { exitCode } = run(["daily", "prepend", "top entry", "--json"]);
    expect(exitCode).toBe(0);
  });
});

describe("flag backward compat", () => {
  test("append --file --content still works", async () => {
    const { exitCode } = run([
      "append",
      "--file",
      "README",
      "--content",
      "flag content",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(readFile("README.md")).toContain("flag content");
  });

  test("create --name --content still works", async () => {
    const { exitCode } = run([
      "create",
      "--name",
      "Flag Note",
      "--content",
      "flag body",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(readFile("Flag Note.md")).toBe("flag body");
  });
});
