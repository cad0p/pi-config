// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Context-provided command facade (issue #101; #110 entry-only rebind).
 *
 * A `SteeringCommand` is a bound view over one already-parsed
 * {@link PredicateToolInput}: the engine builds it per command ref from
 * `input.args` + `input.envAssignments` (see `commandFromInput`), so
 * rule code never threads bare `Word[]` arrays by hand. `mockContext`
 * builds the same view, so unit-tested predicates see it too.
 *
 * Each flag method delegates to the mechanism in `./flags.ts` with identical
 * precedence/edge semantics (`matchFlagAt` exact → attached → glued;
 * quote-aware `.value`-first reads). `positionals()` adds the bound
 * positional view over the same snapshot with the same bound consuming
 * set — consumption and skipping cannot diverge.
 *
 * Bound invariant: passed entries select SPELLINGS only; consumption/glue
 * ALWAYS come from the bound `ResolvedArity`, never from a passed entry's
 * `takesValue` (via the module-private `boundEntryViews` adapter).
 *
 * Deliberate non-goals:
 *
 *   - No exported string→words lexer. The walker already parsed the
 *     command into `ctx.input.args` (quote-aware); a second lexing
 *     implementation would be drift by construction. String holders
 *     migrate at the rule level by reading `ctx.command`.
 *   - No `resolve: "first"` option. First-wins models no real parser
 *     (ADR 2026-08-21); only last-wins (`getFlagValue`) + all-values
 *     (`getAllFlagValues`) exist.
 *   - Join policy lives in consumers, never core — e.g. git
 *     concatenates repeated `-m` with `"\n\n"` at the rule level.
 */

import type { Word } from "@cad0p/unbash-walker";
import { EMPTY_ARITY, type ResolvedArity } from "../arity.ts";
import type { CLIFlag, PredicateToolInput } from "../schema.ts";
import {
  flagPresenceScan,
  getAllFlagValues,
  getFlagValue,
  hasEnvAssignment,
  isInfoOnly,
} from "./flags.ts";

/**
 * Bound view over one parsed tool input's argv + env-prefix words.
 *
 * Built once per command ref by the engine (`ctx.command`) or on
 * demand via {@link commandFromInput} for out-of-handler / test use.
 *
 * Table-bound arity (issue #110): the bound methods take entries only —
 * the `commandFromInput(input, arity)` binding carries the
 * descriptor-resolved arity, so consumption and skipping cannot diverge.
 * The engine resolves via the registry before binding and throws
 * `MissingDescriptorError` for undeclared basenames; an omitted arity
 * (direct/test use) means explicit-strict empty.
 *
 * Obscure binaries (no owning plugin): rule authors declare argv
 * facts via an inline plugin literal — NO new top-level config field,
 * NO leaf-inline escape hatch (a second channel would recreate the
 * drift #106 killed):
 * `plugins: [{ name: "my-facts", cliDescriptors: { mycli: { flags: {
 * repo: { aliases: ["-R"], takesValue: true } } } } }]` — or
 * `{ mycli: {} }` for explicit strict. Absent basename →
 * `MissingDescriptorError` (loud).
 */
export interface SteeringCommand {
  /**
   * `true` if the command carries any listed flag entry: bare token,
   * attached `--flag=value` token, declared consuming-flag values
   * skipped by position, and short bundles — always-on for
   * single-char shorts with table-derived glue + lead-letter
   * truncation (`-uf` counts for `-f`; `-Rfoo` with `R` declared
   * counts for `R` but never for `f`; longs never bundle-match).
   * Delegates to the shared `flagPresenceScan` with the bound argv
   * words, the requested spellings (via the `boundEntryViews`
   * adapter), and the bound table-derived sets — the SAME code path
   * as the `when.flag` leaf (issue #123), so facade and leaf agree
   * structurally, not aspirationally. There is no bundle-blind
   * variant: a blind `hasFlag` disagreed with the leaf on bundled
   * bool shorts (the `-uf` fail-open hole).
   */
  hasFlag(flag: CLIFlag | readonly CLIFlag[]): boolean;

  /**
   * Value of the LAST occurrence of any listed flag entry, or `null`
   * if absent or present-but-valueless. Delegates to `getFlagValue`
   * (last-wins) with the bound argv words through the adapter.
   */
  getFlagValue(flags: CLIFlag | readonly CLIFlag[]): string | null;

