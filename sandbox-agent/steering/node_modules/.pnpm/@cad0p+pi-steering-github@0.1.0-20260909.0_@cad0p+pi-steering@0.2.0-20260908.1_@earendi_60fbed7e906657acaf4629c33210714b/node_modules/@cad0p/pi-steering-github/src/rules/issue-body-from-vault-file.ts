// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `issue-body-from-vault-file` — issue bodies must come from a vault
 * note, uploaded through the same pinned perl substitution (create
 * and edit): `--body-file
 * <(perl -0777 -pe '<BODY_STRIP>' <vault-file>)`. Direct
 * paths (verbatim upload) and inline `--body` are blocked. The path
 * argument is additionally validated (see `missingVaultBodyFile`):
 * it must resolve to a real file inside a napkin vault under
 * `<repo>/issues/`. No keyword requirement (issues close nothing).
 * Routes on `command: "gh"` + the `subcommand:` sequences — ANY
 * leading-flag position is structural now, so a gate-released
 * flag-first form lands here instead of bypassing the policy. Edit
 * scoping (#44): an `issue edit` carrying no body-affecting flag
 * (`--body`/`-b`, `--body-file`/`-F`) skips this rule — `gh issue
 * edit 8845 --add-label bug` passes without the substitution.
 *
 * Strict — no override (schema default).
 *
 * Since #43 the `reason` is a dynamic `ReasonFn` (same shared
 * diagnostic as `pr-body-from-vault-file` — both rules consume the
 * SAME `explainBodyFileArg` tag + `renderBodyFileDiff` helper, so
 * the byte-diff format can never drift between them). Since #50
 * every other blocked stage renders mirror + trace + slotted recipe
 * from the shared `diagnose()` struct (same struct as the verdict).
 */

import type { Rule } from "@cad0p/pi-steering";
import {
  renderDegradedReason,
  renderDiagnosedReason,
  renderStaticRecipe,
} from "../helpers/body-file-reason.ts";
import {
  explainBodyFileArg,
  findBodyFileValue,
  renderBodyFileDiff,
} from "../helpers/pattern-args.ts";
import { diagnose } from "../predicates/missing-vault-body-file.ts";

/** The canonical static recipe (byte-identity pinned in `index.test.ts`). */
const STATIC = renderStaticRecipe("issues");

export const issueBodyFromVaultFile = {
  name: "issue-body-from-vault-file",
  tool: "bash",
  command: "gh",
  when: {
    subcommand: {
      anyOf: [
        ["issue", "create"],
        ["issue", "edit"],
      ],
      onUnknown: "allow",
    },
    missingVaultBodyFile: { section: "issues" },
  },
  reason: async (ctx) => {
    const v = findBodyFileValue(ctx);
    if (explainBodyFileArg(v) === "diff") {
      return `${renderBodyFileDiff(v)}\n\n${STATIC}`;
    }
    // Same struct the predicate verdict came from — mirror + trace +
    // slotted recipe (#50). A throwing reason is replaced wholesale
    // by the evaluator's fail-safe fallback, so the diagnose call is
    // wrapped with a degraded mirror+recipe fallback that never throws.
    try {
      return renderDiagnosedReason(await diagnose(ctx, "issues"), "issues");
    } catch {
      return renderDegradedReason(v, "issues");
    }
  },
} as const satisfies Rule;
