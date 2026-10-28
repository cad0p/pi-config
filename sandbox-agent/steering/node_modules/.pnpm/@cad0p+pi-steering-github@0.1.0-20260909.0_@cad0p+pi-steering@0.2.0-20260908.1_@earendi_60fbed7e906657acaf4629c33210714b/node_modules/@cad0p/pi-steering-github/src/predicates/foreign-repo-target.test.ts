// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `foreignRepoTarget` pins: the handler logic moved 1:1 from the
 * former inline `unless` describe of `gh-repo-flag-before-
 * subcommand` and return-INVERTED (the closure returned true to
 * release; a registered predicate returns true to FIRE = BLOCK).
 *
 * The quoted-help / `--help=` carve-out pins deliberately do NOT
 * live here: the carve-out left the handler (it is the rule's
 * `not.infoOnly` leaf now), so a moved assertion would flip sign and
 * test nothing — they stay at the composed-rule level in the rule's
 * test file. The delta-1 `--version` rows below pin that the handler
 * itself is INDIFFERENT to version tokens; the user-visible block→
 * allow flip for gated invocations carrying them is composed by the
 * not-leaf and pinned end-to-end in `../integration.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateContext, PredicateWord } from "@cad0p/pi-steering";
import { mockContext } from "@cad0p/pi-steering/testing";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
import { foreignRepoTarget } from "./foreign-repo-target.ts";

/**
 * Split a command line the way the walker would: whitespace separates
 * tokens outside quotes; `"…"` / `'…'` groups stay ONE word (text
 * keeps the quotes, value is the resolved inner text — exactly what
 * `ctx.command`'s quote-aware reads see). This replaces the old
 * space-split helper, whose fragments (`"-Rfoo/bar`, `ref"`) only
 * approximated quoted values.
 */
function splitWords(command: string): PredicateWord[] {
  const out: PredicateWord[] = [];
  let text = "";
  let value = "";
  let quote: string | null = null;
  const push = () => {
    if (text !== "") {
      out.push({ value, text, rawText: text, pos: 0, end: text.length });
      text = "";
      value = "";
    }
  };
  for (const ch of command) {
    if (quote !== null) {
      text += ch;
      if (ch === quote) quote = null;
      else value += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      text += ch;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      text += ch;
      value += ch;
    }
  }
  push();
  return out;
}

describe("github plugin — foreignRepoTarget (basename match / fail-closed)", () => {
  // Stub ctx with walker args + a repoName-resolving cwd. `repoName`
  // itself is NOT stubbed — it runs the real origin-URL query via
  // ctx.exec against a recording host (integration-level fidelity at
  // unit cost). A null-resolving host answers nothing (fallback: cwd
  // folder name). The handler is invoked with bare `true`, mirroring
  // the enabled leaf (`foreignRepoTarget: true` ≡ spread `{}`).
  function ctxWith(
    command: string,
    opts: { cwd?: string; remote?: string | null } = {},
  ): PredicateContext {
    const exec =
      opts.remote === null
        ? () =>
            Promise.resolve({
              stdout: "",
              stderr: "",
              exitCode: 1,
            })
        : (_cmd: string, _a: readonly string[]) =>
            Promise.resolve({
              stdout: opts.remote ?? "",
              stderr: "",
              exitCode: 0,
            });
    return mockContext({
      cwd: opts.cwd ?? "/home/me/pi-steering-github",
      input: {
        tool: "bash",
        command,
        basename: "gh",
        args: splitWords(command).slice(1),
      },
      descriptors: { gh: GH_CLI_DESCRIPTOR },
      exec,
    });
  }

  it("bare false never fires (step-0 guard, even on would-block argv)", async () => {
    // Handlers receive the leaf value verbatim: `foreignRepoTarget:
    // false` must disable the gate WITHOUT running the argv logic —
    // this argv alone would block (foreign target).
    const ctx = ctxWith("gh -R cad0p/other pr merge --squash");
    assert.equal(await foreignRepoTarget(false, ctx), false);
  });

  it("releases the fork→upstream flow: target basename == cwd repo basename", async () => {
    // `gh -R upstream/pi-steering-github pr create` from inside the
    // `cad0p/pi-steering-github` clone — the most common legit `-R`
    // use.
    const ctx = ctxWith(
      "gh -R upstream/pi-steering-github pr create --title t",
      {
        remote: "https://github.com/cad0p/pi-steering-github.git",
      },
    );
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("releases commands with no -R/--repo anywhere (absent, #39)", async () => {
    // Presence-based gating (#39): `-v` / `--hostname` leading flags
    // route under the widened shape router but carry NO repo flag —
    // absent → release, fall-through to the per-subcommand rules.
    const vCtx = ctxWith("gh -v pr create --title t", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, vCtx), false);
    const hCtx = ctxWith("gh --hostname x pr create --title t", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, hCtx), false);
  });

  it("releases subcommand-first mutations with no -R anywhere (#39)", async () => {
    // The core absent-state pins: plain gated mutations never touch
    // the gate — zero verdict change for commands carrying no
    // `-R`-shaped token.
    const mCtx = ctxWith("gh pr merge --squash", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, mCtx), false);
    const eCtx = ctxWith("gh issue edit 3", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, eCtx), false);
  });

  it("releases slashless -R upstream (fork remote-name form)", async () => {
    // `gh -R upstream pr create` — no `/` → not a foreign owner/repo
    // redirect.
    const ctx = ctxWith("gh -R upstream pr create --title t", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("releases a different-owner same-basename target (fork)", async () => {
    const ctx = ctxWith("gh -R other/pi-steering-github pr create --title t", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("fires on a foreign target (basename mismatch)", async () => {
    const ctx = ctxWith("gh -R cad0p/other pr merge --squash", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("fails closed when the cwd repo is unresolvable (repoName = 'unknown' sentinel)", async () => {
    // Walker-unknown cwd: repoName's cwd-folder fallback yields the
    // literal string "unknown" (NOT null) — fail-closed, fire.
    const ctx = ctxWith("gh -R cad0p/other pr merge --squash", {
      cwd: "unknown",
      remote: null,
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("releases --repo=x/y (glued long form) same-basename — getFlagValue sees it", async () => {
    const ctx = ctxWith(
      "gh --repo=cad0p/pi-steering-github pr merge --squash",
      {
        remote: "https://github.com/cad0p/pi-steering-github.git",
      },
    );
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("releases own-repo glued short form -Rcad0p/x (basename match)", async () => {
    // Table-derived glue for `R`: `-Rcad0p/pi-steering-github`
    // resolves → basename equality → release.
    const ctx = ctxWith("gh -Rcad0p/pi-steering-github pr create --title t", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("fires on a foreign glued short form -Rcad0p/other", async () => {
    // Glue awareness cuts both ways: a FOREIGN owner/repo in glued
    // short form now RESOLVES instead of fail-closing on null —
    // basename mismatch → fire.
    const ctx = ctxWith("gh -Rcad0p/other pr merge --squash", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("BEHAVIOR DELTA (#34): glued member loses to later bare alias", async () => {
    // `gh -Rcad0p/other … --repo cad0p/pi-steering-github`: LAST-wins
    // spans mixed forms — the trailing bare `--repo` overrides the
    // earlier glued occurrence → own repo → release.
    const ctx = ctxWith(
      "gh -Rcad0p/other pr create --repo cad0p/pi-steering-github",
      { remote: "https://github.com/cad0p/pi-steering-github.git" },
    );
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("BEHAVIOR DELTA (#34): glued member wins over earlier attached alias", async () => {
    // Mirror direction: trailing glued `-Rcad0p/other` overrides the
    // earlier attached `--repo=` own-repo value → foreign → fire.
    const ctx = ctxWith(
      "gh --repo=cad0p/pi-steering-github pr merge -Rcad0p/other",
      { remote: "https://github.com/cad0p/pi-steering-github.git" },
    );
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("fails closed: glued occurrence then trailing valueless -R", async () => {
    // #34 semantics are form-agnostic: the trailing BARE `-R` is the
    // last occurrence → exact-match valueless → null, NO fallback to
    // the overridden glued value → fire.
    const ctx = ctxWith("gh -Rcad0p/pi-steering-github pr merge -R", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("releases glued slashless -Rupstream (fork remote-name form)", async () => {
    // Glued short form of the slashless remote-name flow: `-Rupstream`
    // resolves to `upstream` → no `/` → step-4 release.
    const ctx = ctxWith("gh -Rupstream pr merge", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("fails closed on empty attached short-form value -R=", async () => {
    // Attached branch outranks glued: `-R=` matches the `-R=` prefix
    // → value "" (NOT a glued decomposition of letter R) → step-3
    // fail-close. gh errors on an empty repo anyway.
    const ctx = ctxWith("gh -Rcad0p/pi-steering-github pr merge -R=", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("BEHAVIOR DELTA (consumption completeness): slashless -m value no longer masks (was release)", async () => {
    // FLIP from the old "accepted limitation" release pin: `-m/--milestone`
    // is now tabled takesValue:true (`gh help pr edit` shows
    // `-m, --milestone name`), so the quoted milestone value
    // `"-Rebased onto main"` is CONSUMED as `-m`'s value and hidden from
    // `-R` resolution — the leading foreign `-Rcad0p/other` wins → FIRE.
    // The old release was the hijack hole (a slashless body word masking a
    // foreign target behind step-4 release); consumption completeness closes
    // it. Fail-closed direction, pinned so it cannot regress silently.
    const ctx = ctxWith('gh -Rcad0p/other pr edit 46 -m "-Rebased onto main"', {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("BEHAVIOR DELTA (consumption completeness): slashful -m value no longer over-blocks (was fire)", async () => {
    // FLIP from the old over-block pin: with `-m` consuming, the quoted
    // `"-Rfoo/bar ref"` is `-m`'s milestone VALUE (hidden), not an `-R`
    // target — resolution sees only the leading own-repo target → basename
    // match → RELEASE. The old fire was the hijack hole's fail-closed twin
    // (a slashful body word hijacking resolution); hiding is the correct,
    // `--help`-faithful verdict. Pinned so the flip cannot change silently.
    const ctx = ctxWith(
      'gh -Rcad0p/pi-steering-github pr edit 46 -m "-Rfoo/bar ref"',
      {
        remote: "https://github.com/cad0p/pi-steering-github.git",
      },
    );
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("BEHAVIOR DELTA (#36 delta 1): bare --version leaves the handler indifferent", async () => {
    // The help/version carve-out lives in the rule's `not.infoOnly`
    // leaf, NOT here — so the handler's verdict for a --version-
    // carrying command is exactly what the plain target/basename
    // rails produce (own-repo basename match → release). The
    // user-visible block→allow flip for FOREIGN targets carrying
    // --version happens because the not-leaf allows before this
    // handler is ever consulted — pinned end-to-end in
    // integration.test.ts.
    const ctx = ctxWith("gh -R cad0p/pi-steering-github pr create --version", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("BEHAVIOR DELTA (#36 delta 1): attached --version=1 likewise", async () => {
    const ctx = ctxWith(
      "gh -R cad0p/pi-steering-github pr create --version=1",
      { remote: "https://github.com/cad0p/pi-steering-github.git" },
    );
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("BEHAVIOR DELTA (#34): cross-alias override — last alias wins", async () => {
    // `gh -R <own> … --repo cad0p/other`: gh/cobra collapse repeated
    // spellings of one logical flag to the LAST value, so the command
    // targets `cad0p/other`. The old `??` composition let the
    // FIRST-seen alias (`-R`, own repo) win → basename match →
    // release (wrong vs gh). Last-wins resolution sees the foreign
    // override → fire. This is THE regression pin issue #34 asks
    // for.
    const ctx = ctxWith(
      "gh -R cad0p/pi-steering-github pr create --repo cad0p/other",
      { remote: "https://github.com/cad0p/pi-steering-github.git" },
    );
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("BEHAVIOR DELTA (#34): trailing valueless alias fail-closes", async () => {
    // A trailing bare `-R` is the LAST occurrence across the aliases;
    // last-wins getFlagValue returns null with NO fallback to the
    // overridden earlier `--repo` value (real pflag errors on it
    // anyway) — fail-closed fire. Old code fell through `??` to the
    // earlier valued alias and allowed.
    const ctx = ctxWith("gh --repo cad0p/pi-steering-github pr merge -R", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("BEHAVIOR DELTA (#34): empty attached value as last occurrence fail-closes", async () => {
    // `--repo=` (empty ATTACHED value, distinct from the space-form
    // valueless case above) is the last occurrence → getFlagValue
    // returns "" → fail-closed fire. Old code's `-R` call won the
    // `??` and took the basename path (release for own repo). gh
    // errors on an empty repo anyway — accepted over-block.
    const ctx = ctxWith("gh -R cad0p/pi-steering-github pr create --repo=", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("fails closed: subcommand-position trailing bare -R (present-unparsable, #39)", async () => {
    // The unparsable fail-close holds in BOTH flag positions now:
    // `gh pr merge -R` carries a repo flag (present) whose value is
    // unresolvable (trailing valueless alias → null) — no escape via
    // position.
    const ctx = ctxWith("gh pr merge -R", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("fails closed: subcommand-position empty attached --repo= (#39)", async () => {
    const ctx = ctxWith("gh pr create --title t --repo=", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("releases a subcommand-first OWN-repo target (#39)", async () => {
    // `gh issue edit 3 --repo=<cwd repo>` — basename equality →
    // release; falls through to the per-subcommand policies.
    const ctx = ctxWith("gh issue edit 3 --repo=cad0p/pi-steering-github", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("fires on a subcommand-first FOREIGN glued short form (#39)", async () => {
    const ctx = ctxWith("gh issue edit 3 -Rcad0p/other", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("BEHAVIOR DELTA (consumption completeness): -R-shaped -m VALUE no longer fires (was over-block)", async () => {
    // FLIP from the old subcommand-first over-block pin: `gh -v pr merge
    // -m "-Rfoo/bar ref"` carries NO `-R/--repo` flag — the `-Rfoo/bar ref`
    // word is `-m`'s consumed VALUE now (`-m/--milestone` takesValue:true;
    // `-m/--merge` bool collision resolved value-side, see descriptor
    // ALARMS), so the gate is ABSENT → release. The old fire read a VALUE
    // word as a flag (hijack-leaning); hiding is `--help`-faithful.
    const ctx = ctxWith('gh -v pr merge -m "-Rfoo/bar ref"', {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("BEHAVIOR DELTA (#39): non-repo leading flag + later real --repo now blocks", async () => {
    // `gh -v pr merge --repo=cad0p/foreign`: the #36-era shape check
    // released on the FIRST flag token (`-v`) even though a real repo
    // flag sat later in the line; presence-based gating sees it →
    // fire. Deliberate policy fix (#34-style delta row), pinned so it
    // cannot regress silently.
    const ctx = ctxWith("gh -v pr merge --repo=cad0p/foreign", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), true);
  });

  it("ACCEPTED EDGE (collision alarm -m): bool-context over-consumption hides --repo", async () => {
    // `gh pr merge -m --repo=cad0p/foreign`: `-m` is bool under `pr
    // merge` (`-m/--merge`) but the table resolves takesValue:true
    // (milestone row — 4 value contexts vs 1 bool, see COLLISION
    // ALARMS in ../descriptors.ts), so `-m` CONSUMES the attached
    // `--repo=cad0p/foreign` token as its value → gate is ABSENT →
    // RELEASE, hiding a foreign target (fail-open-leaning). Control:
    // bare `gh pr merge --repo=cad0p/foreign` fires. Narrow/rare —
    // accepted, FOR CORE. Pinned so any silent flip (takesValue,
    // consumption, hasFlag skip) goes red.
    const ctx = ctxWith("gh pr merge -m --repo=cad0p/foreign", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("ACCEPTED EDGE (collision alarm -r): bool-context over-consumption hides --repo", async () => {
    // `gh pr merge -r --repo=cad0p/foreign`: `-r` is bool under `pr
    // merge` (`-r/--rebase`) but the table resolves takesValue:true
    // (reviewer + remote rows, see COLLISION ALARMS in
    // ../descriptors.ts), so `-r` CONSUMES the attached
    // `--repo=cad0p/foreign` token → ABSENT → RELEASE, hiding a
    // foreign target (fail-open-leaning). Control: bare `--repo=`
    // form fires. Narrow — accepted, FOR CORE. Red on silent flip.
    const ctx = ctxWith("gh pr merge -r --repo=cad0p/foreign", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("ACCEPTED EDGE (collision alarm -s): bool-context over-consumption hides --repo", async () => {
    // `gh pr merge -s --repo=cad0p/foreign`: `-s` is bool under `pr
    // merge` (`-s/--squash`) but the table resolves takesValue:true
    // (source row, see COLLISION ALARMS in ../descriptors.ts), so
    // `-s` CONSUMES the attached `--repo=cad0p/foreign` token →
    // ABSENT → RELEASE, hiding a foreign target (fail-open-leaning).
    // Narrow — accepted, FOR CORE. Red on silent flip.
    const ctx = ctxWith("gh pr merge -s --repo=cad0p/foreign", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("ACCEPTED EDGE (collision alarm -d): bool-context over-consumption hides --repo", async () => {
    // `gh pr merge -d --repo=cad0p/foreign`: `-d` is bool under `pr
    // merge` (`-d/--delete-branch`) and under `pr create`
    // (`-d/--draft`) but the table resolves takesValue:true
    // (description row — free-text is the most hijack-prone value,
    // see COLLISION ALARMS in ../descriptors.ts), so `-d` CONSUMES
    // the attached `--repo=cad0p/foreign` token → ABSENT → RELEASE,
    // hiding a foreign target (fail-open-leaning). Narrow —
    // accepted, FOR CORE. Red on silent flip.
    const ctx = ctxWith("gh pr merge -d --repo=cad0p/foreign", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });

  it("ACCEPTED EDGE (collision alarm -h): bool-context over-consumption hides --repo", async () => {
    // `gh pr merge -h --repo=cad0p/foreign`: `-h` is bool help but
    // the table resolves takesValue:true (homepage row — the help
    // entry keeps `-h` as a bool spelling but consumption derives
    // true from the homepage row, see COLLISION ALARMS in
    // ../descriptors.ts), so `-h` CONSUMES the attached
    // `--repo=cad0p/foreign` token → ABSENT → RELEASE, hiding a
    // foreign target (fail-open-leaning). Predicate-level only: real
    // help forms (`gh … -h`) still exempt via the rule's token-level
    // `infoOnly` leaf, which uses its own bool entries, not table
    // consumption. Accepted, FOR CORE. Red on silent flip.
    const ctx = ctxWith("gh pr merge -h --repo=cad0p/foreign", {
      remote: "https://github.com/cad0p/pi-steering-github.git",
    });
    assert.equal(await foreignRepoTarget(true, ctx), false);
  });
});
