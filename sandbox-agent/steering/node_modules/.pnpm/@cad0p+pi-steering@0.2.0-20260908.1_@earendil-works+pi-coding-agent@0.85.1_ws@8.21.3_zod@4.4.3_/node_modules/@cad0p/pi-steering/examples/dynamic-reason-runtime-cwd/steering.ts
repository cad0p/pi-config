// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: dynamic-reason + walker-unknown-cwd pattern.
 *
 * Demonstrates how external plugin authors compose runtime-cwd
 * predicates (gitPlugin's `isClean` / `hasStagedChanges` / `remote` /
 * `upstream` / `commitsAhead` — each inlines a walker-unknown-cwd
 * guard at the top of its handler and surfaces trinary `"unknown"`)
 * with informative agent-facing reasons that distinguish two
 * branches:
 *
 *   - Static cwd + predicate fires: domain-specific reason text
 *     (the working tree is genuinely dirty).
 *   - Walker-unknown cwd: `walkerUnknownCwdReason()` explains the
 *     walker couldn't statically resolve cwd, surfaces the actual
 *     `ctx.cwd`, and prompts a retry with a literal path. The
 *     example appends a small piece of domain-specific retry
 *     guidance after the helper's output.
 *
 * Drop this file in at `.pi/steering.ts` (or
 * `.pi/steering/index.ts`) to activate. The example uses gitPlugin's
 * `isClean` predicate to gate `npm run deploy` on a clean working
 * tree.
 */

import {
  defineConfig,
  type Plugin,
  type Rule,
  walkerUnknownCwdReason,
} from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

/**
 * Rule: block `npm run deploy` when the working tree isn't clean.
 *
 * The `reason` field is a {@link ReasonFn} that branches on
 * `ctx.walkerState?.cwd === "unknown"` to detect the
 * walker-unknown-cwd fail-CLOSED branch. gitPlugin's `isClean` inlines
 * a walker-unknown-cwd guard at the top of its handler and surfaces
 * trinary `"unknown"` when the walker can't statically resolve cwd;
 * the engine's leaf-level `onUnknown:` policy (default `"block"`)
 * projects to a definite `true` and the rule fires fail-CLOSED. On
 * that branch, `walkerUnknownCwdReason` produces the canonical
 * agent-facing explanation; the example appends domain-specific
 * retry guidance after it.
 */
const deployRequiresCleanTree = {
  name: "deploy-requires-clean-tree",
  tool: "bash",
  command: "npm",
  // `subcommand: ["run", "deploy"]` routes
  // the two-token subcommand (the old `/^npm\\s+run\\s+deploy\\b/`
  // anchor). npm facts are synthetic-minimal until an npm table
  // owns them: `prefix` keeps `npm --prefix <dir> run deploy`
  // routed (a value-taking global before the subcommand).
  // Canonical positive form: `isClean: false` ("fires when dirty")
  // reads forward and lets per-leaf modifiers attach at the leaf if
  // ever needed. The equivalent `not: { isClean: true }` form is also
  // safe under the new engine — the trinary `"unknown"` from the
  // inline walker-unknown-cwd guard composes via the not-block's
  // default block-level `onUnknown: "block"` to fire fail-CLOSED on
  // the walker-unknown branch — but `isClean: false` is the simpler
  // shape when no other leaves share the not-block. See README
  // "Why isClean: false over not: { isClean: true }" for the full
  // truth table.
  when: {
    subcommand: ["run", "deploy"],
    isClean: false,
  },
  reason: (ctx) => {
    if (ctx.walkerState?.cwd === "unknown") {
      // Walker couldn't statically resolve cwd. The handler's
      // inline guard surfaced trinary `"unknown"`; the engine's
      // default leaf-level `onUnknown: "block"` projected it to true
      // and the rule fired fail-CLOSED. Use the helper for a
      // consistent agent-facing explanation; append domain-specific
      // retry guidance.
      return (
        walkerUnknownCwdReason(ctx, "working tree status") +
        " Run from inside the package directory with a literal path."
      );
    }
    // Predicate fired with a known cwd: working tree is genuinely dirty.
    return "Working tree has uncommitted changes. Commit or stash before deploying.";
  },
} as const satisfies Rule;

/**
 * Minimal synthetic `npm` facts: just the value-taking global the
 * deploy routing needs. A fuller npm table (all globals) would route
 * every `npm --<global> ...` form; until one ships, this covers the
 * documented `npm run deploy` shape plus `--prefix`.
 */
const npmFacts = {
  name: "npm-facts",
  cliDescriptors: {
    npm: {
      flags: {
        prefix: { aliases: ["--prefix"], takesValue: true },
      },
    },
  },
} as const satisfies Plugin;

export default defineConfig({
  plugins: [gitPlugin, npmFacts],
  rules: [deployRequiresCleanTree],
});
