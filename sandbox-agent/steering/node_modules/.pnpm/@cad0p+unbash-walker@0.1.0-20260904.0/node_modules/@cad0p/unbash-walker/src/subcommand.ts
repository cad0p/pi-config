// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Subcommand extraction — argv-structured answers to "which subcommand does
 * this invocation actually target?".
 *
 * Policy layers matching flattened command strings re-pay a "flag grammar
 * tax" on every rule: they hand-roll leading-flag skip patterns (regexes die
 * on bundled shorts like `git push -uf`, and flag values get mistaken for the
 * subcommand — `gh --hostname h pr merge` routes nowhere, `git -c KEY=VAL
 * push` reads KEY=VAL as the subcommand). The walker owns the fix because
 * the tokens are already structured: `Command.suffix` is a `Word[]` whose
 * `.value` is the quote-aware unquoted form. This module walks those words
 * structurally.
 *
 * Two surfaces:
 *
 *   - `getSubcommandWords(ref, opts)` — the subcommand run of a concrete
 *     command as a `Word[]` slice (up to `depth` words), or null when no
 *     positional remains. The per-binary position-policy table is consulted
 *     here and ONLY here: bare words carry no binary identity, so
 *     `locateSubcommandStart` takes its policy explicitly from the caller.
 *   - `locateSubcommandStart(words, opts)` — the boundary index: index of
 *     the first subcommand word in `words`, or null when no positional
 *     exists. Exported for trackers/cwd.ts; NOT re-exported from index root.
 *   - `locateSubcommandRun(words, opts)` — the same run as boundary
 *     metadata (`{indices, words, start}`), for consumers needing
 *     positional information (e.g. args-after-subcommand reasoning
 *     without identity-matching words). Root-exported as an `@advanced`
 *     sharp edge: the run is generally NON-CONTIGUOUS, so never rebuild
 *     it or args-after via a contiguous slice, and there is deliberately
 *     NO `end` / tail primitive (see {@link SubcommandRun}).
 *   - `getSubcommandRun(ref, opts)` — the thin `CommandRef` twin of
 *     `locateSubcommandRun` (basename table lookup included). Tracker-
 *     side convenience; NOT re-exported from the index root.
 *
 * ## Design notes
 *
 *   - Linear scan over the suffix words — no regex anywhere. Each word is
 *     classified via quote-aware resolution (`.value`, never bare
 *     `.text`): any `-`-prefixed token is flag-shaped and skipped, any other
 *     token starts the subcommand run. `$VAR` values are not expanded; the
 *     scan is structural only.
 *   - Declared consuming flags are consumed by POSITION (`i += 2`), never by
 *     inspecting the following word's content: a flag value must never be
 *     evaluated as the subcommand. Attached `--flag=value` forms are single
 *     tokens by construction and need no declaration.
 *   - Position policy is a per-binary property (cobra accepts anywhere,
 *     gitcli(7) fatals on after-sub globals, mitchellh/cli errors pre-sub).
 *     Precisely scoped impossibility: ONLY `globals-after-only` binaries
 *     reject leading-global-flag shapes (`go -v build` → null; invalid by
 *     definition). For `globals-before-only` binaries post-subcommand flags
 *     are simply subcommand-owned args and extraction succeeds normally.
 *   - The null return deliberately conflates "zero positionals" with
 *     "after-only invalid shape": both mean "no extraction possible" for
 *     fail-closed consumers.
 */

import type { Word } from "unbash";
import { getBasename } from "./resolve.ts";
import type { CommandRef } from "./types.ts";

/**
 * Default subcommand-word count. 1 = just the subcommand itself
 * (`gh pr merge` → ["pr"]); noun-verb binaries want 2–3
 * (`aws s3 ls` → ["s3", "ls"]). Named constant so call sites read
 * intent instead of a bare literal.
 */
const DEFAULT_DEPTH = 1;

