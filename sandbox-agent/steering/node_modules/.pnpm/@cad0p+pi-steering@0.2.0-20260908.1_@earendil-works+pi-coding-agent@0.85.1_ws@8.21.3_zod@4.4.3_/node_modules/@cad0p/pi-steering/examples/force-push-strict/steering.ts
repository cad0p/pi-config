// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: force-push-strict rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * NOTE (issue #65): the git plugin's `no-force-push` rule is SEALED —
 * it blocks every remote-history-rewrite form (`--force`,
 * `--force-with-lease`, `--force-if-includes`, bundled shorts like
 * `-uf`, leading-`+` refspecs like `git push origin +main`, and
 * `--mirror`) with a dedicated reason message. That makes this pack
 * REDUNDANT for its original purpose: the plugin's rule covers
 * everything here, and more. The pack is kept as a REFERENCE for the
 * disable-and-replace idiom — dropping a shipped rule via
 * `disabledRules` and installing your own rule under a new name —
 * which is the mechanism you'd use to customize (or loosen) any
 * shipped rule. Its routing + leaves mirror the sealed rule.
 *
 * Shape:
 *
 *   - `plugins: [gitPlugin, forcePushSignalPlugin]` declares the
 *     shipping plugin (since issue #72 nothing is engine-injected, so
 *     the rules only exist if the plugin is declared — and its names
 *     only typo-check if it is; the declaration also supplies the git
 *     CLI facts the replacement rule's `subcommand:` leaf resolves
 *     against) plus the inline single-predicate plugin that registers
 *     the replacement rule's named force signal below.
 *   - `disabledRules: ["no-force-push"]` drops the plugin's rule so
 *     ours owns the block message (otherwise its message would win
 *     on `git push --force`).
 *   - `no-force-push-strict` fires on `--force` (any position),
 *     `--force-with-lease`, `--force-if-includes`, bundled short
 *     flags (`-f`, `-uf`, `-fu`, `-nfv`), leading-`+` refspecs
 *     (`git push origin +main`), and `--mirror`. The `subcommand:
 *     "push"` leaf keeps the pre-subcommand flag coverage of the
 *     sealed rule (`git -C /path push --force`,
 *     `git -c key=val push --force`, `git --git-dir=/x push -f`).
 *
 * Scope note: the git plugin's `no-main-commit` also fires once the
 * plugin is declared. If that's not wanted, add
 * `disabledRules: ["no-force-push", "no-main-commit"]`.
 */

import {
  type BooleanLeafArgs,
  defineConfig,
  definePredicate,
  type Plugin,
  type PredicateShape,
  unwrapBooleanLeafArg,
} from "@cad0p/pi-steering";
import gitPlugin, { GIT_CLI_DESCRIPTOR } from "@cad0p/pi-steering/plugins/git";

/**
 * Force entries referenced BY VARIABLE from the owning plugin's table
 * (never hand-built literals in rules). One entry per spelling —
 * token matching is exact, so `--force` does not cover
 * `--force-with-lease`. Keep in sync with the plugin rule when the
 * push force surface grows.
 */
const { flags: gitFlags } = GIT_CLI_DESCRIPTOR;

declare global {
  /**
   * This pack's typed-predicate registry: one named signal consumed
   * via `when.isForcePushSignal` below. Single-file examples still
   * register (inline plugin literal, no `requires:` workaround) —
   * reusable/named logic belongs in the registry per ADR §13; the
   * `requires:` / `condition:` fn slots are one-off escape hatches
   * only, and `condition:` is FORBIDDEN in examples (CI-pinned).
   */
  interface PiSteeringPredicates {
    isForcePushSignal: PredicateShape<boolean>;
  }
}

/**
 * Named force-push signal (ADR §13: leaf-inexpressible OR gets a
 * name, never an inline `condition:`). Flag forms ride the derived
 * `hasFlag` over the table refs above; leading-`+` refspecs
 * (`git push origin +main`) ride a positional scan (`+main` is a
 * positional, not flag-shaped, so no `flag:` entry can express it).
 *
 * A REGISTERED `when:` leaf (via the inline `forcePushSignalPlugin`
 * below), alongside `subcommand: "push"` — not a `requires:`-wired
 * closure. A name carries its own unit tests and a registry entry;
 * an inline closure carries neither.
 */
const isForcePushSignal = definePredicate<BooleanLeafArgs>((args, ctx) => {
  // Shared public boolean-leaf unwrap (bare `boolean` |
  // `{ value, onUnknown? }` spread; malformed → undefined → false
  // fail-closed). Imported from the package root like any external
  // plugin would.
  const expected = unwrapBooleanLeafArg(args);
  if (typeof expected !== "boolean") return false;
  if (ctx.input.tool !== "bash") return false;
  const words = ctx.input.args;
  if (!Array.isArray(words)) return false;
  const signal =
    ctx.command.hasFlag([
      gitFlags.force,
      gitFlags.forceShort,
      gitFlags.forceWithLease,
      gitFlags.forceIfIncludes,
      gitFlags.mirror,
    ]) ||
    words.some((w) => {
      const v = w?.value ?? "";
      return v.length > 1 && v[0] === "+" && v[1] !== ":";
    });
  return signal === expected;
});

/**
 * Inline single-predicate plugin registering `isForcePushSignal`
 * under `when.isForcePushSignal`. Same doctrine as multi-file
 * plugins (see ../work-item-plugin) at single-file scale: declare,
 * register, consume by name.
 */
const forcePushSignalPlugin = {
  name: "force-push-signal",
  predicates: { isForcePushSignal },
} as const satisfies Plugin;

export default defineConfig({
  plugins: [gitPlugin, forcePushSignalPlugin],
  // Disable-and-replace idiom (kept as a reference): drop the plugin's
  // shipped rule so our custom rule owns the block-reason message.
  // Since issue #65 that rule is already strict — you only need this
  // idiom when you want a DIFFERENT policy or message than the
  // shipped one provides.
  disabledRules: ["no-force-push"],
  rules: [
    {
      name: "no-force-push-strict",
      tool: "bash",
      command: "git",
      // Mirrors the SEALED plugins/git no-force-push routing (issue
      // #65): `subcommand: "push"` plus the registered
      // `isForcePushSignal` leaf (see above — no `requires:`, no
      // `condition:` in examples, ever).
      when: {
        subcommand: "push",
        isForcePushSignal: true,
      },
      reason:
        "No force pushes of any kind, including --force-with-lease. Create a new commit, or reset + re-commit via a non-force path.",
    },
  ],
});
