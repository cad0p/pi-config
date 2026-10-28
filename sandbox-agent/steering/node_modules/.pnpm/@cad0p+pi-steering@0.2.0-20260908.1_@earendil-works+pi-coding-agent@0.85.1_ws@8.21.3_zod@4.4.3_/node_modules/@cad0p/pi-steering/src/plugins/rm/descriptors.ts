// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * rm plugin-owned CLI descriptor (issue #110 explicit-strict verdict).
 *
 * Verdict (2026-09-07, reviewed vs `rm --help` (GNU coreutils)): rm ships
 * NO value-taking surface — every flag is boolean (`-f/--force`, `-i`,
 * `-I`, `-r/-R/--recursive`, `-d/--dir`, `-v/--verbose`, `--one-file-system`,
 * `--no-preserve-root`, `--help`, `--version`) or optional-attached
 * (`--interactive[=WHEN]`, `--preserve-root[=all]` — attached-only, separate
 * never consumes, so takesValue:false by the --exec-path precedent).
 *
 * Explicit-strict `{ rm: { flags: {...} } }` is warranted (not absent-throw):
 * the engine binds `ctx.command` per ref for EVERY bash ref — without a
 * descriptor, `rm -rf /` would block with a missing-descriptor reason
 * instead of the rule's catastrophic-delete reason. The table carries
 * exactly the entries the `no-rm-rf-slash` rule's `hasRecursiveForce`
 * predicate matches (`recursive`, `force` — issue #117); every other
 * rm flag stays unlisted (bool flags stay present-but-valueless,
 * attached `--flag=x` still applies per-token).
 */

import type { CLIDescriptor, CLIFlag } from "../../schema.ts";

/**
 * `recursive` flag entry (`-r` / `-R` / `--recursive`).
 *
 * `--help`-pinned (GNU coreutils `rm --help`): `-r, -R, --recursive`
 * — remove directories and their contents recursively. Boolean
 * (takesValue: false — no value-taking surface on rm, #110 verdict
 * stands).
 *
 * Shared by the descriptor table below and the `hasRecursiveForce`
 * predicate (single source — the table and the rule can't drift).
 */
export const RM_RECURSIVE_FLAG = {
  aliases: ["-r", "-R", "--recursive"],
  takesValue: false,
} as const satisfies CLIFlag;

/**
 * `force` flag entry (`-f` / `--force`).
 *
 * `--help`-pinned (GNU coreutils `rm --help`): `-f, --force` —
 * ignore nonexistent files and arguments, never prompt. Boolean.
 *
 * Shared by the descriptor table below and the `hasRecursiveForce`
 * predicate (single source — the table and the rule can't drift).
 */
export const RM_FORCE_FLAG = {
  aliases: ["-f", "--force"],
  takesValue: false,
} as const satisfies CLIFlag;

/**
 * rm descriptor: explicit strict (no value-taking surface).
 *
 * The `recursive` + `force` entries (issue #117) back the
 * `no-rm-rf-slash` rule's `hasRecursiveForce` predicate: the
 * predicate matches through the bound facade's `hasFlag`
 * (entry spellings) with the bound table's glue set (bundle
 * truncation) — an empty `{ flags: {} }` satisfies neither. Both
 * `--help`-pinned, both shared consts with the predicate so table
 * and rule stay byte-equal.
 *
 * Referenced by name (never inlined) in the plugin literal so hover
 * rides on this const.
 */
export const RM_CLI_DESCRIPTOR = {
  flags: {
    recursive: RM_RECURSIVE_FLAG,
    force: RM_FORCE_FLAG,
  },
} as const satisfies CLIDescriptor;
