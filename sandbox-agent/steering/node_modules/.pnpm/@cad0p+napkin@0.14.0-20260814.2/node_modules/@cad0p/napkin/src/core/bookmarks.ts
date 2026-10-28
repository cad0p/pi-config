import * as fs from "node:fs";
import * as path from "node:path";

export interface Bookmark {
  type: string;
  title?: string;
  path?: string;
  query?: string;
  url?: string;
  subpath?: string;
  items?: Bookmark[];
}

export function readBookmarks(obsidianPath: string): Bookmark[] {
  const configPath = path.join(obsidianPath, "bookmarks.json");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content) as Bookmark[];
  } catch {
    return [];
  }
}

function writeBookmarks(obsidianPath: string, bookmarks: Bookmark[]): void {
  const configPath = path.join(obsidianPath, "bookmarks.json");
  fs.writeFileSync(configPath, JSON.stringify(bookmarks, null, 2));
}

export function flattenBookmarks(items: Bookmark[]): Bookmark[] {
  const result: Bookmark[] = [];
  for (const item of items) {
    if (item.type === "group" && item.items) {
      result.push(...flattenBookmarks(item.items));
    } else {
      result.push(item);
    }
  }
  return result;
}

export function addBookmark(
  obsidianPath: string,
  entry: Bookmark,
): { added: Bookmark } {
  const items = readBookmarks(obsidianPath);
  items.push(entry);
  writeBookmarks(obsidianPath, items);
  return { added: entry };
}
