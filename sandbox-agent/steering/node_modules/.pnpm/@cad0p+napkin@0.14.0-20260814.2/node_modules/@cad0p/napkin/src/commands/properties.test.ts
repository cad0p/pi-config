import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import {
  properties,
  propertyRead,
  propertyRemove,
  propertySet,
} from "./properties.js";

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
    "note1.md": "---\ntitle: Alpha\nstatus: draft\n---\nBody",
    "note2.md": "---\ntitle: Beta\n---\nBody",
    "note3.md": "No frontmatter",
  });
});

afterEach(() => {
  v.cleanup();
});

describe("properties", () => {
  test("lists all properties", async () => {
    const data = await captureJson(() =>
      properties({ json: true, vault: v.path }),
    );
    expect(data.properties).toContain("title");
    expect(data.properties).toContain("status");
  });

  test("returns counts", async () => {
    const data = await captureJson(() =>
      properties({ json: true, vault: v.path, counts: true }),
    );
    const p = data.properties as Record<string, number>;
    expect(p.title).toBe(2);
    expect(p.status).toBe(1);
  });

  test("returns total", async () => {
    const data = await captureJson(() =>
      properties({ json: true, vault: v.path, total: true }),
    );
    expect(data.total).toBe(2);
  });
});

describe("propertyRead", () => {
  test("reads a property value", async () => {
    const data = await captureJson(() =>
      propertyRead({ json: true, vault: v.path, file: "note1", name: "title" }),
    );
    expect(data.value).toBe("Alpha");
  });
});

describe("propertySet", () => {
  test("sets a property", async () => {
    await captureJson(() =>
      propertySet({
        json: true,
        vault: v.path,
        file: "note1",
        name: "priority",
        value: "high",
      }),
    );
    const content = fs.readFileSync(
      path.join(v.vaultPath, "note1.md"),
      "utf-8",
    );
    expect(content).toContain("priority: high");
  });
});

describe("propertyRemove", () => {
  test("removes a property", async () => {
    await captureJson(() =>
      propertyRemove({
        json: true,
        vault: v.path,
        file: "note1",
        name: "status",
      }),
    );
    const content = fs.readFileSync(
      path.join(v.vaultPath, "note1.md"),
      "utf-8",
    );
    expect(content).not.toContain("status");
    expect(content).toContain("title: Alpha");
  });
});
