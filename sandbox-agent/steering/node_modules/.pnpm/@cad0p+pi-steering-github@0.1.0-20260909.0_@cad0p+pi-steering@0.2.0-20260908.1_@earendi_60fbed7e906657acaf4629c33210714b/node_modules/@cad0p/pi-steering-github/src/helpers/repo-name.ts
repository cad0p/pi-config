// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `repoName` — repository name from a cwd: origin URL basename
 * (`git config --get remote.origin.url`, `.git` suffix stripped);
 * falls back to the cwd folder name when the remote is unresolvable
 * (user decision 2026-08-14). `null` only when both fail — caller
 * treats as missing.
 */

import { basename } from "node:path";
import type { PredicateContext } from "@cad0p/pi-steering";

export async function repoName(
  ctx: PredicateContext,
  cwd: string,
): Promise<string | null> {
  try {
    const res = await ctx.exec(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd },
    );
    const url = res.stdout?.trim() ?? "";
    if (res.exitCode === 0 && url !== "") {
      const name = basename(url).replace(/\.git$/, "");
      if (name !== "") return name;
    }
  } catch {
    // fall through to the cwd-basename fallback
  }
  const name = basename(cwd);
  return name !== "" ? name : null;
}
