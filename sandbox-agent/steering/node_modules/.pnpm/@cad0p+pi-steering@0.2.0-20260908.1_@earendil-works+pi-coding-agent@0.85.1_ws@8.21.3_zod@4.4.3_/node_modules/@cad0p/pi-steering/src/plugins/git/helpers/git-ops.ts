// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Raw git query helpers for the git plugin — reusable functions that
 * shell out to git and return trimmed raw data (or `null` on any
 * failure). Exposed so downstream plugins can compose per-directory
 * scans without re-implementing the shell invocations, and so the
 * predicates in this plugin stay thin pattern-matching wrappers
 * around the helpers.
 *
 * Each helper:
 *
 *   - takes `(ctx, cwd?)`; `cwd` defaults to `ctx.cwd`, letting
 *     callers iterate over per-subpackage git dirs (common in
 *     multi-package workspace contexts like `cr --all`).
 *   - returns the raw data on success, `null` on any failure
 *     (non-zero exit, spawn error, exception thrown inside
 *     `ctx.exec`). Callers layer their own "what does null mean"
 *     policy — predicates apply `onUnknown`; custom logic can
 *     inspect the null directly.
 *   - relies on the evaluator's per-tool_call `exec` memoization
 *     (`(cmd, args, cwd)` tuple) so multiple helpers reading the
 *     same repo state don't re-fork git.
 *
 * ## Consumer note
 *
 * The helpers return **raw query results** and are INTENTIONALLY free
 * of the `onUnknown` / pattern-matching layer. That layer lives in
 * `../predicates/`. If you want predicate-style semantics, call the
 * matching `when.*` handler (also re-exported from the plugin index)
 * rather than the helper.
 *
 * ## Branch caveat
 *
 * {@link getBranch} intentionally DOES NOT consult `walkerState.branch`
 * — the walker-state short-circuit is a predicate-layer concern (see
 * the `branch` predicate's JSDoc for the three-way tracker
 * discrimination). Downstream plugins iterating per-directory usually
 * care about the on-disk branch at each directory, not the
 * walker-tracked branch of the current bash chain at `ctx.cwd`; the
 * helper therefore always shells out.
 */

import type { PredicateContext } from "../../../schema.ts";

/**
 * Run a git command in the given cwd and return its trimmed stdout on
 * exit 0, or `null` on any failure. Thin wrapper used by every helper
 * here so failure modes (non-zero exit, spawn error, exception)
 * collapse to a uniform `null`.
 */
async function tryGit(
  ctx: PredicateContext,
  args: readonly string[],
  cwd?: string,
): Promise<string | null> {
  try {
    const opts = cwd !== undefined ? { cwd } : { cwd: ctx.cwd };
    const res = await ctx.exec("git", [...args], opts);
    if (res.exitCode !== 0) return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * `git branch --show-current` at `cwd` (default: `ctx.cwd`). Returns
 * the current branch name, or `null` when the command fails OR stdout
 * is empty (detached HEAD).
 *
 * Does NOT consult `ctx.walkerState.branch` — see file header
 * "Branch caveat" for why. Predicates that need the walker-state
 * short-circuit should use the `branch` predicate handler instead.
 */
export async function getBranch(
  ctx: PredicateContext,
  cwd?: string,
): Promise<string | null> {
  const out = await tryGit(ctx, ["branch", "--show-current"], cwd);
  if (out === null || out.length === 0) return null;
  return out;
}

/**
 * `git rev-parse --abbrev-ref @{upstream}` at `cwd` (default:
 * `ctx.cwd`). Returns the tracking branch name (e.g. `origin/main`),
 * or `null` when no upstream is configured or the command fails.
 */
export async function getUpstream(
  ctx: PredicateContext,
  cwd?: string,
): Promise<string | null> {
  const out = await tryGit(
    ctx,
    ["rev-parse", "--abbrev-ref", "@{upstream}"],
    cwd,
  );
  if (out === null || out.length === 0) return null;
  return out;
}

/**
 * `git rev-list --count <wrt>..HEAD` at `cwd` (default: `ctx.cwd`).
 * Returns the number of commits HEAD is ahead of `wrt`, or `null`
 * when the command fails (e.g. `wrt` doesn't resolve, detached HEAD,
 * not a repo).
 *
 * `wrt` defaults to `@{upstream}`. Pass a specific ref like
 * `"origin/main"` when the upstream configuration isn't guaranteed.
 */
export async function getCommitsAhead(
  ctx: PredicateContext,
  wrt: string = "@{upstream}",
  cwd?: string,
): Promise<number | null> {
  const out = await tryGit(ctx, ["rev-list", "--count", `${wrt}..HEAD`], cwd);
  if (out === null) return null;
  const count = Number.parseInt(out, 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * `git diff --cached --quiet` at `cwd` (default: `ctx.cwd`). Exit
 * code discrimination:
 *
 *   - `0`  → no staged changes     → returns `false`
 *   - `1`  → staged changes exist  → returns `true`
 *   - anything else (spawn error, weird exit) → returns `null`
 */
export async function getStagedChanges(
  ctx: PredicateContext,
  cwd?: string,
): Promise<boolean | null> {
  try {
    const opts = cwd !== undefined ? { cwd } : { cwd: ctx.cwd };
    const res = await ctx.exec("git", ["diff", "--cached", "--quiet"], opts);
    if (res.exitCode === 0) return false;
    if (res.exitCode === 1) return true;
    return null;
  } catch {
    return null;
  }
}

/**
 * `git status --porcelain` at `cwd` (default: `ctx.cwd`). Returns
 * `true` when the working tree is clean (empty output), `false`
 * when dirty, `null` on any command failure.
 */
export async function getWorkingTreeClean(
  ctx: PredicateContext,
  cwd?: string,
): Promise<boolean | null> {
  const out = await tryGit(ctx, ["status", "--porcelain"], cwd);
  if (out === null) return null;
  return out.length === 0;
}

/**
 * `git config --get remote.origin.url` at `cwd` (default: `ctx.cwd`).
 * Returns the origin URL string, or `null` when no origin is
 * configured or the command fails.
 */
export async function getRemoteUrl(
  ctx: PredicateContext,
  cwd?: string,
): Promise<string | null> {
  const out = await tryGit(ctx, ["config", "--get", "remote.origin.url"], cwd);
  if (out === null || out.length === 0) return null;
  return out;
}