/**
 * How global flags may be positioned relative to the subcommand.
 *
 *   - `globals-anywhere`: `gh -R x/y pr merge` and `gh pr merge -R x/y`
 *     both parse; extraction succeeds regardless of flag placement.
 *   - `globals-before-only`: git — globals must precede the subcommand;
 *     post-subcommand flags belong to it (`git push -C x` → ["push"]).
 *   - `globals-after-only`: mitchellh-cli heritage (terraform, go) —
 *     pre-subcommand flags are invalid by definition.
 */
export type PositionPolicy =
  | "globals-anywhere"
  | "globals-before-only"
  | "globals-after-only";

/** Options controlling subcommand extraction. */
export interface SubcommandOptions {
  /**
   * How global flags may sit relative to the subcommand. Default:
   * {@link DEFAULT_POSITION_POLICIES} lookup keyed on the command's
   * basename, falling back to `globals-anywhere` for unknown binaries.
   */
  positionPolicy?: PositionPolicy;
  /**
   * How many positional tokens make up the subcommand. Default 1.
   * aws s3 ls / kubectl get pods want 2–3.
   */
  depth?: number;
  /**
   * Flags known to CONSUME the following token (e.g. git `-C DIR`,
   * `-c <key>=<value>`). Caller-supplied — the walker stays arity-ignorant
   * (see non-goals in README): consumption knowledge enters only via these
   * exact-token matches. Without a declaration, `git -c KEY=VAL push` would
   * read KEY=VAL as the subcommand and land the boundary wrong.
   * Attached `--flag=value` forms are always consumed without an entry.
   * Default: none.
   */
  valueConsumingFlags?: readonly string[];
}

/**
 * Per-binary default {@link SubcommandOptions.positionPolicy}, keyed by
 * command basename so `/usr/bin/git` matches `git`. Seeded from the
 * cad0p/pi-steering 2026-08-24 CLI survey (13 families); caller override
 * wins. Deliberately tiny, stable, survey-backed enum — unlike flag
 * inventories, which are open-ended and version-volatile, position
 * conventions ship in-package because they rarely change.
 */
export const DEFAULT_POSITION_POLICIES: Readonly<
  Record<string, PositionPolicy>
> = {
  gh: "globals-anywhere",
  kubectl: "globals-anywhere",
  docker: "globals-anywhere",
  aws: "globals-anywhere",
  gcloud: "globals-anywhere",
  az: "globals-anywhere",
  npm: "globals-anywhere",
  pnpm: "globals-anywhere",
  yarn: "globals-anywhere",
  cargo: "globals-anywhere",
  uv: "globals-anywhere",
  pip: "globals-anywhere",
  git: "globals-before-only",
  terraform: "globals-after-only",
  go: "globals-after-only",
};

/**
 * Valid `positionPolicy` values, for the runtime fail-closed guard on the
 * `locate*` bare-words primitives (their TS type already requires a policy;
 * the throw only bites contract-violating JS callers passing undefined or a
 * misspelled string, which would otherwise silently degrade to anywhere
 * semantics — e.g. `go -v build` extracting `build`).
 */
const VALID_POSITION_POLICIES: readonly PositionPolicy[] = [
  "globals-anywhere",
  "globals-before-only",
  "globals-after-only",
];

/**
 * Fail-closed guard for the `locate*` bare-words primitives: bare words
 * carry no binary identity, so there is no table to fall back to and no
 * safe default. Throws a `TypeError` naming the three valid policies on a
 * missing or invalid policy. Set-membership check, not truthiness.
 */
function assertPositionPolicy(
  policy: unknown,
): asserts policy is PositionPolicy {
  if (!(VALID_POSITION_POLICIES as readonly unknown[]).includes(policy)) {
    throw new TypeError(
      `positionPolicy must be one of "globals-anywhere" | "globals-before-only" | "globals-after-only" (got ${JSON.stringify(policy)})`,
    );
  }
}

