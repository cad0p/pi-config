// SPDX-License-Identifier: MIT
// Originally authored by Jason Diamond as part of jdiamond/pi-guard.
// Extracted and repackaged by cad0p as unbash-walker, with additional
// effective-cwd walker. See README for acknowledgments.

import * as path from "node:path";
import type { CommandRef } from "./types.ts";

export function getCommandName(cmd: CommandRef): string {
  if (cmd.node.name) return cmd.node.name.value;
  // Assignment-only command (e.g. TOKEN=$(...)): use the variable name
  if (cmd.node.prefix.length > 0 && cmd.node.prefix[0]?.name) {
    return cmd.node.prefix[0].name;
  }
  return "";
}

/** Returns true if this is a bare assignment (no command name, only prefix assignments).
 *  E.g. TOKEN=$(curl ...) — not a real command, just a variable assignment. */
export function isBareAssignment(cmd: CommandRef): boolean {
  return !cmd.node.name && cmd.node.prefix.length > 0;
}

export function getCommandArgs(cmd: CommandRef): string[] {
  return cmd.node.suffix.map((word) => word.value);
}

/**
 * Return the command name with any directory prefix stripped.
 *
 * Examples:
 *   /usr/bin/git push ... → "git"
 *   ./scripts/deploy.sh   → "deploy.sh"
 *   git                   → "git"
 *
 * Rule authors usually want to match the basename ("block git push --force")
 * regardless of whether the agent emitted a full path. `getCommandName`
 * preserves the raw name so rules that care about absolute paths can still
 * inspect it; `getBasename` is the ergonomic default for most matchers.
 *
 * Net-new helper — not present in pi-guard today.
 */
export function getBasename(cmd: CommandRef): string {
  const name = getCommandName(cmd);
  if (name === "") return "";
  return path.basename(name);
}
