// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Mirror + trace + slotted-recipe renderer for the two body-file
 * rules' non-`diff` block reasons (#50 — the diagnostic gap behind
 * #48/#49).
 *
 * The `diff` stage keeps its #43 byte-diff diagnostic (`diff` branch
 * untouched); every other blocked stage renders from the shared
 * `BodyFileDiagnosis` struct, so verdict and message never drift:
 *
 *   - MIRROR — the path-side only (the program keeps its #43 diff):
 *     a parsed path token is mirrored verbatim (so a `<`-prefixed
 *     typo like #48/#49 shows its `<`); a present-but-unparsable
 *     value is mirrored as the value word plus the generic
 *     token-count structure line; an absent value has nothing to
 *     mirror (recipe only, as before); a direct path is mirrored
 *     verbatim plus the one-line verbatim-upload note.
 *   - TRACE — uniform walk received, resolved, exists, vault, then
 *     repo and section: each computed line printed, stop at the
 *     first failure, plus one expectation line.
 *   - RECIPE — the canonical recipe with the vault/repo slots filled
 *     from the diagnosis (`VAULT` / `REPO` bare words when
 *     undiscovered). No angle-bracket placeholders anywhere — they
 *     taught the very `<path` typo being fixed.
 */

import { relative } from "node:path";
import type {
  BodyFileDiagnosis,
  BodyFileSection,
} from "../predicates/missing-vault-body-file.ts";
import { BODY_STRIP } from "./body-strip.ts";
import {
  countSubstitutionTokens,
  EXPECTED_SUBSTITUTION_TOKENS,
} from "./pattern-args.ts";

const NEWLINE = "\n";

/**
 * The canonical static recipe with unfilled slots (byte-identity
 * pinned in `index.test.ts` via the missing-stage reason). The
 * rules keep it as their `STATIC` const for the `diff` branch and
 * the degraded fallback; blocked non-`diff` stages render the
 * slotted form below instead.
 */
export function renderStaticRecipe(section: BodyFileSection): string {
  return renderSlottedRecipe(null, null, section);
}

/**
 * The slotted recipe: vault slot = the discovered vault root else
 * bare `VAULT`; repo slot = the detected command repo else bare
 * `REPO`. The any-depth `**` segment stays schematic.
 */
export function renderSlottedRecipe(
  vaultRoot: string | null,
  repo: string | null,
  section: BodyFileSection,
): string {
  const vault = vaultRoot ?? "VAULT";
  const name = repo ?? "REPO";
  const head =
    section === "prs"
      ? "PR bodies must come from a body file in the napkin vault:"
      : "Issue bodies must come from a body file in the napkin vault:";
  const command = section === "prs" ? "gh pr create" : "gh issue create";
  const dir = section === "prs" ? "prs" : "issues";
  const stem = section === "prs" ? "pr<N>" : "issue<N>";
  const lines = [
    head,
    `  ${command} --title "..." --body-file <(perl -0777 -pe '${BODY_STRIP}' ${vault}/**/${name}/${dir}/YYYY-MM-DD-${stem}-<slug>.md)`,
  ];
  if (section === "issues") {
    lines.push(
      "- If foreign issue: cd to the repo you want to file the issue; " +
        "REQUIREMENT: have a foreign subagent maintainer loop before filing",
    );
  }
  return lines.join(NEWLINE);
}

/**
 * Render the non-`diff` block reason from the shared diagnosis:
 * mirror + trace, then the slotted recipe. `diff` never reaches
 * here (the rules route it to the #43 byte-diff diagnostic).
 */
export function renderDiagnosedReason(
  d: BodyFileDiagnosis,
  section: BodyFileSection,
): string {
  const recipe = renderSlottedRecipe(d.vaultRoot, d.repo, section);
  switch (d.tag) {
    case "missing":
      // Absent value — nothing to mirror; recipe only (as before).
      return recipe;
    case "direct":
      return [
        `--body-file path as received: ${d.path ?? d.received}`,
        "direct paths upload verbatim (frontmatter renders on GitHub) — only the pinned substitution is accepted",
        "",
        recipe,
      ].join(NEWLINE);
    case "form":
    case "diff": {
      // Present but unparsable — mirror the value word plus the
      // generic token-count structure line.
      const lines = [renderValueMirror(d)];
      lines.push("", recipe);
      return lines.join(NEWLINE);
    }
    case "ok":
      return [...renderTraceLines(d, section), "", recipe].join(NEWLINE);
  }
}

/**
 * The unparsable-value mirror: the value word plus the structure
 * line (`4 tokens inside <(…), expected 5 (perl -0777 -pe PROGRAM
 * PATH)`).
 */
function renderValueMirror(d: BodyFileDiagnosis): string {
  const count = countSubstitutionTokens(d.received);
  const structure =
    count === null
      ? "expected <(perl -0777 -pe PROGRAM PATH)"
      : `${count} tokens inside <(…), expected ${EXPECTED_SUBSTITUTION_TOKENS} (perl -0777 -pe PROGRAM PATH)`;
  return `value as received: ${d.received} — ${structure}`;
}

/**
 * The uniform trace: each computed line printed, stop at the first
 * failure. Only reached on the `ok` tag with `blocked` true, so the
 * last line always names the failing check.
 */
function renderTraceLines(
  d: BodyFileDiagnosis,
  section: BodyFileSection,
): string[] {
  const lines = [`--body-file path as received: ${d.path ?? d.received}`];
  if (d.cwd === null) {
    lines.push("resolved against cwd: unknown — fail-closed");
    return lines;
  }
  if (d.abs === null) {
    // Known cwd + null abs: tilde expansion failed (HOME unknown).
    lines.push("tilde expansion: HOME unknown — fail-closed");
    return lines;
  }
  lines.push(`resolved against cwd ${d.cwd}: ${d.abs}`);
  lines.push(`exists: ${d.exists === true ? "yes" : "no"}`);
  if (d.exists !== true) return lines;
  if (d.vaultRoot === null) {
    lines.push("vault: none — not inside a napkin vault, fail-closed");
    return lines;
  }
  lines.push(`vault root: ${d.vaultRoot}`);
  if (d.repo === null) {
    lines.push("repo: unknown — cannot determine the command repo");
    return lines;
  }
  lines.push(`repo (command cwd): ${d.repo}`);
  const rel = relative(d.vaultRoot, d.abs);
  lines.push(
    `placement: ${rel} is not under ${d.repo}/${section}/ — fail-closed`,
  );
  return lines;
}

/**
 * The degraded fallback: the reason-side `diagnose` call failed
 * (a throwing reason is replaced wholesale by the evaluator's
 * fail-safe fallback), so render the mirror of whatever value word
 * survived plus the static recipe. Never throws.
 */
export function renderDegradedReason(
  received: string,
  section: BodyFileSection,
): string {
  try {
    const mirror =
      received !== ""
        ? `--body-file value as received: ${received}${NEWLINE}`
        : "";
    return `${mirror}${renderStaticRecipe(section)}`;
  } catch {
    return renderStaticRecipe(section);
  }
}
