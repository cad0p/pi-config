// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared observer-watch filter contract. Single source of truth for
 * "does this observer's `watch` accept this tool_result event?"
 *
 * Used by BOTH:
 *
 *   - the observer-dispatcher (production fire path — decides which
 *     observers see a concrete tool_result).
 *   - the evaluator's `when.missing` tool_call-scope speculative-
 *     allow (synthesizes a minimal successful bash event representing
 *     "this prior `&&` ref is about to run and succeed", then asks
 *     the same question).
 *
 * Co-locating the contract here retires a structural fragility PR #4
 * reviewers caught three times: the speculative-allow path used to
 * hand-roll a SUBSET of the watch filter (command-pattern only, then
 * patched to also check toolName + exitCode). Each new `watch` field
 * the dispatcher grew would create a fresh drift opportunity.
 *
 * Keeping both callers on this one function guarantees the two paths
 * agree by construction. If the speculative-allow path wants to
 * impose a STRICTER gate on top (e.g. "observer must declare
 * `inputMatches.command`" — an authoring requirement to keep
 * speculative-allow safe), it layers that gate before delegating to
 * {@link matchesWatch} rather than re-implementing the filter body.
 *
 * Merge-observers helper lives in {@link ./merge-observers.ts} for the
 * same single-source-of-truth reason. This file is its sibling on the
 * watch-filter axis.
 */

import {
  type EnvState,
  expandWrapperCommands,
  extractAllCommandsFromAST,
  parse as parseBash,
  type Tracker,
  walk,
} from "@cad0p/unbash-walker";
import { matchesPattern } from "../evaluator-internals/predicates.ts";
import type { ObserverWatch, Pattern, ToolResultEvent } from "../schema.ts";
import { refToText, refToTextResolved } from "./ref-text.ts";
import { WATCH_DEFAULT_WALK } from "./walk-registry.ts";

/**
 * True if the observer's `watch` filter accepts this event. No watch
 * → matches everything. Semantics per ADR "Observer schema":
 *
 *   - `toolName` — exact match against `event.toolName`.
 *   - `inputMatches` — every declared key's Pattern must match against
 *     `event.input[key]` if that key exists AND the value is a string.
 *     Keys absent from the event's input (or non-string values) make
 *     the whole filter fail — documented fail-closed choice: subset
 *     checks don't silently pass when the expected field isn't present.
 *   - `exitCode` — `"success"` → 0, `"failure"` → non-zero,
 *     `"any"`/omitted → pass, numeric → exact match. `exitCode` is
 *     sourced from the event's `exitCode` field (bash only via pi's
 *     `details.exitCode` after projection to the schema shape); other
 *     tool results leave it `undefined` and satisfy everything except
 *     a numeric `exitCode:` (treated as "no match" — bash-specific
 *     filter).
 *
 * Wrapper-aware command matching (ADR §12): when `inputMatches.command`
 * is set AND the event is a bash event, the pattern matches if EITHER
 * the raw outer `event.input.command` OR any extracted command ref
 * text matches. So `sh -c 'brazil ws sync'` with pattern
 * `/^brazil\s+ws\s+sync$/` fires the observer — the outer raw command
 * starts with `sh`, but the walker-extracted ref `brazil ws sync` does
 * hit the anchored pattern.
 *
 * Performance: when multiple observers share the same event (the
 * production dispatch path), pass a memoizing `refTextsProvider` to
 * parse the bash command once across observers. Standalone callers
 * (e.g. `testObserver` evaluating one observer in isolation, or the
 * evaluator's speculative-allow synthesizing one event per prior
 * `&&` ref) can omit it — the default provider parses on demand.
 */
export function matchesWatch(
  watch: ObserverWatch | undefined,
  event: ToolResultEvent,
  refTextsProvider?: () => readonly string[] | null,
): boolean {
  if (!watch) return true;

  if (watch.toolName !== undefined && watch.toolName !== event.toolName) {
    return false;
  }

  if (watch.inputMatches) {
    const rawInput = event.input;
    const input: Record<string, unknown> =
      typeof rawInput === "object" && rawInput !== null
        ? (rawInput as Record<string, unknown>)
        : {};
    const getRefTexts =
      refTextsProvider ??
      (() =>
        extractRefTextsForBash(event, {
          trackers: WATCH_DEFAULT_WALK,
          // Documented inert sentinel for standalone callers: the
          // default walk has no cwd-dependent modifiers, so the cwd
          // seed only exists to satisfy the required-options shape.
          // Production dispatch NEVER routes through this default — it
          // passes `buildWalkRegistry(resolved)` + per-event `ctx.cwd`.
          cwd: "/",
        }));
    for (const [key, pat] of Object.entries(watch.inputMatches)) {
      const value = input[key];
      if (typeof value !== "string") return false;
      if (!matchesInputField(key, pat, value, event, getRefTexts)) {
        return false;
      }
    }
  }

  if (watch.exitCode !== undefined && watch.exitCode !== "any") {
    if (!matchesExitCode(event.exitCode, watch.exitCode)) return false;
  }
  return true;
}

/**
 * Match a single `inputMatches` key/value against the event. `command`
 * on a bash event is wrapper-aware per ADR §12 — the raw outer command
 * OR any extracted ref text matches. All other keys (and `command` on
 * non-bash events) keep the straight raw-string match the v0.0 engine
 * shipped with.
 *
 * Share the evaluator's regex cache (module-scoped in `predicates.ts`)
 * so observer `inputMatches` reuse the same compiled `RegExp` as
 * equivalent rule patterns.
 */
