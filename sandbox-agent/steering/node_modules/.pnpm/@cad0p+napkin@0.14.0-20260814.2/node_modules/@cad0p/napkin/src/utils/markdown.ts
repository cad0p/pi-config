export interface Heading {
  level: number;
  text: string;
  line: number;
}

export class HeadingNotFoundError extends Error {
  heading: string;
  headings: Heading[];

  constructor(heading: string, headings: Heading[]) {
    if (headings.length === 0) {
      super(`Heading "${heading}" not found. The file contains no headings.`);
    } else {
      const available = headings
        .slice(0, 5)
        .map((h) => `${"#".repeat(h.level)} ${h.text}`)
        .join("\n");
      super(
        `Heading "${heading}" not found. Available headings:\n${available}${headings.length > 5 ? "\n..." : ""}`,
      );
    }
    this.name = "HeadingNotFoundError";
    this.heading = heading;
    this.headings = headings;
  }
}

/**
 * Extract a specific section from markdown content by heading.
 * Performs byte-for-byte exact match on the heading text (excluding the # prefix).
 * Stops exactly at the next heading of the same or higher level.
 * Throws an error if the heading is not found, listing up to 5 available headings.
 */
export function extractSection(content: string, heading: string): string {
  // Strip leading # characters so --section "## Heading" matches heading text "Heading"
  heading = heading.replace(/^#+\s*/, "");
  const lines = content.split("\n");
  let startLine = -1;
  let headingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].replace(/(\s)#+\s*$/, "$1").trimEnd();
      if (text === heading) {
        startLine = i;
        headingLevel = level;
        break;
      }
    }
  }

  if (startLine === -1) {
    const headings = extractHeadings(content);
    throw new HeadingNotFoundError(heading, headings);
  }

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match) {
      const level = match[1].length;
      if (level <= headingLevel) {
        endLine = i;
        break;
      }
    }
  }

  return lines.slice(startLine, endLine).join("\n");
}

export interface Task {
  line: number;
  status: string;
  text: string;
  done: boolean;
}

export interface LinkInfo {
  outgoing: string[];
  wikilinks: string[];
}

/**
 * Extract headings from markdown content.
 */
export function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].replace(/(\s)#+\s*$/, "$1").trimEnd(),
        line: i + 1,
      });
    }
  }
  return headings;
}

/**
 * Extract tasks (checkboxes) from markdown content.
 */
export function extractTasks(content: string): Task[] {
  const tasks: Task[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^[\s]*[-*]\s+\[(.)\]\s+(.*)$/);
    if (match) {
      const status = match[1];
      tasks.push({
        line: i + 1,
        status,
        text: match[2].trim(),
        done: status === "x" || status === "X",
      });
    }
  }
  return tasks;
}

/**
 * Extract tags from markdown content (both inline #tags and frontmatter tags).
 */
export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  // Inline tags: #tag (not inside code blocks or links)
  const tagRegex = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;
  for (
    let match = tagRegex.exec(content);
    match !== null;
    match = tagRegex.exec(content)
  ) {
    tags.add(match[1]);
  }
  return [...tags].sort();
}

/**
 * Extract links from markdown content.
 */
export function extractLinks(content: string): LinkInfo {
  const wikilinks: string[] = [];
  const outgoing: string[] = [];

  // Wikilinks: [[target]] or [[target|alias]]
  const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  for (
    let match = wikiRegex.exec(content);
    match !== null;
    match = wikiRegex.exec(content)
  ) {
    const target = match[1].trim();
    // Strip heading/block refs
    const clean = target.split("#")[0].trim();
    if (clean) {
      wikilinks.push(clean);
      outgoing.push(clean);
    }
  }

  // Markdown links: [text](url)
  const mdRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  for (
    let match = mdRegex.exec(content);
    match !== null;
    match = mdRegex.exec(content)
  ) {
    const url = match[2].trim();
    // Only internal links (not http/https/mailto)
    if (!url.match(/^(https?|mailto|obsidian):\/\//)) {
      const clean = decodeURIComponent(url.split("#")[0].trim());
      if (clean) outgoing.push(clean);
    }
  }

  return { outgoing, wikilinks };
}
