// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

import type { Word } from "@cad0p/pi-steering";

/**
 * Shape accepted by `when.requiresFlag`.
 *
 * At least one of {@link flag} / {@link flags} / {@link env} / {@link envs}
 * MUST be specified. The predicate fires (rule BLOCKS — i.e. the flag
 * is MISSING) when none of the listed flag / env equivalents appear in
 * `ctx.input.args` / `ctx.input.envAssignments`.
 *
 * @example
 * // Single flag (shorthand).
 * when: { requiresFlag: "--profile" }
 *
 * // Single flag, object form.
 * when: { requiresFlag: { flag: "--profile" } }
 *
 * // One of several alternative flags (short + long form).
 * when: { requiresFlag: { flags: ["--profile", "-p"] } }
 *
 * // Flag OR equivalent env var (e.g. `AWS_PROFILE=x aws ...`).
 * when: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } }
 *
 * // Multiple envs.
 * when: {
 *   requiresFlag: { flag: "--region", envs: ["AWS_REGION", "AWS_DEFAULT_REGION"] }
 * }
 */
export interface RequiresFlagArgs {
  /** Single required flag (e.g. `"--profile"`). */
  flag?: string;
  /** Any one of these flags satisfies. Treated as OR. */
  flags?: readonly string[];
  /** Env-var name that also satisfies (shell form: `VAR=value cmd ...`). */
  env?: string;
  /** Env-var names that also satisfy. Treated as OR. */
  envs?: readonly string[];
}

/**
 * Shape accepted by `when.requiresFlagValue`.
 *
 * Fires (rule BLOCKS) when the LAST-wins value of any listed alias is
 * absent, valueless, or does not satisfy `matches` — gh/cobra/pflag
 * semantics: repeated flags override earlier occurrences.
 *
 * An ABSENT flag counts as unmet (fail-closed): a rule that requires
 * a matching value must block when the flag isn't there at all.
 *
 * @example
 * // gh pr merge: --subject / -t must carry a closing keyword.
 * // (Compose with the info-only carve-out so `--help` still passes.)
 * when: {
 *   not: { infoOnly: { extraFlags: ["-h"] } },
 *   requiresFlagValue: {
 *     flags: ["--subject", "-t"],
 *     matches: /\b(closes?|fixe?s?|resolves?)\s+#\d+\b|(^|\s)#\d+/i,
 *   },
 * }
 */
export interface RequiresFlagValueArgs {
  /** Aliases of ONE logical flag; OR'd at every scanned position. */
  flags: readonly string[];
  /** Pattern the effective value must satisfy. */
  matches: RegExp;
}

/**
 * Shape accepted by `when.infoOnly`.
 *
 * The predicate fires (rule BLOCKS) when the command IS an info-only
 * invocation (token-level, quote-aware). Bare shorthand
 * `infoOnly: true` checks the default set (`--help` / `--version`);
 * `false` never fires.
 *
 * @example
 * // Default set (--help / --version only).
 * when: { infoOnly: true }
 *
 * // Default set plus an additive extra flag (e.g. for a CLI whose
 * // help lives on -h). Nothing can remove the safe core.
 * when: { infoOnly: { extraFlags: ["-h"] } }
 *
 * // Carve-out idiom — ALLOW info-only invocations (the when clause
 * // is an AND: a naive `when: { infoOnly: true }` would BLOCK on help).
 * when: { not: { infoOnly: true } }
 */
export interface InfoOnlyArgs {
  /**
   * Additional info-only flags to check in ADDITION to the default
   * `--help` / `--version` set. `-h` / `-v` are deliberately NOT in
   * the default set (they are real operations in commands like
   * `docker run -v /data:/data` or `curl -v`); a rule author adding
   * them here owns that security tradeoff for their own CLI.
   */
  extraFlags?: readonly string[];
}

/**
 * Shape accepted by `when.allowlistedFlagsOnly`.
 *
 * The predicate fires (rule BLOCKS) when any token in `ctx.input.args`
 * looks like a flag (`startsWith("-")`) and is NOT in {@link allow},
 * NOT matched by an auto-derived `--flag=` prefix of an allowed flag,
 * and NOT matched by an explicit {@link allowPrefixes} entry.
 *
 * @example
 * when: {
 *   allowlistedFlagsOnly: {
 *     allow: ["--all", "--description", "--reviewers", "-h", "--help"],
 *     // `--description=...` and `--reviewers=...` are auto-allowed
 *     // because those flags are in `allow` and start with `--`.
 *     // Use `allowPrefixes` only for non-`--` prefix matches.
 *   },
 * }
 */
export interface AllowlistedFlagsOnlyArgs {
  /** Bare flag tokens that are always allowed. */
  allow: readonly string[];
  /**
   * Token prefixes that count as allowed (useful for short-flag
   * attached-value forms like `-ofoo`). Tokens in {@link allow} that
   * start with `--` are AUTOMATICALLY treated as allowed prefixes
   * under their `=` form \u2014 only supply this for cases where prefix
   * matching differs from that default.
   */
  allowPrefixes?: readonly string[];
}

/**
 * Re-export for plugin author ergonomics: when building helpers on top
 * of this plugin's primitives, match the public `Word` shape pi-steering
 * exposes rather than reimporting from `unbash-walker`.
 */
export type { Word };
