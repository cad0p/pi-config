// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `definePredicate<T>` — ~5-LOC helper for declaring typed plugin
 * predicate handlers.
 *
 * Parallels {@link defineConfig} — pure pass-through at runtime, all
 * the value is in the type signature. Narrows the handler's first
 * argument to the supplied type parameter `T` so the body reads like
 * a plain function on typed args, without the author needing to
 * write the annotation twice (once on the declaration, once on the
 * handler's `args` parameter). The `PredicateHandler<T>` return
 * preserves that narrowing when the result is assigned to a local
 * variable; the {@link Plugin.predicates} registry slot then accepts
 * it cast-free via {@link AnyPredicateHandler} (= `PredicateHandler<any>`),
 * which uses TS bivariance to admit typed handlers directly.
 *
 * See ADR §10 for the motivating usage.
 */

import type { PredicateHandler } from "./schema.ts";

/**
 * Sugar for declaring a typed {@link PredicateHandler}. The handler
 * is returned unchanged at runtime; the generic parameter `T`
 * narrows the handler's `args` parameter to the author's intended
 * shape. Return type is `PredicateHandler<T>`, so authors threading
 * the result through local variables keep the narrowed arg type.
 * The registry slot at {@link Plugin.predicates} accepts the result
 * cast-free via {@link AnyPredicateHandler}.
 *
 * @example
 *   interface CommitFormatArgs {
 *     pattern: RegExp;
 *     onUnknown?: "allow" | "block";
 *   }
 *
 *   export const commitFormat = definePredicate<CommitFormatArgs>(
 *     (args, ctx) => {
 *       // `args` is narrowed to CommitFormatArgs here.
 *       const msg = extractCommitMessage(ctx.input.args ?? []);
 *       return args.pattern.test(msg);
 *     },
 *   );
 *
 *   // Plug into a plugin:
 *   export const gitPlugin: Plugin = {
 *     name: "git",
 *     predicates: { commitFormat },
 *   };
 */
export function definePredicate<T>(
  handler: PredicateHandler<T>,
): PredicateHandler<T> {
  return handler;
}
