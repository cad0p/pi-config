// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Arg-layer helpers for the body-file predicate and the
 * keyword rules: walker-argv access, quote stripping, flag
 * value lookup, `--body-file` value classification, and cwd
 * resolution.
 *
 * This module also re-exports `BODY_STRIP` (the rules and the
 * predicate interpolate it at module load and byte-pin it in the
 * tokenizer) so consumers can keep importing it from a single
 * helpers path.
 *
 * `--body-file` classification is ONE pure helper,
 * `explainBodyFileArg` (five tags, no union, no payloads); the
 * diagnostic is a byte-equality check plus one diff
 * (`renderBodyFileDiff`). The vault predicate and both rules'
 * dynamic block-reason fn consume the SAME helper + value, so the
 * verdict and the diagnostic can never drift.
 */

import { isAbsolute, resolve } from "node:path";
import {
  expandTildeIfLeading,
  type PredicateContext,
} from "@cad0p/pi-steering";
import { BODY_STRIP } from "./body-strip.ts";

export { BODY_STRIP };

// ---------------------------------------------------------------------------
// Arg helpers (run against the walker-parsed argv, not the raw string)
// ---------------------------------------------------------------------------

type ArgWord = { text: string };

/** The walker-parsed argument words of the evaluated command. */
export function argText(ctx: PredicateContext): readonly ArgWord[] {
  return ctx.input.args as readonly ArgWord[];
}

/**
 * Strip one level of wrapping quotes from a walker word's raw source
 * text (`Word.text` preserves the original quoting — `"file.md"` and
 * `'file.md'` both come through with their quotes).
 */
export function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * Value of the first occurrence of one of `flags` (space or `=`
 * form), unquoted. `null` when none of the flags appears.
 */
export function findFlagValue(
  ctx: PredicateContext,
  flags: readonly string[],
): string | null {
  const words = argText(ctx);
  for (let i = 0; i < words.length; i++) {
    const t = words[i]?.text ?? "";
    for (const f of flags) {
      if (t === f) return unquote(words[i + 1]?.text ?? "");
      if (t.startsWith(`${f}=`)) return unquote(t.slice(f.length + 1));
    }
  }
  return null;
}

/**
 * The raw (still-quoted) `--body-file` / `-F` value word: the same
 * scan as `findBodyFileValue` without the single unquote level.
 * `""` when absent or empty. The keyword helper parses this form so
 * the direct arm can see the word's quotes (a quoted leading `~`
 * stays literal in the shell); every other consumer keeps the
 * unquoted value.
 *
 * Unlike `findFlagValue`, this scanner ALSO handles the walker-split
 * glued form: the unbash walker splits `--body-file=<( … )` into TWO
 * words (`--body-file=` + `<( … )`), so a word that is exactly
 * `--body-file=` / `-F=` takes the NEXT word as its value (as the
 * last word there is no next token → `""` → fail-closed block).
 */
export function findBodyFileRawValue(ctx: PredicateContext): string {
  const words = argText(ctx);
  for (let i = 0; i < words.length; i++) {
    const t = words[i]?.text ?? "";
    if (t === "--body-file" || t === "-F") {
      return words[i + 1]?.text ?? "";
    }
    if (t === "--body-file=" || t === "-F=") {
      // Walker-split expansion artifact of `--body-file=<( … )`:
      // the value is the next word.
      return words[i + 1]?.text ?? "";
    }
    if (t.startsWith("--body-file=") || t.startsWith("-F=")) {
      return t.slice(t.indexOf("=") + 1);
    }
  }
  return "";
}

/**
 * Value of the first `--body-file` / `-F` occurrence, unquoted.
 * `""` when absent or empty (fail-closed — the caller treats it as
 * missing). Exactly `unquote(findBodyFileRawValue(ctx))` — see the
 * raw form for the scan details.
 */
export function findBodyFileValue(ctx: PredicateContext): string {
  return unquote(findBodyFileRawValue(ctx));
}

