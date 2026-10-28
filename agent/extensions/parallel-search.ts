/**
 * parallel-search — Parallel's web-search MCP server with an optional API key.
 *
 * Why an extension instead of a plain `mcp.json` entry: pi resolves `${VAR}`
 * references in `mcp.json` headers with `resolveHeadersOrThrow`, so a missing
 * PARALLEL_SEARCH_TOKEN fails the whole server at startup — and there is no
 * conditional-header syntax to fall back to anonymous access. Here the token
 * is read from the environment when the extension loads:
 *
 *   token set   → `Authorization: Bearer <token>` (authenticated tier)
 *   token unset → no Authorization header at all (Parallel's free anonymous tier)
 *
 * Token source, in order: the `export PARALLEL_SEARCH_TOKEN=` line in
 * ~/.config/uwsm/env.d/pi-mcp.sh (read fresh at every pi start, so a key
 * rotation needs only a pi restart — an old shell's exported copy cannot
 * shadow it), then process.env as the fallback when the file has no key.
 *
 * Either way the server connects, so `web_search` / `web_fetch` never fail for
 * lack of a key. Do not add a server named "parallel-search" to `mcp.json`:
 * an `mcp.json` entry takes precedence over this registration.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_FILE = join(homedir(), ".config", "uwsm", "env.d", "pi-mcp.sh");

function tokenFromFile(): string | undefined {
  try {
    const m = readFileSync(ENV_FILE, "utf8").match(/^\s*export\s+PARALLEL_SEARCH_TOKEN=(.*)$/m);
    const v = m?.[1].trim().replace(/^(['"])(.*)\1$/, "$2").trim();
    return v || undefined;
  } catch {
    return undefined; // missing/unreadable file → env fallback
  }
}

export default function (pi: ExtensionAPI): void {
  const token = tokenFromFile() ?? process.env.PARALLEL_SEARCH_TOKEN?.trim();

  pi.registerMcpServer("parallel-search", {
    url: "https://search.parallel.ai/mcp",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    exposure: "deferred",
    description:
      "Web search and page fetch (Parallel). Authenticated when PARALLEL_SEARCH_TOKEN is set, free anonymous tier otherwise.",
  });
}
