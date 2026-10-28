// SPDX-License-Identifier: MIT
// Part of pi-steering.

import type {
  PredicateContext,
  TopLevelWhenClauseNoRecurse,
} from "../schema.ts";

/**
 * Generate the agent-facing reason text for the walker-unknown-cwd
 * fail-closed branch on runtime-cwd predicates.
 *
 * The pattern: a rule consumes a runtime-cwd predicate (gitPlugin's
 * `isClean` / `hasStagedChanges` / `remote` / `upstream` /
 * `commitsAhead`, or any external plugin's runtime-cwd predicate).
 * When the walker can't statically resolve cwd (e.g.,
 * `cd "$VAR" && cmd`), the predicate's inline guard surfaces trinary
 * `"unknown"`, the engine projects via the leaf-level (or block-level
 * inside `not:`) `onUnknown:` policy — default `"block"` fires the
 * rule. The rule's ReasonFn typically wants to:
 *
 *   1. Detect the walker-unknown case via
 *      `ctx.walkerState?.cwd === "unknown"`.
 *   2. Emit a message explaining what couldn't be verified, where the
 *      shell actually is (`ctx.cwd`), and prompt a retry with a
 *      literal cwd target.
 *
 * This helper produces the generic message. Domain-specific retry
 * guidance (e.g., "run cr from inside src/<Package>") composes at the
 * call site by string concatenation.
 *
 * Signature shape: `ctx` first matches the `walkerString` convention.
 * Reading `ctx.cwd` (not `process.cwd()`) keeps the helper pure,
 * testable via {@link mockContext}, and accurate when pi runs
 * predicates in sandboxed/forked contexts where `process.cwd()` may
 * diverge from the engine-resolved cwd.
 *
 * Naming convention: `walkerUnknown<Dimension>Reason`. Each plugin
 * owns its dimension's reason text. Cwd helper lives in pi-steering
 * core. Future `walkerUnknownBranchReason` would live in gitPlugin
 * alongside the branch tracker.
 *
 * @param ctx - the predicate context (passed through from the rule's
 *              ReasonFn).
 * @param verifying - what the predicate was trying to verify
 *                    (e.g., "branch", "upstream", "staged changes",
 *                    "commit count"). Required, non-empty; empty is
 *                    contract violation — not handled defensively.
 *
 * @example
 * ```ts
 * import { walkerUnknownCwdReason } from "@cad0p/pi-steering";
 *
 * export const myRule: Rule = {
 *   name: "deploy-requires-clean-tree",
 *   tool: "bash",
 *   command: "npm",
 *   when: {
 *     subcommand: ["run", "deploy"],
 *     isClean: false,
 *   },
 *   reason: (ctx) => {
 *     if (ctx.walkerState?.cwd === "unknown") {
 *       return walkerUnknownCwdReason(ctx, "working tree status");
 *     }
 *     return "Working tree has uncommitted changes. Commit or stash first.";
 *   },
 * };
 * ```
 *
 * @remarks Inside a `not:` block, the runtime-cwd predicate's
 *          `"unknown"` composes with the block-level `onUnknown:`
 *          (default `"block"` = fail-CLOSED). See {@link
 *          TopLevelWhenClauseNoRecurse} for the not-block-modifier-
 *          placement contract.
 */
export function walkerUnknownCwdReason(
  ctx: PredicateContext,
  verifying: string,
): string {
  return (
    `Could not verify ${verifying} — your command used a dynamic cwd ` +
    `target that couldn't be statically resolved (current directory: ` +
    `${ctx.cwd}). Retry with a literal path.`
  );
}