  /**
   * Values of EVERY occurrence of any listed flag entry, in argv
   * order, or `[]` if absent or present-but-valueless. Delegates to
   * `getAllFlagValues` through the adapter. Consumers apply their own
   * join policy (e.g. git's `"\n\n"` for repeated `-m`).
   */
  getAllFlagValues(flags: CLIFlag | readonly CLIFlag[]): string[];

  /**
   * Resolved positional operands left→right, INCLUDING the subcommand
   * run (`git push origin :branch` → `["push","origin",":branch"]`).
   * Skips: the `--` token itself (everything after it surfaces
   * verbatim), attached `--flag=value` tokens, declared consuming
   * flags + their values (BY POSITION), and opaque single-dash
   * multi-char units (bundles like `-fdx`, glued `-X<rest>` — never
   * decomposed without bound glue knowledge). Clean `--long` /
   * `-x` flag-words that are not declared-consuming surface as
   * themselves (registry-only arity pin: `push --delete origin` keeps
   * both `--delete` and `origin`). Total: never throws.
   */
  positionals(): string[];

  /**
   * `true` if the command's shell env-prefix carries an assignment
   * for `name` (literal `name=` prefix match). Delegates to
   * `hasEnvAssignment` with the bound env-assignment words.
   */
  hasEnvAssignment(name: string): boolean;

  /**
   * `true` if the command carries any info-only flag (token-level,
   * quote-aware; default `--help` / `--version` plus additive
   * `extraFlags`). Delegates to `isInfoOnly` with the bound argv
   * words.
   */
  isInfoOnly(extraFlags?: readonly string[]): boolean;
}

/**
 * Module-private adapter (NOT exported): passed entries select SPELLINGS
 * only; consumption/glue ALWAYS come from the bound `ResolvedArity`, never
 * from a passed entry's `takesValue`. Per requested entry per alias spelling
 * the adapter emits `{aliases:[spelling], takesValue:
 * arity.valueConsumingFlags.has(spelling)}`; bound value methods pass these
 * VIEWS (not caller entries) into `flags.ts` queries, and the presence scan
 * reads consumption/glue from the bound sets (never the views'
 * `takesValue`). Spellings are filtered to well-formed shapes
 * for an unlisted spelling therefore consumes nothing and skips nothing on
 * the bound path — it cannot bypass the table, and values vs `positionals()`
 * vs leaves cannot diverge.
 */
function boundEntryViews(
  requested: CLIFlag | readonly CLIFlag[],
  arity: ResolvedArity,
): readonly CLIFlag[] {
  const list = (
    Array.isArray(requested) ? requested : [requested]
  ) as readonly {
    aliases?: unknown;
  }[];
  const views: CLIFlag[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const aliases = (entry as { aliases?: unknown }).aliases;
    if (!Array.isArray(aliases)) continue;
    for (const spelling of aliases) {
      if (typeof spelling !== "string") continue;
      // Well-formed shapes only (the `when.flag` leaf's validity
      // contract): longs (`--` + name) or single-char shorts (`-` +
      // letter). Malformed spellings select nothing — mirroring the
      // leaf's fail-skip, so facade and leaf cannot disagree on garbage.
      if (spelling.startsWith("--")) {
        if (spelling.length <= 2) continue;
      } else if (spelling.startsWith("-")) {
        if (spelling.length !== 2) continue;
      } else {
        continue;
      }
      views.push({
        aliases: [spelling],
        takesValue: arity.valueConsumingFlags.has(spelling),
      });
    }
  }
  return views;
}

/**
 * Build a {@link SteeringCommand} bound to one tool input's argv +
 * env-prefix words, with the descriptor-resolved arity (issue #110
 * table-bound binding).
 *
 * The engine binds per ref (`arityOf(basename, descriptors, cache)` →
 * here); the facade stays a pure view. Total: never throws on weird
 * input — `input?.args ?? []` / `input?.envAssignments ?? []` normalize
 * missing keys (and a missing input itself) to the empty behavior. The
 * constructor snapshots (COPYs) both arrays, so post-construction
 * mutation of the caller's arrays cannot leak into the facade.
 *
 * Second param omitted → `EMPTY_ARITY` (explicit-strict empty —
 * direct/test use).
 */