/**
 * A parsed `--body-file` value word:
 *
 *   - `substitution` — `<(perl -0777 -pe '<BODY_STRIP>' <path>)`,
 *     the ONLY accepted form. `path` is the (unquoted) file argument
 *     — resolved and validated by `missingVaultBodyFile` (exists,
 *     napkin vault, `<repo>/<section>/` placement).
 *   - `direct` — any other path-like word (blocked; kept only so
 *     `bodyHasClosingKeyword` can raw-read a direct path in the
 *     disabled-rules combos), carrying the same lexical `quoted`
 *     flag: the word may arrive still-quoted, and a quoted leading
 *     `~` must resolve literally there too.
 */
export type BodyFileArg =
  | { kind: "substitution"; path: string; quoted: boolean }
  | { kind: "direct"; path: string; quoted: boolean };

// ---------------------------------------------------------------------------
// `--body-file` value classification + the byte-diff diagnostic
// ---------------------------------------------------------------------------

/**
 * Classify a `--body-file` value word (pure — no ctx, no fs):
 * `missing` | `direct` | `form` | `ok` | `diff`. The predicate and
 * both rules' `reason` fn consume the SAME value, so verdict and
 * diagnostic can never drift.
 */
export function explainBodyFileArg(
  v: string,
): "missing" | "direct" | "form" | "ok" | "diff" {
  if (v === "") return "missing";
  if (!v.startsWith("<(")) return "direct";
  if (!v.endsWith(")")) return "form";
  return parseBodyFileArg(v) !== null ? "ok" : "diff";
}

/**
 * Classify a `--body-file` value word. `null` = unparsable (fail
 * closed by the callers).
 *
 * A `<( … )` word is accepted ONLY when the inner command is exactly
 * `perl -0777 -pe <BODY_STRIP> <path>` (shell word-split on
 * the inner text, quotes respected and stripped): the program token
 * is byte-compared against the pinned constant, the path is the
 * single remaining token. Any other inner command (`sed`, `awk`,
 * `cat`, a different perl invocation, extra flags, missing path, …)
 * is unparsable — either it would not strip at all or the pinned
 * behavior could not be guaranteed.
 */
export function parseBodyFileArg(word: string): BodyFileArg | null {
  // The keyword helper feeds the raw (still-quoted) word so the
  // direct arm can see its quotes; an outer-quoted substitution
  // unwraps to the same substitution the unquoted value parses to.
  const sub = word.startsWith("<(")
    ? word
    : isOuterQuoted(word) && unquote(word).startsWith("<(")
      ? unquote(word)
      : null;
  if (sub !== null) {
    if (!sub.endsWith(")")) return null;
    const tokens = tokenizeInner(sub.slice(2, -1).trim());
    if (tokens.length === STRIP_COMMAND_TOKENS.length + 1) {
      let pinned = true;
      for (let i = 0; i < STRIP_COMMAND_TOKENS.length; i++) {
        if (tokens[i]?.value !== STRIP_COMMAND_TOKENS[i]) {
          pinned = false;
          break;
        }
      }
      if (pinned) {
        const path = tokens[STRIP_COMMAND_TOKENS.length];
        if (path !== undefined && path.value !== "") {
          return {
            kind: "substitution",
            path: path.value,
            quoted: path.quoted,
          };
        }
      }
    }
    return null;
  }
  if (word !== "") {
    const quoted = isLexicallyQuoted(word);
    const path = isOuterQuoted(word) ? unquote(word) : word;
    if (path === "") return null;
    return { kind: "direct", path, quoted };
  }
  return null;
}

/** Whether the word is wrapped in one level of matching quotes. */
function isOuterQuoted(word: string): boolean {
  return unquote(word) !== word;
}

/**
 * The `diff` diagnostic: pinned shape (5 tokens, first three
 * pinned) with a diverging program token → the divergent core with
 * the byte offset; otherwise the two full command lines.
 */
