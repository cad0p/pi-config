// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `commit-description-check` — self-marking reminder rule.
 *
 * Demonstrates `Rule.onFire` + self-marking (ADR §6, §14):
 *
 *   - Pattern `/^git\s+commit\b/` matches any commit command.
 *   - `when.missing: { event: DESCRIPTION_REVIEWED_EVENT, in: "agent_loop" }`
 *     fires when the reminder entry has NOT been written this loop.
 *   - `onFire: markDescriptionReviewed` writes that entry when the
 *     rule blocks. First commit per agent loop → blocks with the
 *     reminder, self-marks. Second commit in the same loop → the
 *     entry is now present, `when.missing` no longer fires, commit
 *     is allowed.
 *
 * ## Encapsulation (ADR §14)
 *
 * No corresponding observer ships the `DESCRIPTION_REVIEWED_EVENT`
 * event — the rule is the producer and the consumer. The convention
 * for that case is: the constant + helper live IN THE RULE FILE
 * itself. Observer files own their constants; self-marking rule
 * files own theirs.
 *
 * Override: allowed. Skipping the reminder is a workflow choice.
 */

import type { PredicateContext, Rule } from "@cad0p/pi-steering";

/**
 * Session-entry type written by this rule's `onFire`. Exported so
 * tests (or any other rule / observer in the same plugin) can
 * reference the same literal.
 */
export const DESCRIPTION_REVIEWED_EVENT =
  "example-description-reviewed" as const;

/**
 * Shape of the payload written on self-mark. Minimal — the rule just
 * needs a presence marker; the timestamp the engine attaches via
 * `findEntries` is enough for any downstream logic.
 */
interface DescriptionReviewedPayload {
  /** Which commit command variant the reminder fired on. */
  command: string;
}

/**
 * Helper that writes the reminder entry. The ADR §14 pattern: both
 * the constant and the writer live with the producing rule. If a
 * future observer needed to ALSO write this type, we'd move both into
 * an observer file; here, the rule is the sole writer so the rule
 * file owns it.
 */
export function markDescriptionReviewed(
  ctx: PredicateContext,
  payload: DescriptionReviewedPayload = { command: "" },
): void {
  ctx.appendEntry<DescriptionReviewedPayload>(
    DESCRIPTION_REVIEWED_EVENT,
    payload,
  );
}

export const commitDescriptionCheck = {
  name: "commit-description-check",
  tool: "bash",
  command: "git",
  when: {
    subcommand: "commit",
    missing: { event: DESCRIPTION_REVIEWED_EVENT, in: "agent_loop" },
  },
  reason:
    "Re-read the commit description before committing. This reminder fires once per agent loop — your next commit in this loop will go through.",
  noOverride: false,
  writes: [DESCRIPTION_REVIEWED_EVENT],
  onFire: (ctx) => {
    markDescriptionReviewed(ctx, {
      command: ctx.input.command ?? "",
    });
  },
} as const satisfies Rule;
