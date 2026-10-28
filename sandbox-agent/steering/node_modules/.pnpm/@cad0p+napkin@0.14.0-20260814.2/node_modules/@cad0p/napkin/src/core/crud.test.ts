import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import { readFile } from "./crud.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

afterEach(() => {
  v.cleanup();
});

describe("readFile with section support", () => {
  beforeEach(() => {
    v = createTempVault({
      "sectioned.md": [
        "# Title",
        "",
        "## Introduction",
        "Some intro text.",
        "",
        "## Methods",
        "Method details here.",
        "",
        "### Step 1",
        "First step.",
        "",
        "### Step 2",
        "Second step.",
        "",
        "## Results",
        "Final results.",
      ].join("\n"),
    });
  });

  test("reads entire file without options", () => {
    const result = readFile(v.vaultPath, "sectioned.md");
    expect(result.content).toContain("# Title");
    expect(result.content).toContain("## Results");
    expect(result.totalPages).toBeUndefined();
    expect(result.currentPage).toBeUndefined();
  });

  test("extracts a section by heading", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Methods",
    });
    expect(result.content).toContain("## Methods");
    expect(result.content).toContain("### Step 1");
    expect(result.content).toContain("### Step 2");
  });

  test("extracts a nested subsection", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Step 1",
    });
    expect(result.content).toBe("### Step 1\nFirst step.\n");
  });

  test("throws on missing section", () => {
    expect(() =>
      readFile(v.vaultPath, "sectioned.md", { section: "Nonexistent" }),
    ).toThrow('Heading "Nonexistent" not found');
  });

  test("does not paginate when content fits pageSize", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Introduction",
      pageSize: 1000,
    });
    expect(result.totalPages).toBeUndefined();
    expect(result.currentPage).toBeUndefined();
  });

  test("paginates content exceeding pageSize", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      pageSize: 50,
    });
    expect(result.totalPages).toBeGreaterThan(1);
    expect(result.currentPage).toBe(1);
    expect(result.content).toContain("[Page 1 of");
    expect(result.content).toContain("Use --page 2 to continue.]");
    expect(result.content).toContain(
      "HINT: Use napkin outline --file <file> to see its structure.",
    );
  });

  test("returns second page when requested", () => {
    const page1 = readFile(v.vaultPath, "sectioned.md", { pageSize: 50 });
    const page2 = readFile(v.vaultPath, "sectioned.md", {
      pageSize: 50,
      page: 2,
    });
    expect(page2.currentPage).toBe(2);
    expect(page2.content).not.toBe(page1.content);
  });

  test("paginates within section content", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Methods",
      pageSize: 20,
    });
    expect(result.totalPages).toBeGreaterThan(1);
    expect(result.currentPage).toBe(1);
  });

  test("last page does not include continuation hint", () => {
    const result = readFile(v.vaultPath, "sectioned.md", { pageSize: 50 });
    const lastPage = readFile(v.vaultPath, "sectioned.md", {
      pageSize: 50,
      page: result.totalPages,
    });
    expect(lastPage.content).not.toContain("Use --page");
  });

  test("last page includes outline hint but no continuation hint", () => {
    const result = readFile(v.vaultPath, "sectioned.md", { pageSize: 50 });
    const lastPage = readFile(v.vaultPath, "sectioned.md", {
      pageSize: 50,
      page: result.totalPages,
    });
    expect(lastPage.content).not.toContain("Use --page");
    expect(lastPage.content).toContain(
      "HINT: Use napkin outline --file <file> to see its structure.",
    );
  });

  test("page output never exceeds the page size (suffix budgeted into chunk)", () => {
    const big = `# Big\n\n${"needle ".repeat(12_000)}`; // ~72KB
    const v2 = createTempVault({ "big.md": big });
    try {
      const page1 = readFile(v2.vaultPath, "big.md");
      const page2 = readFile(v2.vaultPath, "big.md", { page: 2 });

      expect(page1.totalPages).toBe(2);
      // page hint + outline nudge are reserved inside the chunk budget
      expect(page1.content.length).toBeLessThanOrEqual(50_000);
      expect(page2.content.length).toBeLessThanOrEqual(50_000);
      expect(page1.content).toContain(
        "[Page 1 of 2. Use --page 2 to continue.]",
      );
      // full body still arrives across the pages, suffixes stripped
      const strip = (s: string) =>
        s
          .replace("\n\n[Page 1 of 2. Use --page 2 to continue.]", "")
          .replace(
            "\n\nHINT: Use napkin outline --file <file> to see its structure.",
            "",
          );
      expect(strip(page1.content) + strip(page2.content)).toBe(big);
    } finally {
      v2.cleanup();
    }
  });

  test("page output stays within pageSize when totalPages rolls past 999999 (7-digit hint)", () => {
    // SDK-side regression for the page-size boundary flake
    // (cad0p/pi-napkin issue #49): the reserve used a hardcoded 6-digit
    // worst-case page hint ("…Page 999999 of 999999…", 58 chars), but the
    // hint for page 999999 of a 7-digit total ("…Page 999999 of 1000000…")
    // is 1 char longer, so page output exceeded pageSize by 1 on files
    // with >= 1,000,000 pages. The reserve is now computed from the
    // actual page-count magnitude (convergent recompute).
    //
    // pageSize 125 + 5,000,000 chars: initial budget = 125 − 58 − 62 = 5
    // → totalPages = 1,000,000 (7 digits) → recomputed budget = 125 − 60
    // − 62 = 3 → totalPages = 1,666,667. The old code emitted
    // 5 + 59 + 62 = 126 > 125 on page 999999.
    const big = "x".repeat(5_000_000);
    const v2 = createTempVault({ "big.md": big });
    try {
      const first = readFile(v2.vaultPath, "big.md", { pageSize: 125 });
      const rollover = readFile(v2.vaultPath, "big.md", {
        pageSize: 125,
        page: 999_999,
      });
      const lastPageNum = first.totalPages ?? 1;
      const last = readFile(v2.vaultPath, "big.md", {
        pageSize: 125,
        page: lastPageNum,
      });

      expect(first.totalPages).toBeGreaterThanOrEqual(1_000_000);
      // the long 7-digit hint is exactly what the reserve must cover
      expect(rollover.content).toContain("[Page 999999 of");
      expect(rollover.content).toContain("Use --page 1000000 to continue.]");
      expect(first.content.length).toBeLessThanOrEqual(125);
      expect(rollover.content.length).toBeLessThanOrEqual(125);
      expect(last.content.length).toBeLessThanOrEqual(125);
      // last page carries no continuation hint
      expect(last.content).not.toContain("Use --page");
    } finally {
      v2.cleanup();
    }
  });

  test("extracts section via wikilink heading", () => {
    const result = readFile(v.vaultPath, "[[sectioned#Methods]]");
    expect(result.content).toContain("## Methods");
    expect(result.content).toContain("### Step 1");
    expect(result.content).toContain("### Step 2");
    expect(result.content).not.toContain("## Results");
    expect(result.content).not.toContain("## Introduction");
  });

  test("--section flag takes precedence over wikilink heading", () => {
    const result = readFile(v.vaultPath, "[[sectioned#Methods]]", {
      section: "Introduction",
    });
    expect(result.content).toContain("## Introduction");
    expect(result.content).not.toContain("## Methods");
  });

  test("rejects page 0", () => {
    expect(() =>
      readFile(v.vaultPath, "sectioned.md", { pageSize: 50, page: 0 }),
    ).toThrow("Invalid page: 0. Valid range:");
  });

  test("rejects negative page", () => {
    expect(() =>
      readFile(v.vaultPath, "sectioned.md", { pageSize: 50, page: -1 }),
    ).toThrow("Invalid page: -1. Valid range:");
  });

  test("rejects page exceeding total pages", () => {
    const result = readFile(v.vaultPath, "sectioned.md", { pageSize: 50 });
    const overflowPage = (result.totalPages ?? 1) + 1;
    expect(() =>
      readFile(v.vaultPath, "sectioned.md", {
        pageSize: 50,
        page: overflowPage,
      }),
    ).toThrow(`Invalid page: ${overflowPage}. Valid range:`);
  });
});