export function renderBodyFileDiff(v: string): string {
  const tokens = tokenizeInner(v.slice(2, -1).trim()).map((t) => t.value);
  const shape = tokens.length === STRIP_COMMAND_TOKENS.length + 1;
  const prefixPinned =
    shape && STRIP_COMMAND_TOKENS.slice(0, 3).every((t, i) => tokens[i] === t);
  const program = prefixPinned ? (tokens[3] ?? "") : null;
  if (program !== null) {
    const pair = corePair(program, BODY_STRIP);
    if (pair !== null) {
      return [
        `substitution program diverges from the pinned strip at byte ${pair.offset}:`,
        `  - expected: ${pair.exp}`,
        `  + got:      ${pair.g}`,
      ].join("\n");
    }
  }
  return [
    "substitution inner command deviates from the pinned strip:",
    `  - expected: perl -0777 -pe '${BODY_STRIP}' PATH`,
    `  + got:      ${tokens.map(quoteForDisplay).join(" ")}`,
  ].join("\n");
}

/**
 * The divergent core of `got` vs `expected`: trim the common
 * prefix, then the common suffix — BOUNDED by `min(len) - prefix`
 * (an unbounded loop hangs on identical strings) — and return the
 * remaining spans plus the byte offset. `null` when both spans are
 * empty (identical programs — the `sed -0777 -pe '<pinned>' file`
 * case) or either span > 60% of its own string (strict `>`).
 */