/**
 * Boundary metadata for a subcommand run: the same run
 * {@link getSubcommandWords} returns, plus WHERE its words sit in the
 * passed array.
 *
 * @advanced Sharp edge, root-exported for argv-structured consumers.
 * Read the hull prohibitions below before composing a tail.
 *
 * The run is generally NON-CONTIGUOUS in the passed array: consumed flag
 * values sit BETWEEN subcommand words (`aws s3 --profile x ls`, `--profile`
 * declared → indices 0 and 3). Reconstruct the run via the indices map,
 * never via a contiguous slice — `words.slice(start, start + words.length)`
 * re-admits the skipped gap. There is deliberately NO `end` / tail
 * primitive in this issue: the `[first, last + 1)` hull includes the gap,
 * so anyone reading it as the run range is wrong, and a depth-truncated
 * run (`[0]` at depth=1) would promote consumed values and deferred words
 * to args-after. A tail is valid only if the run is contiguous
 * (`indices[i] === indices[0] + i`) AND unsaturated (the scan stopped for
 * end-of-words, not for depth) — compose that check at the call site.
 *
 * `start` indexes the PASSED array (`start === indices[0]`): subslice
 * callers shift its meaning. Snapshot semantics: `words` holds SHARED
 * `Word` refs (`words[i]` is `words[indices[i]]`) and `indices` is a FRESH
 * array per call — mutating the passed suffix after the call invalidates
 * the snapshot.
 *
 * Null (not a value of this interface) deliberately conflates all-flags /
 * trailing consuming flag / after-only-invalid shapes. Steering consumers
 * treat ALL null as unknown/block, never allow.
 */
export interface SubcommandRun {
  /** Positions in the PASSED words array (non-contiguous OK). Fresh array per call. */
  indices: readonly number[];
  /** Projection at indices — same Word refs, same order. `words[i]` is `words[indices[i]]`. */
  words: readonly Word[];
  /** === indices[0]. Agrees with locateSubcommandStart on the same input. */
  start: number;
}

/**
 * Shared scan: indices of the collected subcommand words, or null when no
 * positional exists. Both public surfaces share this loop —
 * `getSubcommandWords` projects the words themselves,
 * `locateSubcommandStart` the boundary (first index).
 *
 * WHY indices instead of a contiguous slice: consumed flag values sit BETWEEN
 * subcommand words (`aws s3 --profile x ls`, `--profile` declared → words
 * "s3" and "ls" at indices 0 and 3), so the run is generally NOT a contiguous
 * range of the suffix array.
 *
 * The scan classifies each suffix word via quote-aware resolution (`.value`,
 * never bare `.text`): any `-`-prefixed token is flag-shaped (skipped),
 * any other token joins the run. `$VAR` values are NOT expanded; the scan is
 * structural only. Declared consuming flags jump their value BY INDEX (`i +=
 * 2`), never evaluating the following word's content — a flag value must never
 * be evaluated as a subcommand candidate. Attached `--flag=value` forms are
 * single tokens by construction.
 *
 * Limit: short clusters, long options with/without attached values, and bare
 * `--` are all single flag-shaped tokens; post-`--` positional semantics are
 * NOT modelled (documented limitation, future refinement).
 */
function scanSubcommandIndices(
  words: readonly Word[],
  opts: SubcommandOptions & { positionPolicy: PositionPolicy },
): number[] | null {
  const consuming = new Set(opts.valueConsumingFlags ?? []);
  const depth = Math.max(0, opts.depth ?? DEFAULT_DEPTH);
  const indices: number[] = [];
  let i = 0;
  while (i < words.length && indices.length < depth) {
    // Quote-aware resolution ALWAYS — .text alone misreads quoted tokens.
    const v = words[i]?.value ?? "";
    if (v.startsWith("-")) {
      if (
        opts.positionPolicy === "globals-after-only" &&
        indices.length === 0
      ) {
        // Leading-global-flag shape on an after-only binary: invalid by
        // definition (`go -v build`). Null conflates with zero-positionals —
        // both mean "no extraction possible".
        return null;
      }
      i += consuming.has(v) ? 2 : 1;
    } else {
      indices.push(i);
      i += 1;
    }
  }
  return indices.length > 0 ? indices : null;
}

/**
 * Index of the first subcommand word in `words`, or null when no positional
 * exists (all flags / trailing consuming flag / after-only invalid shape).
 *
 * Shares its loop with {@link getSubcommandWords}; the tracker layer
 * (`trackers/cwd.ts`) consumes the boundary itself, walking `[0, boundary)`
 * to collect pre-subcommand flags without duplicating the stop condition.
 *
 * NO default-table lookup here — bare words carry no binary identity, so
 * `positionPolicy` is a required field resolved by the caller.
 */
