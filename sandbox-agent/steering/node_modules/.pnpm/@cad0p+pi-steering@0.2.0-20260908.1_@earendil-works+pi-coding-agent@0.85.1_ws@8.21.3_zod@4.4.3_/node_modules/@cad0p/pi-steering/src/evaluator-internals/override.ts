// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Inline override-comment detection for the v2 evaluator.
 *
 * Ported verbatim from the v1 evaluator's `extractOverride` (see
 * `../../evaluator.ts`). Syntax and behaviour match exactly so the
 * extension runtime can swap from v1 to v2 without users rewriting
 * their override comments. See the v1 evaluator's JSDoc for the full
 * syntax grammar.
 *
 * Exposed as a standalone module so the evaluator and its tests can
 * assert override detection independently of the rest of the pipeline.
 */

/**
 * Global-flag regex matching every override comment in a text blob.
 *
 *   leader:  `#`, `//`, `/*`, `<!--`, `--`, `%%`, `;;`
 *   key:     `steering-override:`
 *   name:    `[A-Za-z0-9_-]+`
 *   sep:     `—` (em dash), `–` (en dash), or `-` (hyphen)
 *   reason:  anything up to `*\u002f`, `-->`, or end of line
 */
const OVERRIDE_RE =
  /(?:#|\/\/|\/\*|<!--|--|%%|;;)\s*steering-override:\s*([A-Za-z0-9_-]+)\s*[\u2014\u2013-]\s*(.*?)(?:\*\/|-->|$)/gm;

/**
 * Shorter marker-only regex used to detect when the lazy reason capture
 * in {@link OVERRIDE_RE} swallowed a subsequent override marker. When the
 * scanner finds one, it trims the reason at the marker and rewinds so
 * the next iteration parses the subsequent override cleanly.
 */
const OVERRIDE_MARKER_RE = /(?:#|\/\/|\/\*|<!--|--|%%|;;)\s*steering-override:/;

/**
 * Extract an inline override-comment's reason that targets a specific
 * rule name. Returns the trimmed reason, or null when no override
 * addressed to `ruleName` is present (empty reasons are treated as
 * "no override" — users must supply an explicit justification).
 *
 * Behaviour parity with v1 `extractOverride`:
 *
 *   - case-sensitive rule-name match,
 *   - supports stacked overrides on one line (e.g.
 *     `cmd # steering-override: a — r1 # steering-override: b — r2`),
 *   - first-match-wins across the scanned comments,
 *   - all leader styles from v1 accepted.
 *
 * The v1 implementation is the authoritative reference for edge cases
 * — see `evaluator.ts` in this package's v1 tree.
 */
export function extractOverride(text: string, ruleName: string): string | null {
  // Reset `lastIndex` — the regex is module-scoped and shared across
  // calls. Without the reset two back-to-back calls with different
  // texts would pick up mid-string from the previous scan.
  OVERRIDE_RE.lastIndex = 0;
  let m = OVERRIDE_RE.exec(text);
  while (m !== null) {
    let reason = m[2] ?? "";
    // Compute where the reason capture started in the source so we
    // can rewind the scanner if we trim a trailing next-override
    // marker out of the lazy capture.
    const reasonStart = (m.index ?? 0) + m[0].length - reason.length;
    const nextIdx = reason.search(OVERRIDE_MARKER_RE);
    if (nextIdx !== -1) {
      reason = reason.slice(0, nextIdx);
      OVERRIDE_RE.lastIndex = reasonStart + nextIdx;
    }
    if (m[1] !== ruleName) {
      m = OVERRIDE_RE.exec(text);
      continue;
    }
    reason = reason.trim();
    if (reason === "") {
      m = OVERRIDE_RE.exec(text);
      continue;
    }
    return reason;
  }
  return null;
}