function corePair(
  got: string,
  expected: string,
): { offset: number; exp: string; g: string } | null {
  const minLen = Math.min(got.length, expected.length);
  let prefix = 0;
  while (prefix < minLen && got[prefix] === expected[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    got[got.length - 1 - suffix] === expected[expected.length - 1 - suffix]
  ) {
    suffix++;
  }
  const exp = expected.slice(prefix, expected.length - suffix);
  const g = got.slice(prefix, got.length - suffix);
  if (
    (exp === "" && g === "") ||
    exp.length > 0.6 * expected.length ||
    g.length > 0.6 * got.length
  ) {
    return null;
  }
  return { offset: prefix, exp, g };
}

/** Quote a display token when it contains whitespace (keeps the got line re-readable as a command). */
function quoteForDisplay(token: string): string {
  if (!/\s/.test(token)) return token;
  return token.includes("'") ? `"${token}"` : `'${token}'`;
}

// ---------------------------------------------------------------------------
// The pinned strip one-liner — the only accepted inner command
// ---------------------------------------------------------------------------

/** The exact inner-command token sequence (before the path token). */
const STRIP_COMMAND_TOKENS: readonly string[] = [
  "perl",
  "-0777",
  "-pe",
  BODY_STRIP,
] as const;

/**
 * The expected token count inside a well-formed `<( … )` word: the
 * pinned strip-command tokens plus the single path token.
 */
export const EXPECTED_SUBSTITUTION_TOKENS: number =
  STRIP_COMMAND_TOKENS.length + 1;

/**
 * Count the shell words inside a `<( … )` word (quotes respected).
 * `null` when the word is not a `<(`-prefixed word at all. An
 * unclosed `<(` word still counts (the trailing `)` is optional) —
 * the `form`-stage mirror uses this for its structure line.
 */
export function countSubstitutionTokens(word: string): number | null {
  if (!word.startsWith("<(")) return null;
  const inner = word.endsWith(")")
    ? word.slice(2, -1).trim()
    : word.slice(2).trim();
  return tokenizeInner(inner).length;
}

/**
 * A shell word inside a `<( … )` word: the quote-stripped value
 * plus whether the token's tilde prefix is lexically quoted.
 *
 * Stripping is correct for the program byte-pin (quoting style is
 * free — `'PROG'` and `"PROG"` pin identically) but wrong for the
 * path: the shell expands a leading `~` only when the word begins
 * with an unquoted `~` and the prefix up to the first unquoted `/`
 * is unquoted, so the path token must remember its lexical
 * quotedness for the resolver to stay shell-exact. `quoted` is true
 * when ANY quote character precedes or covers that prefix:
 * `"~/x"`, `"~"/x`, `~"/x`, and `""~/x` all stay literal —
 * only a lexically-leading unquoted `~/` expands.
 */
interface InnerToken {
  value: string;
  quoted: boolean;
}

/**
 * Shell-style word splitting on the inner text of a `<( … )` word:
 * whitespace separates tokens outside quotes; `"` and `'` quotes are
 * stripped when a token is extracted (equivalent to shell word
 * splitting on the inner text). An unmatched quote just ends the
 * token — the strict token-count + byte-pin downstream fails closed.
 */
function tokenizeInner(text: string): InnerToken[] {
  const tokens: InnerToken[] = [];
  let current = "";
  let raw = "";
  let quote: '"' | "'" | null = null;
  const push = () => {
    if (current !== "") {
      tokens.push({ value: current, quoted: isLexicallyQuoted(raw) });
    }
    current = "";
    raw = "";
  };
  for (const ch of text) {
    if (quote !== null) {
      raw += ch;
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      raw += ch;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      current += ch;
      raw += ch;
    }
  }
  push();
  return tokens;
}

/**
 * Whether a raw token's tilde prefix is lexically quoted: any quote
 * character in the word up to the first unquoted `/` (the whole word
 * when there is none) suppresses expansion. `""~/x` opens with a
 * quote, `~"/x` buries its slash inside quotes — both stay literal,
 * exactly as the shell leaves them.
 */
function isLexicallyQuoted(raw: string): boolean {
  let quote: '"' | "'" | null = null;
  let prefix = "";
  for (const ch of raw) {
    if (quote !== null) {
      prefix += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      prefix += ch;
      quote = ch;
    } else if (ch === "/") {
      break;
    } else {
      prefix += ch;
    }
  }
  return prefix.includes('"') || prefix.includes("'");
}

/**
 * Resolve a possibly-relative path against the command's effective
 * cwd. `null` when the cwd is the walker's `"unknown"` sentinel
 * (fail-closed — the caller treats it as missing).
 *
 * A leading `~` expands to `$HOME` first (shell-exact: bash expands
 * an unquoted leading tilde before the inner command ever sees the
 * word, so without this a bare `~/…` vault path would join onto the
 * cwd and over-block). The env is the walker's tracked env at the
 * command ref when present (it carries `HOME=` overrides), else
 * `process.env`. Expansion returning `undefined` (HOME unknown)
 * ALSO yields `null` — fail-closed; `diagnose` renders that arm
 * with its own explicit trace line (known cwd + null abs can only
 * mean the expansion failed).
 *
 * `~user/…` passes through unchanged (documented upstream limit —
 * the core helper returns it as-is, no new behavior here).
 *
 * `quoted` is the path token's quotedness from `parseBodyFileArg`
 * (both variants carry it — bash suppresses tilde expansion inside
 * quotes): a quoted path resolves literally — `"~/x"` joins onto
 * the cwd and fails the exists check, which is both bash-exact and
 * fail-closed.
 */
export function resolveAgainstCwd(
  ctx: PredicateContext,
  path: string,
  // Fail-open default: an omitted flag expands. Every tilde-capable
  // caller passes explicitly — keep it that way.
  quoted = false,
): string | null {
  const cwd = ctx.cwd;
  if (typeof cwd !== "string" || cwd === "unknown") return null;
  const expanded = quoted ? path : expandTildeIfLeading(path, tildeEnv(ctx));
  if (expanded === undefined) return null;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * The env for tilde expansion: the walker's tracked env at the
 * command ref when present (authoritative — includes `HOME=`
 * overrides), else the process env projected to a string map.
 * Exported for the keyword helper, which replicates the same
 * shell handoff for the pinned perl invocation.
 */
export function tildeEnv(ctx: PredicateContext): ReadonlyMap<string, string> {
  const tracked = ctx.walkerState?.env;
  if (tracked !== undefined) return tracked;
  const env = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env.set(key, value);
  }
  return env;
}
