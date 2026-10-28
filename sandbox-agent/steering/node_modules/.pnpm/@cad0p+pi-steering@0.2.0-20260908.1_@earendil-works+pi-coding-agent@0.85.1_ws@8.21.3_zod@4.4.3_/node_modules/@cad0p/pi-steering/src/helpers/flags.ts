// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Low-level flag primitives for inspecting `ctx.input.args` / `ctx.input.envAssignments`.
 *
 * Promoted to core in the P3 promotion (issue #99): these back core's
 * `when.flag` leaves (issue #90) and are exported for rule authors
 * reaching for `when.condition` escape-hatch logic.
 *
 * Entry-only queries (issue #110, forcing function): `hasFlag` /
 * `getFlagValue` / `getAllFlagValues` take `CLIFlag | readonly CLIFlag[]`
 * — never bare strings, never opts. An entry is self-contained per query
 * (aliases for matching, `takesValue` for consumption, single-char-short
 * for glue — no table lookup needed at query time), so standalone (bare
 * `Word[]`, no basename, no engine) works with just the entry too.
 * `FlagLookupOptions` is deleted entirely.
 *
 * All helpers are quote-aware: they read `.value` first (the walker's
 * resolved value after quote removal) before falling back to `.text`
 * (the raw source slice).
 */

import type { Word } from "@cad0p/unbash-walker";
import type { CLIFlag } from "../schema.ts";

/**
 * Read a word's resolved value with a fallback to its text form.
 * Handles both forms consistently so callers can ignore the split.
 */
function wordValue(w: Word | undefined): string {
  if (w === undefined) return "";
  return w.value ?? w.text ?? "";
}

/**
 * Read-only iteration over a Word-array that tolerates either an array
 * of Word or undefined. Hoisted so all helpers share the same empty-
 * input handling.
 */
function* iterWords(
  words: readonly Word[] | undefined,
): IterableIterator<Word> {
  if (words === undefined) return;
  for (const w of words) yield w;
}

/**
 * Trivial takesValue read — keeps a named surface for entry testing.
 */
export function isValueConsuming(entry: CLIFlag): boolean {
  return entry?.takesValue === true;
}

/** True for `--long` / `-x` spellings; malformed shapes fail-open-ignored. */
function isWellFormedAlias(spelling: unknown): spelling is string {
  if (typeof spelling !== "string") return false;
  if (spelling.startsWith("--")) return spelling.length > 2;
  if (spelling.startsWith("-") && !spelling.startsWith("--")) {
    return spelling.length === 2;
  }
  return false;
}

function isSingleCharShort(alias: string): boolean {
  return alias.length === 2 && alias[0] === "-" && alias[1] !== "-";
}

/**
 * Normalize requested entries to well-formed alias lists.
 * Malformed entry shapes at runtime (plain-JS callers) fail-open-ignored
 * per-entry (house precedent — never throw out of a scan).
 */
function validEntries(
  flags: CLIFlag | readonly CLIFlag[],
): { aliases: readonly string[]; takesValue: boolean }[] {
  const list = (Array.isArray(flags) ? flags : [flags]) as readonly unknown[];
  const out: { aliases: readonly string[]; takesValue: boolean }[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const { aliases, takesValue } = entry as Partial<CLIFlag>;
    if (
      !Array.isArray(aliases) ||
      aliases.length === 0 ||
      !aliases.every(isWellFormedAlias) ||
      typeof takesValue !== "boolean"
    ) {
      continue;
    }
    out.push({ aliases: aliases as readonly string[], takesValue });
  }
  return out;
}

/**
 * Glue letters for the PASSED entries: single-char-short aliases of
 * `takesValue:true` entries. Longs never glue. This is NOT a second
 * table→sets site — it reads no registry, walks no table, caches nothing.
 */
function glueLettersForEntries(
  entries: readonly { aliases: readonly string[]; takesValue: boolean }[],
): ReadonlySet<string> {
  const letters = new Set<string>();
  for (const entry of entries) {
    if (!entry.takesValue) continue;
    for (const alias of entry.aliases) {
      if (isSingleCharShort(alias)) {
        letters.add(alias[1]!);
      }
    }
  }
  return letters;
}

/** Flattened alias set across valid entries (OR at every position). */
function flattenAliases(
  entries: readonly { aliases: readonly string[]; takesValue: boolean }[],
): readonly string[] {
  const out: string[] = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) out.push(alias);
  }
  return out;
}

/**
 * How a single argv word matches the queried flag set at one scanned
 * position. Precedence (checked in this order, shared by BOTH helpers):
 *   1. exact token           → separated form, consult next token
 *   2. attached `${alias}=`  → value carried (may be empty string)
 *   3. glued `-X<rest>`      → value `<rest>`, iff X ∈ glueLetters
 */
type FlagMatch =
  | { kind: "exact" }
  | { kind: "attached"; value: string }
  | { kind: "glued"; value: string };

/**
 * Match one argv word against the flag aliases at a single position.
 * Bundling-safe: only declared single letters split off a glued value,
 * and only when the remainder is non-empty (`-vf` never reads as `-v`
 * plus value `f` unless `v` was declared AND owns the lead).
 */
function matchFlagAt(
  wordText: string,
  flagAliases: readonly string[],
  glueLetters: ReadonlySet<string>,
): FlagMatch | undefined {
  // Plan-prescribed precedence: exact-before-attached — observable vs 0.1.x only for degenerate alias sets containing an `=`-bearing alias (e.g. ["--flag", "--flag="]).
  for (const alias of flagAliases) {
    if (wordText === alias) return { kind: "exact" };
  }
  for (const alias of flagAliases) {
    const prefix = `${alias}=`;
    if (wordText.startsWith(prefix)) {
      return { kind: "attached", value: wordText.slice(prefix.length) };
    }
  }
  if (wordText.length > 2 && wordText[0] === "-") {
    const lead = wordText[1];
    if (lead !== undefined && lead !== "-" && glueLetters.has(lead)) {
      return { kind: "glued", value: wordText.slice(2) };
    }
  }
  return undefined;
}

/**
 * `true` if `args` contains any listed flag entry as a bare token, as the
 * key of an attached-value `flag=value` token, or as a glued short form
 * `-X<value>` carrying its value inline (`gh -Rc/d` keeps `-Rc/d` as ONE
 * argv word — iff X is a single-char-short alias of a PASSED entry with
 * `takesValue:true`).
 *
 * Accepts a single entry or entry array (OR'd at every scanned position),
 * mirroring {@link getFlagValue}. Quote-aware (reads `.value` first, falls
 * back to `.text`).
 *
 * @example
 *   hasFlag([W("--profile"), W("dev")], {aliases:["--profile"],takesValue:true}); // true (bare)
 *   hasFlag([W("--profile=dev")], {aliases:["--profile"],takesValue:false});      // true (attached)
 *   hasFlag([W("--profile-foo")], {aliases:["--profile"],takesValue:false});      // false (prefix collision avoided)
 *   hasFlag([W("-Rc/d")], {aliases:["-R"],takesValue:true});                      // true (glued)
 */
export function hasFlag(
  args: readonly Word[] | undefined,
  flag: CLIFlag | readonly CLIFlag[],
): boolean {
  const entries = validEntries(flag);
  if (entries.length === 0) return false;
  const flagSet = flattenAliases(entries);
  const glueLetters = glueLettersForEntries(entries);
  for (const w of iterWords(args)) {
    if (matchFlagAt(wordValue(w), flagSet, glueLetters) !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Table-derived flag-presence scan — the ONE code path behind BOTH the
 * `when.flag` leaf and the bound `SteeringCommand.hasFlag` facade (issue
 * #123: the split is gone — `hasFlag` itself derives bundles, and the
 * bundle-only facade twin was deleted before it ever shipped). Ported verbatim from the leaf's `flagPresent` semantics
 * (#115 derived bundles) and shared so the two surfaces cannot drift
 * (a second copy of the scan is the drift #106 killed):
 * exact token, attached `--flag=value` (longs only, single token),
 * declared consuming-flag values skipped BY POSITION, short bundles
 * always-on for single-char shorts with table-derived glue +
 * lead-letter truncation, longs never bundle-match.
 *
 * Entries select SPELLINGS only (`aliases` → exact/long/short-letter
 * sets); consumption (`valueConsumingFlags`) and glue (`gluedShorts`)
 * ALWAYS come from the caller's bound `ResolvedArity` — never from a
 * passed entry's `takesValue`. Non-string aliases are skipped (both
 * callers pre-filter: the leaf validates, the facade adapts); `args`
 * `undefined` (non-bash tools on the bare path) reads absent.
 *
 * Word reading is `.value ?? .text ?? .rawText` (stringified) — the
 * leaf's `scanWordText` contract, kept here so the shared scan is
 * exact down to intractable words (see `scanWordText` in
 * `evaluator-internals/predicates.ts`, retained for the subcommand
 * path).
 */
export function flagPresenceScan(
  args: readonly Word[] | undefined,
  anyOf: readonly CLIFlag[],
  valueConsumingFlags: ReadonlySet<string>,
  gluedShorts: ReadonlySet<string> = new Set(),
): boolean {
  const spellings = new Set<string>();
  const longs = new Set<string>();
  const shortLetters = new Set<string>();
  for (const entry of anyOf) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const aliases = (entry as { aliases?: unknown }).aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      spellings.add(alias);
      if (alias.startsWith("--")) longs.add(alias);
      else if (isSingleCharShort(alias)) shortLetters.add(alias[1]!);
    }
  }
  if (args === undefined) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // bounds-guard; unreachable while i < length
    const token = presenceWordText(arg);
    // Exact token match (covers separate-form consuming flags too —
    // the flag itself IS present; only its value is skipped).
    if (spellings.has(token)) return true;
    // Attached `--flag=value`: match the name half against the long
    // spellings; single token, consumes nothing further.
    if (token.startsWith("--") && token.includes("=")) {
      if (longs.has(token.slice(0, token.indexOf("=")))) return true;
      continue;
    }
    // Declared consuming flag: skip its value BY POSITION.
    if (valueConsumingFlags.has(token)) {
      i += 1;
      continue;
    }
    // Short bundles (`-uf`), always on for single-char-short aliases
    // (longs never match here). Glue derivation runs FIRST: the first
    // letter in the derived glue set glues the remainder, so only the
    // non-glued prefix is present (`-Rfoo` with `R` declared presents
    // `R`, never `f`; `-xRfoo` presents `xR`). Undeclared letters never
    // glue — over-presence fires fail-closed, fixed with a table row.
    if (token.length > 1 && token[0] === "-" && token[1] !== "-") {
      let body = token.slice(1);
      const eq = body.indexOf("=");
      if (eq !== -1) body = body.slice(0, eq);
      let end = body.length;
      for (let j = 0; j < body.length; j++) {
        if (gluedShorts.has(body[j]!)) {
          end = j + 1;
          break;
        }
      }
      const present = body.slice(0, end);
      for (const letter of shortLetters) {
        if (present.includes(letter)) return true;
      }
    }
  }
  return false;
}

/**
 * Leaf-parity word read for {@link flagPresenceScan}: `.value ?? .text
 * ?? .rawText`, stringified — byte-equal to the leaf's `scanWordText`
 * so intractable (rawText-only) words resolve identically on both
 * paths. Private: the sibling `wordValue` stays `.value ?? .text` for
 * the entry-based value helpers (unchanged semantics).
 */
function presenceWordText(w: Word | undefined): string {
  if (w === undefined) return "";
  const v = w as { value?: unknown; text?: unknown; rawText?: unknown };
  const form = v.value ?? v.text ?? v.rawText ?? "";
  return typeof form === "string" ? form : String(form);
}

/**
 * Value associated with the LAST occurrence of any listed flag entry
 * in `args`, or `null` if the flag is absent or present-but-valueless.
 *
 * **LAST-flag-wins**: the scan runs RIGHT→LEFT, so the highest-index
 * occurrence wins — the effective value under every real argv parser.
 *
 * Entries OR at every scanned position, so the winner is whichever entry
 * occurrence comes last:
 *
 *   // gh pr merge -t "see #13" --subject "closes #12"
 *   getFlagValue([W("-t"), W("see #13"),
 *                 W("--subject"), W("closes #12")],
 *                [{aliases:["-t"],takesValue:true},
 *                 {aliases:["--subject"],takesValue:true}]); // "closes #12"
 *
 * Recognizes three forms (precedence per scanned position):
 *   - exact:     `--flag`       → separated form: NEXT token's value,
 *                 gated on strict-always arity — applies ONLY when ANY
 *                 passed entry takes a value (`entries.some(takesValue)`;
 *                 undeclared exact occurrences are present-but-valueless:
 *                 skipped here, their next token scans alone).
 *   - attached: `--flag=value`  → returns `"value"` (may be `""`)
 *   - glued:     `-X<rest>`     → returns `<rest>` (iff X is a
 *                 single-char-short alias of a PASSED `takesValue:true`
 *                 entry: the walker keeps `gh -Rc/d`'s `-Rc/d` as ONE
 *                 argv word)
 *
 * Glued decomposition is bundling-safe: with a `takesValue:true` `{f}`
 * entry, docker's `-vf alpine` matches NOTHING (the bundle starts with
 * the undeclared `-v`); a declared lead letter consumes its remainder
 * (`-fv` → flag `f`, value `v`).
 *
 * The separated form does NOT inspect whether the next token looks
 * like a flag — some CLIs accept `--flag --next-flag` and treat
 * `--next-flag` as the value. Callers who want a strict form should
 * post-check the return value.
 *
 * Fail-closed edge: a TRAILING valueless occurrence wins over an
 * earlier valued one — `cmd -t foo --subject` returns `null`, with NO
 * fallback to the overridden `-t foo` (declared or not: a trailing
 * exact token never reads, so strict-always gating cannot resurrect
 * an earlier value). Real pflag rejects that command
 * line anyway.
 *
 * Matching is exact token equality or the `${flag}=` attached prefix,
 * so prefix collisions are safe (`--profile-foo` ≠ `--profile`).
 * Quote-awareness is inherited (`.value` is read before `.text`).
 */
export function getFlagValue(
  args: readonly Word[] | undefined,
  flags: CLIFlag | readonly CLIFlag[],
): string | null {
  const entries = validEntries(flags);
  if (entries.length === 0) return null;
  const flagSet = flattenAliases(entries);
  const glueLetters = glueLettersForEntries(entries);
  // Strict-always gate: the separated form applies ONLY when ANY passed
  // entry takes a value — every exact occurrence consumes.
  const consumesNext = entries.some((e) => e.takesValue);
  const argsArr = args ?? [];
  for (let i = argsArr.length - 1; i >= 0; i--) {
    const match = matchFlagAt(wordValue(argsArr[i]), flagSet, glueLetters);
    if (!match) continue;
    if (match.kind === "exact") {
      const next = argsArr[i + 1];
      // Trailing valueless occurrence poisons the scalar (fail-closed),
      // declared or not — `cmd --m` models a broken command line, so
      // last-wins returns `null` with NO fallback to earlier values.
      if (next === undefined) return null;
      if (!consumesNext) continue;
      const nextVal = wordValue(next);
      return nextVal === "" ? null : nextVal;
    }
    return match.value;
  }
  return null;
}

/**
 * All values associated with any listed flag entry in `args`, in argv
 * order, or `[]` if the flag is absent or present-but-valueless.
 *
 * Forward-scan (LEFT→RIGHT) accumulation twin of {@link getFlagValue}:
 * at each position the same `matchFlagAt` precedence applies
 * (exact → attached → glued with the same per-entry glue gating),
 * and each match resolves its value exactly as `getFlagValue` would at
 * that position — except the scan collects every occurrence instead of
 * keeping only the last:
 *
 *   - exact separated (`--flag value`): the NEXT token's `wordValue`.
 *     A valueless occurrence (no next token) contributes NOTHING, and
 *     an empty-string next token (`--flag ""`) is SKIPPED (does not
 *     push `""`) — mirroring the scalar, which returns `null` on both
 *     shapes. Only the attached-empty spelling carries an explicit
 *     empty value.
 *   - attached (`--flag=value`): pushes `value` verbatim INCLUDING `""`
 *     (`--flag=` is an explicit empty value — the scalar returns `""`).
 *   - glued (`-X<rest>`): pushes `<rest>` (non-empty by construction).
 *
 * Entries OR'd per position, same as the scalar; mixed spellings
 * interleave in argv order (`-m a --message b` → `["a", "b"]`).
 * Quote-aware via `.value`-first (`wordValue`), same as scalar.
 * No match → `[]` (never `null`).
 *
 * Trailing-broken asymmetry (deliberate): a trailing broken occurrence
 * contributes nothing to the array but poisons the scalar to `null`.
 * The scalar models "effective value of a broken command line" →
 * `null`; the array models "values a real accumulator collected before
 * the broken tail" (a real CLI would reject the command anyway;
 * consumers joining for display want the collected prefix). Covers BOTH
 * trailing shapes:
 *
 *   - `[-m a, -m]` (trailing valueless) → scalar `null`, array `["a"]`.
 *   - `[-m a, -m ""]` (trailing empty-next-token) → scalar `null`,
 *     array `["a"]`.
 *   - `[--m=, --m]` (trailing valueless after attached-empty) → scalar
 *     `null`, array `[""]`.
 *
 * Invariant (well-formed non-trailing-broken inputs ONLY):
 * `getFlagValue(args, f) === (all.length ? all[all.length-1] : null)`.
 * Trailing-broken inputs (no-next-token OR empty-next-token in trailing
 * position) are the documented exception.
 *
 * Join policy lives in consumers, never here — e.g. git concatenates
 * repeated `-m` with `"\n\n"` at the rule level.
 */
export function getAllFlagValues(
  args: readonly Word[] | undefined,
  flags: CLIFlag | readonly CLIFlag[],
): string[] {
  const entries = validEntries(flags);
  if (entries.length === 0) return [];
  const flagSet = flattenAliases(entries);
  const glueLetters = glueLettersForEntries(entries);
  // Same strict-always gate as the scalar: undeclared exact
  // occurrences contribute nothing (their next token scans alone).
  const consumesNext = entries.some((e) => e.takesValue);
  const argsArr = args ?? [];
  const collected: string[] = [];
  for (let i = 0; i < argsArr.length; i++) {
    const match = matchFlagAt(wordValue(argsArr[i]), flagSet, glueLetters);
    if (!match) continue;
    if (match.kind === "exact") {
      if (!consumesNext) continue;
      const next = argsArr[i + 1];
      if (next === undefined) continue;
      const nextVal = wordValue(next);
      if (nextVal === "") continue;
      collected.push(nextVal);
    } else {
      collected.push(match.value);
    }
  }
  return collected;
}

/**
 * `true` if `envAssignments` contains a shell env-var assignment
 * matching `name`. Shell env prefixes (`VAR=value cmd ...`) are
 * extracted by the walker into a separate slot on `ctx.input`; this
 * helper reads them directly without scanning the arg list.
 *
 * The comparison is literal on the variable name — `hasEnvAssignment`
 * does NOT match partial prefixes (e.g. `AWS_PROFILE=x` does not
 * satisfy `AWS`).
 *
 * @example
 *   // ctx.input.envAssignments for `AWS_PROFILE=dev aws s3 ls`
 *   hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS_PROFILE"); // true
 *   hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS");         // false
 */
export function hasEnvAssignment(
  envAssignments: readonly Word[] | undefined,
  name: string,
): boolean {
  const prefix = `${name}=`;
  for (const w of iterWords(envAssignments)) {
    const t = wordValue(w);
    if (t.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Default set of info-only flags, matching only the long forms
 * `--help` and `--version`.
 *
 * `-h` and `-v` are deliberately EXCLUDED: they are real operations
 * in adversarial commands (`docker run -v /data:/data`, `curl -v`,
 * `kubectl -v 8`, `psql -h host`), so a default info-only set must
 * never treat them as carve-outs. Add them per-CLI via
 * {@link isInfoOnly}'s `extraFlags` when a rule author owns that
 * tradeoff for their own tool.
 */
export const INFO_FLAGS = ["--help", "--version"] as const;

/** Module-private entry literals backing the info-only check. */
const INFO_FLAG_ENTRIES: readonly CLIFlag[] = INFO_FLAGS.map((f) => ({
  aliases: [f],
  takesValue: false,
}));

/**
 * `true` if `args` contains any info-only flag (token-level, quote-
 * aware). Checks the default {@link INFO_FLAGS} set plus any additive
 * `extraFlags`.
 *
 * Unlike the old `INFO_ONLY` regex, this matches on TOKENS, so a help
 * string inside a quoted VALUE (`gh pr merge --subject "see --help"`)
 * does NOT count — the token there is a value, not a flag. The
 * attached-value form `--help=x` DOES count (via {@link hasFlag}'s
 * prefix semantics), matching how real CLIs parse it.
 *
 * @example
 *   isInfoOnly([W("--help")]);                    // true
 *   isInfoOnly([W("see --help")]);                // false (a value)
 *   isInfoOnly([W("-v")]);                        // false (not in default set)
 *   isInfoOnly([W("-v")], ["-v"]);               // true  (additive extra)
 */
export function isInfoOnly(
  args: readonly Word[] | undefined,
  extraFlags?: readonly string[],
): boolean {
  const entries: CLIFlag[] = [...INFO_FLAG_ENTRIES];
  for (const f of extraFlags ?? []) {
    entries.push({ aliases: [f], takesValue: false });
  }
  return hasFlag(args, entries);
}