export function locateSubcommandStart(
  words: readonly Word[],
  opts: SubcommandOptions & { positionPolicy: PositionPolicy },
): number | null {
  assertPositionPolicy(opts.positionPolicy);
  return scanSubcommandIndices(words, opts)?.[0] ?? null;
}

/**
 * Extract the subcommand token run of a multi-command binary.
 *
 * Walks `ref.node.suffix` left→right, skipping flag tokens AND the values of
 * caller-declared consuming flags, and returns up to `depth` positional words
 * starting at the first one — or null when no positional remains (all-flag
 * invocation, trailing consuming flag, or after-only invalid shape). The
 * returned words are the scan's collected positionals, which need not be
 * contiguous in the suffix array when consuming-flag values interleave.
 *
 * Examples:
 *   gh -R x/y pr merge   (-R declared consuming) → ["pr"]       depth=1
 *   gh -R x/y pr merge   (-R declared consuming) → ["pr","merge"] depth=2
 *   git -C /path push    (-C declared consuming) → ["push"]
 *   git push -C x        (before-only policy)    → ["push"]
 *   go -v build          (after-only table hit)  → null
 *
 * Pure over the CommandRef: reads `node.suffix`, mutates nothing.
 */
export function getSubcommandWords(
  ref: CommandRef,
  opts?: SubcommandOptions,
): Word[] | null {
  // Assignment-only or nameless command: no binary, no table key, nothing
  // to extract.
  if (!ref.node.name) return null;

  // Table lookup lives ONLY here — this is the sole site holding both the
  // ref (for the basename key via the undefined-safe getBasename helper)
  // and the option bag. Unknown binaries fall through to globals-anywhere.
  const policy =
    opts?.positionPolicy ??
    DEFAULT_POSITION_POLICIES[getBasename(ref)] ??
    "globals-anywhere";
  const depth = opts?.depth ?? DEFAULT_DEPTH;

  const words = ref.node.suffix;
  // exactOptionalPropertyTypes: only carry the flag list when supplied.
  const indices = scanSubcommandIndices(words, {
    positionPolicy: policy,
    depth,
    ...(opts?.valueConsumingFlags !== undefined && {
      valueConsumingFlags: opts.valueConsumingFlags,
    }),
  });
  // Cast is bounds-sound: every index was generated by scanning THIS array
  // (scanSubcommandIndices only pushes i < words.length positions).
  return indices === null ? null : indices.map((idx) => words[idx] as Word);
}

/**
 * Boundary metadata for the subcommand run over bare words: positions plus
 * words plus the `start` alias (`start === indices[0]`, agreeing with
 * {@link locateSubcommandStart} on the same input).
 *
 * @advanced Sharp edge: the run is generally NON-CONTIGUOUS — never
 * rebuild it or args-after via a contiguous slice, and do not infer a
 * tail from `start` + run length (see {@link SubcommandRun}).
 *
 * Bare-words core — NO table lookup. `positionPolicy` is REQUIRED (bare
 * words carry no binary identity, so there is no key to resolve a default
 * from); a missing or invalid policy throws a `TypeError` naming the three
 * valid policies (fail-closed for contract-violating JS callers — the TS
 * type already requires it). Projection of the shared
 * `scanSubcommandIndices` loop: zero new classification logic.
 *
 * The run is generally NON-CONTIGUOUS (`aws s3 --profile x ls`, `--profile`
 * declared → `indices=[0,3]`). Never rebuild the run or args-after via a
 * contiguous slice; a tail is valid only if contiguous AND unsaturated.
 * Null conflates all-flags / trailing consuming flag / after-only-invalid —
 * consumers treat ALL null as unknown/block, never allow.
 *
 * Pure: fresh `indices` array of shared `Word` refs; the input is never
 * mutated.
 */
