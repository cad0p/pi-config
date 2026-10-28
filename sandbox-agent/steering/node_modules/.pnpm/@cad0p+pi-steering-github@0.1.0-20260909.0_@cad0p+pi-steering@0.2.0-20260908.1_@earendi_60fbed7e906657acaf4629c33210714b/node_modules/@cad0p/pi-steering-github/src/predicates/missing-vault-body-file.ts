// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `when.missingVaultBodyFile` — fail-closed form + vault-path check
 * backing the two body-file rules (`pr-body-from-vault-file` /
 * `issue-body-from-vault-file`).
 *
 * The ONLY accepted form for `--body-file` is a process substitution
 * running the pinned perl body-strip one-liner:
 *
 *   --body-file <(perl -0777 -pe '<BODY_STRIP>' <vault-note>)
 *
 * The one-liner removes the note's YAML frontmatter block before
 * `gh` uploads it, so GitHub bodies render clean while vault files
 * stay byte-identical (nothing writes them). The predicate is a
 * FORM check PLUS a vault-path validation (restored in #12 — the
 * strip work 0.1.0-20260816.2 dropped the validation): the
 * `<vault-note>` argument must resolve to a real file inside a
 * napkin vault, under a `<repo>/<section>/` directory (`<repo>` =
 * origin URL basename, cwd-folder fallback).
 *
 * The predicate is true (rule fires) when the `--body-file` value is
 * missing, not the substitution form, the inner command deviates
 * from the pinned token sequence, OR the path fails the vault check
 * (nonexistent, outside a vault, wrong section, wrong repo,
 * walker-unknown cwd). Fail-closed: anything unverifiable counts as
 * missing. Edit scoping (#44): an `edit` carrying no body-affecting
 * flag (`--body`/`-b`, `--body-file`/`-F`) is NOT missing —
 * label/title/state/assignee edits pass without the substitution.
 *
 * Args:
 *
 *   - `section: "prs" | "issues"` — the vault-relative directory the
 *     body file must live under.
 *
 * The arg helpers it uses (`findFlagValue`, `findBodyFileValue`,
 * `parseBodyFileArg`, `resolveAgainstCwd`, `bodyHasClosingKeyword`) live in
 * `../helpers/` and are re-exported through `./index.ts` for unit
 * tests and `when.condition` escape-hatch use.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { isNapkinVaultDir } from "@cad0p/pi-napkin/steering";
import type { PredicateContext, PredicateHandler } from "@cad0p/pi-steering";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
import {
  explainBodyFileArg,
  findBodyFileValue,
  parseBodyFileArg,
  resolveAgainstCwd,
} from "../helpers/pattern-args.ts";
import { repoName } from "../helpers/repo-name.ts";

export { BODY_STRIP } from "../helpers/pattern-args.ts";

/** Table-owned gh flag entries, referenced by variable (never re-spelled). */
const { flags: ghFlags } = GH_CLI_DESCRIPTOR;

/** The vault-relative directory the body file must live under. */
export type BodyFileSection = "prs" | "issues";

/**
 * The shared body-file diagnosis (#50 — extends the #43 no-drift
 * pattern from the tag to a struct): computed once, consumed twice.
 * The `missingVaultBodyFile` predicate returns exactly `blocked`;
 * the two body-file rules' reason fns render the same struct, so
 * verdict and message can never drift.
 *
 * Fields after the first failure are `null` (the trace stops there):
 *
 *   - `tag` — the `explainBodyFileArg` tag (the predicate and the
 *     reasons consume the SAME tag computation).
 *   - `received` — the raw `--body-file` value word, `""` if absent.
 *   - `path` — the parsed path token, if any (both `BodyFileArg`
 *     kinds: substitution paths and direct paths).
 *   - `cwd` — the command's effective cwd, `null` on walker-unknown.
 *   - `abs` — `path` resolved against `cwd`, if any.
 *   - `exists` — `abs` is a real file, `null` when uncomputable.
 *   - `vaultRoot` — the enclosing napkin vault, `null` when the file
 *     is missing or outside any vault.
 *   - `repo` — the COMMAND repo (origin basename, cwd-folder
 *     fallback), `null` when undeterminable.
 *   - `blocked` — the verdict.
 */
export interface BodyFileDiagnosis {
  tag: "missing" | "direct" | "form" | "ok" | "diff";
  received: string;
  path: string | null;
  cwd: string | null;
  abs: string | null;
  exists: boolean | null;
  vaultRoot: string | null;
  repo: string | null;
  blocked: boolean;
}

/**
 * Diagnose the command's `--body-file` value: the single source of
 * truth behind the `missingVaultBodyFile` verdict AND the rules'
 * mirror + trace + slotted-recipe reasons. Async — `repo` detection
 * awaits the host `git config` exec (memoized per tool_call by core,
 * so the reason-side second call is free). The control flow mirrors
 * the pre-#50 predicate exactly (fail-closed at every unverifiable
 * stage), so verdicts are byte-identical to before.
 */
export async function diagnose(
  ctx: PredicateContext,
  section: BodyFileSection,
): Promise<BodyFileDiagnosis> {
  const received = findBodyFileValue(ctx);
  const tag = explainBodyFileArg(received);
  const base = {
    tag,
    received,
    path: null as string | null,
    cwd: null as string | null,
    abs: null as string | null,
    exists: null as boolean | null,
    vaultRoot: null as string | null,
    repo: null as string | null,
  };
  // Edit scoping (#44): the vault-body policy applies to an `edit` only
  // when the command WRITES the body. A label/title/state/assignee edit
  // carries no body-affecting flag (`--body`/`-b`, `--body-file`/`-F`)
  // and passes without the substitution; `create` is always gated.
  // The verb is the facade positional after the noun (`pr edit …` →
  // `["pr", "edit", …]` — declared consuming-flag values never
  // leak into the run).
  if (ctx.command.positionals()[1] === "edit") {
    const touchesBody =
      ctx.command.hasFlag(ghFlags.body) ||
      ctx.command.hasFlag(ghFlags.bodyFile);
    if (!touchesBody) return { ...base, blocked: false };
  }
  if (received === "") return { ...base, blocked: true };
  const parsed = parseBodyFileArg(received);
  if (parsed === null) return { ...base, blocked: true };
  if (parsed.kind === "direct") {
    // Direct vault paths upload the file VERBATIM (frontmatter
    // renders on GitHub) — only the pinned substitution is accepted.
    return { ...base, path: parsed.path, blocked: true };
  }
  const cwd =
    typeof ctx.cwd === "string" && ctx.cwd !== "unknown" ? ctx.cwd : null;
  const abs = resolveAgainstCwd(ctx, parsed.path, parsed.quoted);
  if (abs === null) {
    if (cwd !== null) {
      // Known cwd + null abs can only mean tilde expansion failed
      // (HOME unknown) — fail-closed, carrying the cwd so the
      // reason renders the explicit expansion trace line.
      return { ...base, path: parsed.path, cwd, blocked: true };
    }
    // Walker-unknown cwd → fail-closed.
    return { ...base, path: parsed.path, blocked: true };
  }
  let exists = false;
  try {
    exists = existsSync(abs) && statSync(abs).isFile();
  } catch {
    exists = false; // unreadable / raced-away path → fail-closed
  }
  if (!exists) {
    return { ...base, path: parsed.path, cwd, abs, exists, blocked: true };
  }
  const vaultRoot = isNapkinVaultDir(dirname(abs));
  if (vaultRoot === null) {
    // Outside any vault → missing.
    return {
      ...base,
      path: parsed.path,
      cwd,
      abs,
      exists,
      blocked: true,
    };
  }
  // Repo = the origin of the git repo the COMMAND runs in (ctx.cwd),
  // not the body file's dir: the file lives in the shared vault
  // (Goldmine), whose own origin is the vault repo — dirname(abs)
  // would always resolve to the vault's name.
  const repo = await repoName(ctx, ctx.cwd);
  if (repo === null) {
    return {
      ...base,
      path: parsed.path,
      cwd,
      abs,
      exists,
      vaultRoot,
      blocked: true,
    };
  }
  // Vault-relative path must contain <repo>/<section>/ (any depth —
  // e.g. open-source/github/<repo>/prs/… or personal/github/<repo>/prs/…).
  const segments = relative(vaultRoot, abs)
    .split(sep)
    .filter((s) => s !== "");
  const repoIndex = segments.indexOf(repo);
  const blocked = !(repoIndex !== -1 && segments[repoIndex + 1] === section);
  return {
    ...base,
    path: parsed.path,
    cwd,
    abs,
    exists,
    vaultRoot,
    repo,
    blocked,
  };
}

/**
 * `missingVaultBodyFile` — fail-closed form + vault-path check. True
 * when the command's `--body-file` value is missing, not the pinned
 * `<(perl -0777 -pe '<BODY_STRIP>' <path>)` substitution, or a
 * direct path (uploaded verbatim — frontmatter renders on GitHub);
 * and — for a valid substitution — when the path fails the vault
 * check (nonexistent, outside a napkin vault, or not under a
 * `<repo>/<section>/` directory). Fail-closed: anything unverifiable
 * counts as missing.
 */
export const missingVaultBodyFile: PredicateHandler<{
  section: "prs" | "issues";
}> = async (args, ctx: PredicateContext) => {
  // The verdict IS the shared diagnosis's `blocked` flag — the rules'
  // reasons render the same struct, so verdict and message never drift.
  return (await diagnose(ctx, args.section)).blocked;
};
