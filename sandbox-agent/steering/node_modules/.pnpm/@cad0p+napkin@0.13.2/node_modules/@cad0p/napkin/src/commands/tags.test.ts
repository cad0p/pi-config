import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import { tag, tags } from "./tags.js";

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

beforeEach(() => {
  v = createTempVault({
    "note1.md": "---\ntags:\n  - project\n---\n# Note 1\nSome #urgent text",
    "note2.md": "# Note 2\nMore #project and #urgent stuff",
    "note3.md": "# Note 3\nNo tags here",
  });
});

afterEach(() => {
  v.cleanup();
});

describe("tags", () => {
  test("lists all tags", async () => {
    const data = await captureJson(() => tags({ json: true, vault: v.path }));
    expect(data.tags).toContain("project");
    expect(data.tags).toContain("urgent");
  });

  test("returns counts", async () => {
    const data = await captureJson(() =>
      tags({ json: true, vault: v.path, counts: true }),
    );
    const t = data.tags as Record<string, number>;
    expect(t.project).toBe(2);
    expect(t.urgent).toBe(2);
  });

  test("returns total", async () => {
    const data = await captureJson(() =>
      tags({ json: true, vault: v.path, total: true }),
    );
    expect(data.total).toBe(2);
  });

  test("filters by file", async () => {
    const data = await captureJson(() =>
      tags({ json: true, vault: v.path, file: "note3" }),
    );
    expect((data.tags as string[]).length).toBe(0);
  });
});

describe("tag", () => {
  test("shows tag info", async () => {
    const data = await captureJson(() =>
      tag({ json: true, vault: v.path, name: "project" }),
    );
    expect(data.count).toBe(2);
  });

  test("shows verbose with files", async () => {
    const data = await captureJson(() =>
      tag({ json: true, vault: v.path, name: "urgent", verbose: true }),
    );
    expect(data.count).toBe(2);
    expect((data.files as string[]).length).toBe(2);
  });
});
