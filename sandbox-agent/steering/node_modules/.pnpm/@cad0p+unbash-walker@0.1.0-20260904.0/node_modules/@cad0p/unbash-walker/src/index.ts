// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * unbash-walker — utility for walking unbash `Script` trees.
 *
 * Provides three layers over raw unbash ASTs:
 *   1. Command extraction — flatten a Script down to the list of Command
 *      nodes that actually run, including commands inside `$(...)` / `<(...)`.
 *   2. Wrapper expansion — recursively peel wrapper commands (sh -c, sudo,
 *      env, xargs, find -exec, ...) so rule authors can see the underlying
 *      command they guard against.
 *   3. Walker state tracking — an extensible tracker registry (`walk`) that
 *      threads arbitrary per-command state (cwd, branch, …) through the
 *      AST. Built-in `cwdTracker` covers `cd`, `git -C`, `make -C`,
 *      `env -C`. Plugins extend the registry with new dimensions.
 *
 * Consumers still import `parse` from the `unbash` package itself;
 * we re-export the most useful types for convenience.
 */

export type { Command, Node, Script, Word, WordPart } from "unbash";
// Re-export for convenience; consumers can still `import { parse } from "unbash"`.
export { parse } from "unbash";
export {
  createExtractCtx,
  type ExtractCtx,
  extractAllCommandsFromAST,
} from "./extract.ts";
export { formatCommand, truncate } from "./format.ts";
export {
  getBasename,
  getCommandArgs,
  getCommandName,
  isBareAssignment,
} from "./resolve.ts";

export {
  expandTildeIfLeading,
  resolveWord,
  resolveWordText,
} from "./resolve-word.ts";
export {
  bundleContains,
  DEFAULT_POSITION_POLICIES,
  getSubcommandWords,
  locateSubcommandRun,
  type PositionPolicy,
  type SubcommandOptions,
  type SubcommandRun,
} from "./subcommand.ts";
export {
  isStaticallyResolvable,
  type Modifier,
  type SubshellSemantics,
  type Tracker,
  type WalkResult,
  walk,
} from "./tracker.ts";
export { cwdTracker } from "./trackers/cwd.ts";
export { type EnvState, envTracker } from "./trackers/env.ts";
export type { CommandRef } from "./types.ts";
export {
  type ExpansionResult,
  expandWrapperCommands,
  formatWrapperDisplay,
  WRAPPER_COMMANDS,
  type WrapperSpec,
} from "./wrappers.ts";