export function commandFromInput(
  input: PredicateToolInput,
  arity?: ResolvedArity,
): SteeringCommand {
  const args: readonly Word[] = [...(input?.args ?? [])];
  const envAssignments: readonly Word[] = [...(input?.envAssignments ?? [])];
  // Table-bound arity: the ResolvedArity arrives registry-resolved (the
  // engine throws MissingDescriptorError before binding an undeclared
  // basename); omitted → EMPTY_ARITY explicit-strict (direct/test use).
  // One arity backs getFlagValue / getAllFlagValues / positionals() —
  // consumption and skipping cannot diverge.
  const bound: ResolvedArity = arity ?? EMPTY_ARITY;
  const consuming = new Set<string>(bound.valueConsumingFlags);
  return {
    hasFlag: (flag) =>
      flagPresenceScan(
        args,
        boundEntryViews(flag, bound),
        bound.valueConsumingFlags,
        bound.gluedShorts,
      ),
    getFlagValue: (flags) => getFlagValue(args, boundEntryViews(flags, bound)),
    getAllFlagValues: (flags) =>
      getAllFlagValues(args, boundEntryViews(flags, bound)),
    positionals: () => positionalsOf(args, consuming),
    hasEnvAssignment: (name) => hasEnvAssignment(envAssignments, name),
    isInfoOnly: (extraFlags) => isInfoOnly(args, extraFlags),
  };
}

/**
 * Read a word's resolved value with a fallback to its text form —
 * same `.value`-first contract as the flag helpers, so quote-awareness
 * falls out (a quoted `"see --help"` value token is one non-flag
 * word → positional; a quoted flag spelling is still exact-matched).
 */
function wordValue(w: Word | undefined): string {
  if (w === undefined) return "";
  return w.value ?? w.text ?? "";
}

/**
 * Pure positional view over bound argv words (issue #107 §6; #110 sets).
 *
 * Single left→right scan over resolved strings:
 *   1. Bare `--`: everything after it is positional (verbatim). The
 *      `--` token itself never surfaces.
 *   2. Attached `--flag=value` tokens (any dash-led token containing
 *      `=`) never surface — single tokens, always apply.
 *   3. Exact token equal to a DECLARED consuming flag → skip token +
 *      next token (trailing with no next → skip token only).
 *   4. Opaque single-dash multi-char units (bundles like `-fdx`, glued
 *      `-X<rest>` — indistinguishable with no bound glue knowledge)
 *      → skipped as ONE unit, never decomposed into letters.
 *   5. Everything else surfaces IN ORDER — INCLUDING the subcommand
 *      run and clean `--long` / `-x` / `-` flag-words that are not
 *      declared-consuming (registry-only pin: `push --delete origin`
 *      → `["push","--delete","origin"]`).
 *   6. No descriptor lookup here: the engine throws
 *      `MissingDescriptorError` before binding an undeclared basename
 *      (`{<bin>:{}}` binds empty = explicit strict).
 *
 * `--` divergence (documented, no action): `positionals()` is
 * `--`-aware while `when.flag`'s post-`--` limitation is UNCHANGED
 * (a `--force` after `--` still scans present) — flag-side
 * over-presence is the fail-closed direction.
 *
 * Total over input shapes: missing/odd shapes degrade to empty behavior,
 * never escape. (Absent-descriptor loudness lives at the engine binding
 * site, not in this pure scan.)
 */
function positionalsOf(
  args: readonly Word[],
  consuming: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const token = wordValue(args[i]);
    if (!afterDashDash && token === "--") {
      afterDashDash = true;
      continue;
    }
    if (afterDashDash) {
      out.push(token);
      continue;
    }
    // Attached forms carry their value on the token: skip one word.
    if (token.startsWith("-") && token.includes("=")) continue;
    // Declared consuming flags skip their value BY POSITION.
    if (consuming.has(token)) {
      i += 1;
      continue;
    }
    // Opaque bundles/glued: skip whole, never decompose.
    if (token.startsWith("-") && !token.startsWith("--") && token.length > 2) {
      continue;
    }
    out.push(token);
  }
  return out;
}
