// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * `gh-repo-flag-before-subcommand` pins: the declarative when-shape
 * (no unless closure — the basename gate lives in the registered
 * `foreignRepoTarget` predicate, whose own unit tests live in
 * `../predicates/foreign-repo-target.test.ts`), the COMPOSED help
 * carve-out through the real evaluator (the carve-out lives in the
 * rule's `not.infoOnly` leaf, so its pins must assert the composed
 * rule — a predicate-level assertion would flip sign and test
 * nothing), and the dynamic ReasonFn output (byte-pinned,
 * value-based rendering).
 *
 * Routing truth tables (which commands reach the rule at all) live at
 * the engine level in `../integration.test.ts` — routing is
 * structural now (`command: "gh"` + `when.subcommand` sequences, core
 * #117), not a regex surface.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defineConfig, type PredicateWord } from "@cad0p/pi-steering";
import {
  createRecordingHost,
  loadHarness,
  mockContext,
  mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import { GH_CLI_DESCRIPTOR } from "../descriptors.ts";
// The composed-gate describe needs the whole plugin object (the rule
// alone can't evaluate: the `not.infoOnly` + `foreignRepoTarget`
// leaves resolve through this plugin's registered predicates at
// evaluation time).
import { githubPlugin } from "../index.ts";
import {
  foreignRepoReason,
  ghRepoFlagBeforeSubcommand,
} from "./gh-repo-flag-before-subcommand.ts";

describe("github plugin — gh-repo-flag-before-subcommand (declarative shape)", () => {
  it("routes command-first: command gh + the six gated subcommand sequences", () => {
    const rule = ghRepoFlagBeforeSubcommand as unknown as {
      tool?: unknown;
      command?: unknown;
      field?: unknown;
      pattern?: unknown;
      when?: {
        condition?: unknown;
        not?: { infoOnly?: unknown };
        foreignRepoTarget?: unknown;
        subcommand?: unknown;
      };
    };
    assert.equal(rule.tool, "bash");
    assert.equal(rule.command, "gh");
    assert.equal(
      rule.field,
      undefined,
      "no field: — bash routing is command: now (core #117)",
    );
    assert.equal(
      rule.pattern,
      undefined,
      "no pattern: — the shape router is retired (closes #55)",
    );
    assert.deepEqual(rule.when?.subcommand, {
      anyOf: [
        ["pr", "create"],
        ["pr", "new"],
        ["pr", "edit"],
        ["pr", "merge"],
        ["issue", "create"],
        ["issue", "edit"],
      ],
      onUnknown: "allow",
    });
  });

  it("gates declaratively: not.infoOnly + foreignRepoTarget, zero condition code", () => {
    const rule = ghRepoFlagBeforeSubcommand as unknown as {
      unless?: unknown;
      when?: {
        condition?: unknown;
        not?: { infoOnly?: unknown };
        foreignRepoTarget?: unknown;
      };
    };
    assert.equal(
      rule.unless,
      undefined,
      "no unless — the gate must be declarative when-only",
    );
    assert.equal(
      rule.when?.condition,
      undefined,
      "zero condition code — the predicates fully replace when.condition",
    );
    // Carve-out leaf: read-only introspection never blocks (--help/
    // --version defaults + GitHub's additive -h; accepted exposure:
    // bare/attached --version also exempts — invalid invocations).
    assert.deepEqual(
      rule.when?.not?.infoOnly,
      { extraFlags: ["-h"] },
      "the info-only carve-out must be negated via not:",
    );
    assert.equal(
      rule.when?.foreignRepoTarget,
      true,
      "the foreign-target gate must be the package's registered predicate, enabled bare",
    );
  });
});

describe("github plugin — gh-repo-flag-before-subcommand composed gate (engine eval)", () => {
  // The help carve-out lives in the rule's `not.infoOnly` leaf, so
  // its pins assert the COMPOSED rule through the REAL evaluator
  // pipeline (defineConfig + loadHarness + recording host — same
  // fixture pattern as ../integration.test.ts). The `infoOnly` leaf
  // resolves through this plugin's own registered predicate
  // (re-exported from `@cad0p/pi-steering-flags`) at evaluation time.
  const config = defineConfig({ plugins: [githubPlugin] });

  const fixtures: string[] = [];

  function makeFixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "steering--r-rule-fixture-"));
    fixtures.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of fixtures.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function hostWithRemote(remoteUrl: string) {
    return createRecordingHost({
      exec: (cmd, args) => {
        if (
          cmd === "git" &&
          args[0] === "config" &&
          args[1] === "--get" &&
          args[2] === "remote.origin.url"
        ) {
          return Promise.resolve({
            stdout: remoteUrl,
            stderr: "",
            code: 0,
            killed: false,
          });
        }
        return Promise.resolve({
          stdout: "",
          stderr: "",
          code: 0,
          killed: false,
        });
      },
    });
  }

  async function evaluateBash(
    cwd: string,
    command: string,
  ): Promise<{ block: boolean; rule: string | null | undefined }> {
    const host = hostWithRemote(
      "https://github.com/cad0p/pi-steering-github.git",
    );
    const ctx = mockExtensionContext(cwd, host.entries);
    const harness = loadHarness({ config, host });
    const event = {
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "bash",
      input: { command },
    } as unknown as Parameters<typeof harness.evaluate>[0];
    const result = await harness.evaluate(event, ctx, 1);
    if (result === undefined || result === null || result.block !== true) {
      return { block: false, rule: null };
    }
    const raw = result.reason ?? "";
    const reason = typeof raw === "string" ? raw : String(raw);
    // Same preamble-tolerant anchor as integration.test.ts: the tag
    // is line 1 pre-preamble, line 2 after the block-reason preamble
    // landed (pi-steering issue #85).
    const match = reason.match(/(?:^|\n)\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
    return { block: true, rule: match ? match[1] : null };
  }

  it("bare --help / -h allow (composed read-only introspection)", async () => {
    for (const cmd of [
      "gh -R cad0p/other pr merge --help",
      "gh -R cad0p/other pr merge -h",
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (block by ${rule})`,
      );
    }
  });

  it("a --help inside a QUOTED VALUE must NOT exempt (token-level leaf)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      'gh -R cad0p/other pr merge --subject "see --help"',
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("glued lookalikes (--helper, -hx) do NOT exempt", async () => {
    // `--helper` is not a long match (longs never bundle-match);
    // `-hx` is bundle-shaped but the facade's info-only check is
    // bundle-blind (entry-based, glue needs a takesValue entry) — so
    // neither counts as `-h`.
    for (const cmd of [
      "gh -R cad0p/other pr merge --squash --helper",
      "gh -R cad0p/other pr merge --squash -hx",
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd);
      assert.equal(block, true, `expected block for: ${cmd}`);
      assert.equal(rule, "gh-repo-flag-before-subcommand", `for: ${cmd}`);
    }
  });

  it("BEHAVIOR DELTA: --help= EXEMPTS (infoOnly attached-value prefix match)", async () => {
    // `not.infoOnly` treats `--help=` as the attached-value form of
    // `--help` (startsWith `--help=`) → carve-out fires. The old
    // token-boundary regex blocked `--help=`. `--help=` is an
    // invalid gh invocation (errors, never mutates) — harmless; pin
    // the flip so it can't change silently.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R cad0p/other pr merge --squash --help=",
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("glue-aware: own-repo -Rcad0p/x RELEASES into the merge policy, foreign blocks (e2e)", async () => {
    // Table-derived glue (`R`): the walker keeps `-Rcad0p/…` as ONE
    // word and target resolution now sees it — own repo
    // basename-matches → the gate releases (the released command
    // LANDS on pr-merge-needs-closing-keywords — no --subject here,
    // so THAT policy blocks); foreign owner/repo → block by the
    // redirect.
    const own = await evaluateBash(
      makeFixtureDir(),
      "gh -Rcad0p/pi-steering-github pr merge --squash",
    );
    assert.equal(own.block, true, `expected block, got allow`);
    assert.equal(own.rule, "pr-merge-needs-closing-keywords");
    const foreign = await evaluateBash(
      makeFixtureDir(),
      "gh -Rcad0p/other pr merge --squash",
    );
    assert.equal(foreign.block, true, "expected block");
    assert.equal(
      foreign.rule,
      "gh-repo-flag-before-subcommand",
      `for: foreign glued`,
    );
  });

  it("subcommand-first: foreign --repo= blocks BY this rule (#39)", async () => {
    // The #39 class: the mutation sat after the subcommand, so the
    // pre-widening anchor never routed it — it escaped the policy
    // entirely. Now routed and blocked with the redirect reason.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh pr merge --repo=cad0p/other-repo --squash",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("fall-through: no -R anywhere reaches the closing-keywords rule", async () => {
    // `gh pr merge --squash` routes the foreign gate first — but
    // carries no repo flag, so the predicate releases and the NEXT
    // rule in the roster fires. Asserting a DIFFERENT rule name
    // proves the fall-through.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh pr merge --squash",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-merge-needs-closing-keywords");
  });

  it("masking: a foreign target masks the per-subcommand reasons until cd", async () => {
    // First-fires-wins: with a foreign target the agent sees ONLY the
    // redirect reason — even when the per-subcommand policy would
    // otherwise PASS (valid closing-keyword subject / keyword title).
    // The subcommand policies apply naturally after cd.
    const maskedMerge = await evaluateBash(
      makeFixtureDir(),
      'gh pr merge --repo=cad0p/other-repo --squash --subject "feat: x (closes #12)"',
    );
    assert.equal(maskedMerge.block, true, "expected block");
    assert.equal(maskedMerge.rule, "gh-repo-flag-before-subcommand");
    const maskedCreate = await evaluateBash(
      makeFixtureDir(),
      'gh pr create --repo=cad0p/other-repo --title "feat: x (closes #12)"',
    );
    assert.equal(maskedCreate.block, true, "expected block");
    assert.equal(maskedCreate.rule, "gh-repo-flag-before-subcommand");
  });
});

describe("github plugin — gh-repo-flag-before-subcommand ReasonFn (dynamic)", () => {
  /**
   * Walker-faithful words: whitespace separates outside quotes;
   * `"…"` groups stay ONE word (text keeps the quotes, value is the
   * resolved inner text).
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

  function ctxWith(command: string): Parameters<typeof foreignRepoReason>[0] {
    return mockContext({
      cwd: "/home/me/pi-steering-github",
      input: {
        tool: "bash",
        command,
        basename: "gh",
        args: splitWords(command).slice(1),
      },
      descriptors: { gh: GH_CLI_DESCRIPTOR },
    });
  }

  // Value-based rendering (#39): the reason names WHERE to cd, drawn
  // from the SAME facade call the verdict used — no flag-spelling
  // echo. Shared REQUIREMENT tail across every form.
  const requirementTail =
    "REQUIREMENT: run a foreign subagent maintainer loop until good,\n" +
    "then cd into the foreign repo and target it from there.";

  it("PR form: renders the effective target (value-based, #39)", () => {
    const reason = foreignRepoReason(
      ctxWith("gh -R cad0p/x pr create --title t"),
    );
    assert.equal(
      reason,
      "The PR you're targeting via cad0p/x belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("issue form: 'The issue …'", () => {
    const reason = foreignRepoReason(
      ctxWith("gh -R cad0p/x issue create --title t"),
    );
    assert.equal(
      reason,
      "The issue you're targeting via cad0p/x belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("subcommand-first position renders the target too (#39)", () => {
    // Same single-source-of-truth rendering regardless of where the
    // flag sits.
    const reason = foreignRepoReason(
      ctxWith("gh pr merge --repo=cad0p/other-repo --squash"),
    );
    assert.equal(
      reason,
      "The PR you're targeting via cad0p/other-repo belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("--repo=x/y glued long form renders the resolved value", () => {
    // The walker keeps `--repo=x/y` glued as ONE word; the facade
    // resolves the attached value.
    const reason = foreignRepoReason(
      ctxWith("gh --repo=cad0p/x issue create --title t"),
    );
    assert.equal(
      reason,
      "The issue you're targeting via cad0p/x belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("-Rx/y glued short form renders the resolved value", () => {
    // The walker keeps `-Rx/y` glued as ONE word; table-derived glue
    // decomposes it.
    const reason = foreignRepoReason(ctxWith("gh -Rcad0p/x issue edit 3"));
    assert.equal(
      reason,
      "The issue you're targeting via cad0p/x belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("cross-alias command renders the EFFECTIVE (last-wins) target", () => {
    // Rendering shares the facade's LAST-flag-wins scan: the
    // overridden early `-R cad0p/a` is NOT named — the redirect points
    // at what gh will actually target (`--repo cad0p/b`).
    const reason = foreignRepoReason(
      ctxWith("gh -R cad0p/a pr create --repo cad0p/b"),
    );
    assert.equal(
      reason,
      "The PR you're targeting via cad0p/b belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("unparsable target (empty attached last) renders the honest fallback", () => {
    // First-fires-wins display parity with the fail-closed verdict:
    // the trailing `--repo=` is the effective (empty) target —
    // no flag spelling is echoed, the fallback phrase says why.
    const reason = foreignRepoReason(
      ctxWith("gh -R cad0p/a pr create --repo="),
    );
    assert.equal(
      reason,
      "The PR you're targeting via an unresolvable -R/--repo belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("unparsable target (trailing bare -R, subcommand position) renders the fallback too", () => {
    const reason = foreignRepoReason(ctxWith("gh pr merge -R"));
    assert.equal(
      reason,
      "The PR you're targeting via an unresolvable -R/--repo belongs to a foreign repo.\n" +
        requirementTail,
    );
  });

  it("BEHAVIOR DELTA (consumption completeness): lookalike -m VALUE renders the leading target, not the hijack", () => {
    // FLIP from the old hijack-render pin: with `-m` consuming, the
    // `"-Rfoo/bar ref"` word is `-m`'s VALUE (hidden) — `effectiveRepoTarget`
    // resolves the leading own-repo target, and the reason names it (single
    // source of truth with the verdict). In the real gate this command
    // RELEASES (own-repo match), so the reason never surfaces; the direct
    // call here pins that display can no longer diverge into hijack text.
    const reason = foreignRepoReason(
      ctxWith('gh -Rcad0p/pi-steering-github pr edit 46 -m "-Rfoo/bar ref"'),
    );
    assert.equal(
      reason,
      "The PR you're targeting via cad0p/pi-steering-github belongs to a foreign repo.\n" +
        requirementTail,
    );
  });
});
