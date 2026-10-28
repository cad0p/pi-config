// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Preamble prepended to every rule-fired block reason (see
 * {@link formatReason} in `../evaluator.ts`).
 *
 * The preamble makes unambiguous what the tagged reason alone never
 * stated: the entire tool call was not executed. Live incidents
 * (2026-08-29 pcad.it-infra #176, 2026-08-31 cad0p/pi#2) showed
 * agents chasing ghost state for hours after a compound bash chain
 * (`cp … && cat … && gh pr edit …`) was blocked as ONE tool call —
 * nothing in the chain ran, yet nothing in the message said so.
 *
 * Both constants end in `:` and the engine appends `\n\n` before the
 * source-tagged reason, so the tag stays the second line — the
 * machine-detectable anchor for consumers (see `stripPreamble` in
 * `../testing/index.ts`).
 */
export const BLOCK_REASON_PREAMBLE =
  "This tool call was not executed; blocked by a steering rule:";

/**
 * Preamble for the engine-error fail-closed safety block (evaluator
 * outer catch — see `evaluateEvent` in `../evaluator.ts`).
 *
 * Distinct from {@link BLOCK_REASON_PREAMBLE}: the engine-error block
 * is NOT caused by a steering rule (the engine itself threw and
 * failed closed), so "blocked by a steering rule" would be factually
 * wrong there.
 */
export const ENGINE_ERROR_PREAMBLE =
  "This tool call was not executed; the steering engine failed and blocked it as a safety measure:";
