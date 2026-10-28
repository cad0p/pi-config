// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Canonical stringification of a bash {@link CommandRef} for observer
 * watch matching. Every call site must use this one implementation to
 * avoid drift across observer-dispatch + speculative-entry synthesis.
 *
 * @internal — not part of the public pi-steering surface.
 */

import {
  type CommandRef,
  getBasename,
  getCommandArgs,
  resolveWord,
  resolveWordText,
} from "@cad0p/unbash-walker";
import type { PredicateWord } from "../schema.ts";

/**
 * Render a ref as `"{basename} {args joined by space}"`, trimmed —
 * RAW source form (no env resolution). Retained for compat: the
 * watch-matcher's parse-failure / no-walk-state fallback paths and
 * consumers that genuinely need the as-written command line.
 *
 * @internal — not part of the public pi-steering surface.
 */
export function refToText(ref: CommandRef): string {
  return `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
}

/**
 * Render a ref as `"{basename} {args joined by space}"`, trimmed,
 * with each suffix word in its ENV-RESOLVED form (issue #51 —
 * "predicates validate what executes"). Identical shape to
 * {@link refToText} (`getBasename` + space-joined word strings) so
 * `command`-field pattern matching is byte-compatible for static
 * words; variables now resolve in value-mode, and process
 * substitutions surface their expanded text via the text-mode
 * fallback.
 *
 * Per-word resolution, in order of preference:
 *   1. `resolveWord(word, env)` — value-mode, unquoted (byte-compatible
 *      with `getCommandArgs` for static words).
 *   2. `resolveWordText(word, env)` — text-mode, quote-preserving
 *      (process substitutions and other words value-mode can't take).
 *   3. `word.value ?? word.text` — raw fallback (unresolvable words
 *      stay as-written; fail-closed).
 *
 * @internal — not part of the public pi-steering surface.
 */
export function refToTextResolved(
  ref: CommandRef,
  env: ReadonlyMap<string, string>,
): string {
  const args = ref.node.suffix.map(
    (word) =>
      resolveWord(word, env) ??
      resolveWordText(word, env) ??
      word.value ??
      word.text,
  );
  return `${getBasename(ref)} ${args.join(" ")}`.trim();
}

/**
 * Project a ref's suffix words into {@link PredicateWord}s against the
 * ref's env snapshot (`walkerState.env` — the walker's per-ref env;
 * same-ref prefix assignments are one-shot for the direct child's env
 * and do NOT bind for the same command's word expansions, bash manual
 * §3.7.1) — the shape predicates read on `ctx.input.args` (issue
 * #51). Per word:
 *
 *   - `text` = `resolveWordText(w, env)` (text-mode, quote-preserving)
 *     or the raw source when unresolvable.
 *   - `value` = `resolveWord(w, env)` (value-mode, unquoted) or the
 *     lexical value when unresolvable.
 *   - `rawText` = the original source token.
 *   - `pos` / `end` copied; `parts` kept RAW (never resolved).
 *
 * @internal — not part of the public pi-steering surface.
 */
export function resolvePredicateWords(
  ref: CommandRef,
  env: ReadonlyMap<string, string>,
): PredicateWord[] {
  return ref.node.suffix.map((w) => ({
    text: resolveWordText(w, env) ?? w.text,
    value: resolveWord(w, env) ?? w.value ?? w.text,
    rawText: w.text,
    pos: w.pos,
    end: w.end,
    // `exactOptionalPropertyTypes`: omit the key when the raw word
    // has no parts (a bare token) instead of assigning `undefined`.
    ...(w.parts ? { parts: w.parts } : {}),
  }));
}