function matchesInputField(
  key: string,
  pat: Pattern,
  value: string,
  event: ToolResultEvent,
  getRefTexts: () => readonly string[] | null,
): boolean {
  if (matchesPattern(pat, value)) return true;

  // Wrapper-aware fallback: only for `command` on bash events. Other
  // fields (path, content, …) don't have wrapper analogues — a
  // file-path pattern has nothing to do with bash AST refs, so
  // leaving them on the raw-string path is both correct and a perf
  // guard against needless parsing on non-bash events.
  if (key !== "command" || event.toolName !== "bash") return false;

  const refTexts = getRefTexts();
  if (refTexts === null) return false;
  for (const text of refTexts) {
    if (matchesPattern(pat, text)) return true;
  }
  return false;
}

/**
 * Extract per-ref flattened text (basename + args joined with spaces)
 * from a bash tool_result's outer command, mirroring the evaluator's
 * `prepareBashState` text projection so observer watch patterns match
 * the same strings rule patterns see for the same command.
 *
 * Returns `null` when the event isn't a bash tool_result, the raw
 * command is missing/non-string, or the walker throws while parsing
 * (hard-to-parse command — fall back to raw-only matching without
 * blowing up dispatch).
 *
 * ## Walk options (REQUIRED — issue #54)
 *
 * The caller supplies the walk registry + cwd seed:
 *
 *   - `trackers` — the effective walker registry. Production threads
 *     `buildWalkRegistry(resolved)` from
 *     `internal/walk-registry.ts` so the watch surface resolves the
 *     SAME plugin-composed trackers (incl. `trackers: { env }` /
 *     `trackerExtensions.env`) as the rule surface — closing the
 *     parity gap where observers matched raw forms while rules saw
 *     resolved forms. Standalone callers pass {@link WATCH_DEFAULT_WALK}.
 *     Required (not optional) on purpose: a forgotten registry would
 *     silently re-introduce the divergence, so forgetting it is a
 *     compile error.
 *   - `cwd` — seeds the walk (production: per-event `ctx.cwd`, load-
 *     bearing for cwd-dependent env loaders; standalone: `"/"` inert
 *     sentinel).
 *
 * With the caller's registry, each ref is rendered through
 * {@link refToTextResolved} against the walker's env snapshot,
 * mirroring the evaluator's `command` surface so observer watch
 * patterns match the same resolved strings rule patterns see for the
 * same command (issue #51) — NO prefix overlay (issue #53): same-ref
 * prefix assignments are one-shot for the direct child's env and do
 * NOT bind for the same command's word expansions (bash manual
 * §3.7.1), so prefix-referencing refs stay raw (fail-closed); chain
 * assignments (`VAR=x && …`) resolve via the env tracker. Refs
 * without walk state (e.g. process-substitution inners) fall back to
 * raw {@link refToText}.
 *
 * ## Fail-open `null` fallback note
 *
 * A parse throw falls back to raw-only matching (no ref texts). In
 * the `not: { missing }` latch idiom that raw-only tail is fail-open
 * — a parse crash silently never records, so the latch guard goes
 * inert. Empirically unreachable today (the parser survived all probe
 * constructs); documented here, not redesigned.
 *
 * Exported so the production dispatcher can memoize the parse across
 * observers on the same event (see `dispatchEventInner`'s
 * `getRefTexts` cache). Chain-aware speculative-allow already
 * synthesizes one event per prior ref and doesn't need memoization —
 * it calls {@link matchesWatch} without a provider (the builtin
 * default walk, safe because that path's input is already
 * rule-resolved text).
 */
export function extractRefTextsForBash(
  event: ToolResultEvent,
  opts: { trackers: Record<string, Tracker<unknown>>; cwd: string },
): readonly string[] | null {
  if (event.toolName !== "bash") return null;
  const input =
    typeof event.input === "object" && event.input !== null
      ? (event.input as { command?: unknown })
      : undefined;
  const command = input?.command;
  if (typeof command !== "string" || command.length === 0) return null;
  try {
    const script = parseBash(command);
    const extracted = extractAllCommandsFromAST(script, command);
    const { commands: refs } = expandWrapperCommands(extracted);
    const walkResult = walk(
      script,
      { cwd: opts.cwd } as Record<string, unknown>,
      opts.trackers,
      refs,
    );
    return refs.map((ref) => {
      // The walk's generic T widens to `Record<string, unknown>` with
      // the broad caller-supplied registry, so narrow the env snapshot
      // to the expected EnvState (same cast the evaluator's
      // prepareBashState applies).
      const env = walkResult.get(ref)?.env as EnvState | undefined;
      return env !== undefined ? refToTextResolved(ref, env) : refToText(ref);
    });
  } catch {
    // Don't let a parse error take down dispatch — a malformed
    // command still deserves a raw-match chance. Returning null
    // (as opposed to []) skips ref matching entirely for this event.
    return null;
  }
}

function matchesExitCode(
  code: number | undefined,
  filter: number | "success" | "failure",
): boolean {
  if (typeof filter === "number") {
    // Numeric filter requires a concrete code; no-code events (non-bash)
    // never match a numeric filter.
    return code === filter;
  }
  if (filter === "success") return code === 0;
  if (filter === "failure") return code !== undefined && code !== 0;
  return true;
}
