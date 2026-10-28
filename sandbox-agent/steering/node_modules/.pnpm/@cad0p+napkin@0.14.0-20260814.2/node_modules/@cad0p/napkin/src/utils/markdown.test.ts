import { describe, expect, test } from "vitest";
import {
  extractHeadings,
  extractLinks,
  extractSection,
  extractTags,
  extractTasks,
  HeadingNotFoundError,
} from "./markdown.js";

describe("extractHeadings", () => {
  test("extracts headings with levels", () => {
    const content = "# Title\n\nSome text\n\n## Section\n\n### Sub";
    const headings = extractHeadings(content);
    expect(headings).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "Section", line: 5 },
      { level: 3, text: "Sub", line: 7 },
    ]);
  });

  test("returns empty for no headings", () => {
    expect(extractHeadings("Just text")).toEqual([]);
  });
});

describe("extractTasks", () => {
  test("extracts tasks with status", () => {
    const content =
      "# Tasks\n- [ ] Buy groceries\n- [x] Ship feature\n- [-] Cancelled";
    const tasks = extractTasks(content);
    expect(tasks).toEqual([
      { line: 2, status: " ", text: "Buy groceries", done: false },
      { line: 3, status: "x", text: "Ship feature", done: true },
      { line: 4, status: "-", text: "Cancelled", done: false },
    ]);
  });

  test("handles indented tasks", () => {
    const content = "  - [ ] Indented task";
    const tasks = extractTasks(content);
    expect(tasks.length).toBe(1);
    expect(tasks[0].text).toBe("Indented task");
  });

  test("returns empty for no tasks", () => {
    expect(extractTasks("No tasks here")).toEqual([]);
  });
});

describe("extractTags", () => {
  test("extracts inline tags", () => {
    const content = "Some text #project and #urgent/high stuff";
    const tags = extractTags(content);
    expect(tags).toContain("project");
    expect(tags).toContain("urgent/high");
  });

  test("deduplicates tags", () => {
    const content = "#tag1 text #tag1 more #tag2";
    const tags = extractTags(content);
    expect(tags).toEqual(["tag1", "tag2"]);
  });

  test("returns empty for no tags", () => {
    expect(extractTags("No tags")).toEqual([]);
  });
});

describe("extractLinks", () => {
  test("extracts wikilinks", () => {
    const content = "See [[Project A]] and [[Project B|alias]]";
    const links = extractLinks(content);
    expect(links.wikilinks).toEqual(["Project A", "Project B"]);
    expect(links.outgoing).toContain("Project A");
    expect(links.outgoing).toContain("Project B");
  });

  test("strips heading refs from wikilinks", () => {
    const content = "See [[Note#Section]]";
    const links = extractLinks(content);
    expect(links.wikilinks).toEqual(["Note"]);
  });

  test("extracts markdown links (internal only)", () => {
    const content = "[link](./other.md) and [ext](https://example.com)";
    const links = extractLinks(content);
    expect(links.outgoing).toContain("./other.md");
    expect(links.outgoing).not.toContain("https://example.com");
  });

  test("returns empty for no links", () => {
    const links = extractLinks("No links");
    expect(links.wikilinks).toEqual([]);
    expect(links.outgoing).toEqual([]);
  });
});

describe("extractSection", () => {
  test("extracts exact heading match", () => {
    const content = "# Title\n\n## Section\nSome text\n\n## Other";
    const section = extractSection(content, "Section");
    expect(section).toBe("## Section\nSome text\n");
  });

  test("extracts section with nested headings", () => {
    const content =
      "# Title\n\n## Section\nSome text\n\n### Subsection\nMore text\n\n## Other";
    const section = extractSection(content, "Section");
    expect(section).toBe(
      "## Section\nSome text\n\n### Subsection\nMore text\n",
    );
  });

  test("extracts section to end of file if no next heading", () => {
    const content = "# Title\n\n## Section\nSome text\n\nMore text";
    const section = extractSection(content, "Section");
    expect(section).toBe("## Section\nSome text\n\nMore text");
  });

  test("matches byte-for-byte including markdown formatting", () => {
    const content = "# Title\n\n## **Bold Section**\nText";
    const section = extractSection(content, "**Bold Section**");
    expect(section).toBe("## **Bold Section**\nText");
  });

  test("throws error with available headings if not found", () => {
    const content =
      "# Title\n\n## Section A\n\n## Section B\n\n## Section C\n\n## Section D\n\n## Section E\n\n## Section F";
    expect(() => extractSection(content, "Not Found")).toThrow(
      'Heading "Not Found" not found. Available headings:\n# Title\n## Section A\n## Section B\n## Section C\n## Section D\n...',
    );
  });

  test("throws specific error if file has no headings", () => {
    const content = "Just some plain text without any headings.";
    expect(() => extractSection(content, "Not Found")).toThrow(
      'Heading "Not Found" not found. The file contains no headings.',
    );
  });

  test("strips trailing # preceded by a space", () => {
    const content = "## Heading ##\nSome text.\n";
    const section = extractSection(content, "Heading");
    expect(section).toBe("## Heading ##\nSome text.\n");
  });

  test("strips trailing # with extra spaces", () => {
    const content = "## Heading 2 ##\nBody\n";
    const section = extractSection(content, "Heading 2");
    expect(section).toBe("## Heading 2 ##\nBody\n");
  });

  test("keeps trailing # without preceding space", () => {
    const content = "## Heading##\nBody\n";
    const section = extractSection(content, "Heading##");
    expect(section).toBe("## Heading##\nBody\n");
  });

  test("accepts ## prefix in heading parameter", () => {
    const content = "## Watchdog Recovery\nSome text.\n";
    const section = extractSection(content, "## Watchdog Recovery");
    expect(section).toBe("## Watchdog Recovery\nSome text.\n");
  });
});

describe("HeadingNotFoundError", () => {
  test("is an instance of HeadingNotFoundError and Error", () => {
    const content = "# Title\n\n## Section A\n";
    try {
      extractSection(content, "Not Found");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HeadingNotFoundError);
      expect(e).toBeInstanceOf(Error);
      expect((e as HeadingNotFoundError).heading).toBe("Not Found");
      expect((e as HeadingNotFoundError).headings).toHaveLength(2);
    }
  });

  test("has empty headings list when file has no headings", () => {
    const content = "Just plain text.";
    try {
      extractSection(content, "Anything");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HeadingNotFoundError);
      expect((e as HeadingNotFoundError).headings).toHaveLength(0);
      expect((e as Error).message).toContain("no headings");
    }
  });
});
