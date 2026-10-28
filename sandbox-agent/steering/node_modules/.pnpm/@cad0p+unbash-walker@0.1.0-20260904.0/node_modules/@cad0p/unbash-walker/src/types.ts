// SPDX-License-Identifier: MIT
// Originally authored by Jason Diamond as part of jdiamond/pi-guard.
// Extracted and repackaged by cad0p as unbash-walker, with additional
// effective-cwd walker. See README for acknowledgments.

import type { Command } from "unbash";

/** A concrete command node together with the source string its positions refer to. */
export interface CommandRef {
  node: Command;
  source: string;
  /** Group ID: commands in the same group are connected by operators
   * and displayed together. Different groups are separated by blank lines. */
  group: number;
  /** The operator connecting this command to the next ("|", "&&", "||", or ";").
   * Undefined for the last command in a group. */
  joiner?: "|" | "&&" | "||" | ";";
}