export function locateSubcommandRun(
  words: readonly Word[],
  opts: SubcommandOptions & { positionPolicy: PositionPolicy },
): SubcommandRun | null {
  assertPositionPolicy(opts.positionPolicy);
  // exactOptionalPropertyTypes: only carry the flag list when supplied.
  // (opts is required here, so `opts.`, not `opts?.`.)
  const indices = scanSubcommandIndices(words, {
    positionPolicy: opts.positionPolicy,
    depth: opts.depth ?? DEFAULT_DEPTH,
    ...(opts.valueConsumingFlags !== undefined && {
      valueConsumingFlags: opts.valueConsumingFlags,
    }),
  });
  if (indices === null) return null;
  // Bounds-sound casts (file precedent; noUncheckedIndexedAccess is on):
  // a non-null result is non-empty, so indices[0] is defined, and every
  // index was generated by scanning THIS array (i < words.length).
  return {
    indices: [...indices],
    words: indices.map((idx) => words[idx] as Word),
    start: indices[0] as number,
  };
}

/**
 * Boundary metadata for the subcommand run of a concrete command: the thin
 * `CommandRef` twin of {@link locateSubcommandRun}, doing the basename
 * table lookup internally (mirrors {@link getSubcommandWords}, including
 * its table + `globals-anywhere` fallback — never throws on policy).
 *
 * Assignment-only or nameless command → null. Otherwise projects the shared
 * scan over `ref.node.suffix`: `indices` positions the run in THAT suffix
 * array, `words` holds its shared refs, `start === indices[0]`. Same
 * non-contiguous, snapshot, and null-conflation contracts as
 * {@link locateSubcommandRun}. Pure over the CommandRef: reads
 * `node.suffix`, mutates nothing.
 */
export function getSubcommandRun(
  ref: CommandRef,
  opts?: SubcommandOptions,
): SubcommandRun | null {
  // Assignment-only or nameless command: no binary, no table key, nothing
  // to extract.
  if (!ref.node.name) return null;

  // Table lookup lives ONLY here (and in getSubcommandWords) — the sole
  // sites holding both the ref (for the basename key via the
  // undefined-safe getBasename helper) and the option bag. Unknown binaries
  // fall through to globals-anywhere.
  const policy =
    opts?.positionPolicy ??
    DEFAULT_POSITION_POLICIES[getBasename(ref)] ??
    "globals-anywhere";
  const depth = opts?.depth ?? DEFAULT_DEPTH;

  const words = ref.node.suffix;
  // exactOptionalPropertyTypes: only carry the flag list when supplied.
  const indices = scanSubcommandIndices(words, {
    positionPolicy: policy,
    depth,
    ...(opts?.valueConsumingFlags !== undefined && {
      valueConsumingFlags: opts.valueConsumingFlags,
    }),
  });
  if (indices === null) return null;
  // Bounds-sound casts: non-null is non-empty (indices[0] defined), and
  // every index was generated by scanning THIS array.
  return {
    indices: [...indices],
    words: indices.map((idx) => words[idx] as Word),
    start: indices[0] as number,
  };
}

/**
 * Does one short-option-shaped word contain letter `letter` in its bundle?
 *
 * Conservative contract, kept honest about lexical limits: `-uf` (bundle)
 * and `-fx` (flag + glued value) are SHAPE-IDENTICAL without per-flag arity
 * knowledge, which stays out of scope. So `-fx` reports BOTH `f` and `x` —
 * an accepted over-match, documented rather than guessed at. The scan cuts
 * the body at the first `=` (`-f=x` → letters `f`; anything post-`=` is a
 * value, never scanned).
 *
 * Quote-aware via `.value`. Returns false for long options (`--force`
 * starts with `--`), empty/non-single-char letters, and non-dash words.
 */
export function bundleContains(word: Word, letter: string): boolean {
  if (letter.length !== 1) return false;
  const v = word.value;
  // Must be single-dash short-option shape: `-abc`, not `--long`, not bare.
  if (!v.startsWith("-") || v.startsWith("--")) return false;
  const body = v.slice(1);
  const eq = body.indexOf("=");
  const bundle = eq === -1 ? body : body.slice(0, eq);
  return bundle.includes(letter);
}
