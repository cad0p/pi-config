// SPDX-License-Identifier: MIT
// Part of pi-steering-github.

/**
 * Full-pipeline integration tests for the github plugin.
 *
 * The plugin is exercised end-to-end through the REAL evaluator:
 * `defineConfig` + `loadHarness` with a recording host, exactly the
 * pipeline production uses.
 *
 * The `missingVaultBodyFile` predicate walks the real filesystem
 * (napkin-vault detection + repo-name check via the exec stub), so
 * these scenarios use REAL fixture dirs (mkdtemp) for vault /
 * non-vault paths. Vault body files carry frontmatter + H1 (like
 * real Goldmine notes) and must be uploaded through the strip-helper
 * substitution form `--body-file <(pi-steering-github strip
 * "<file>")` — the walker keeps the substitution's full inner text
 * as one arg word. Blocked commands surface the rule name through
 * the reason-tag convention (`[steering:<rule>@<plugin>]` — the
 * extraction regex accepts both tagged and untagged forms, and the
 * tag may be the first line (pre-preamble steering) or the second
 * line after the block-reason preamble landed, pi-steering #85).
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defineConfig } from "@cad0p/pi-steering";
import {
  createRecordingHost,
  loadHarness,
  mockExtensionContext,
} from "@cad0p/pi-steering/testing";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { BODY_STRIP } from "./helpers/body-strip.ts";
import { githubPlugin } from "./index.ts";

// The declarative when leaves (`not.infoOnly`, `requiresFlagValue`)
// that pr-merge-needs-closing-keywords composes are provided by
// `@cad0p/pi-steering-flags` (re-adopted dep — single source of truth),
// so the config lists githubPlugin alone.
const config = defineConfig({ plugins: [githubPlugin] });

/** Fixture dirs created per test, cleaned up after. */
const fixtures: string[] = [];

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "steering-fixture-"));
  fixtures.push(dir);
  return dir;
}

function makeVaultFixture(): string {
  const dir = makeFixtureDir();
  mkdirSync(join(dir, ".napkin"));
  return dir;
}

function makeNestedVaultFixture(): string {
  const dir = makeFixtureDir();
  mkdirSync(join(dir, ".obsidian", ".napkin"), { recursive: true });
  return dir;
}

/**
 * A napkin-vault fixture laid out like the real Goldmine convention:
 * `<vault>/open-source/github/<repo>/prs|issues/<date>-pr|issue<N>-<slug>.md`.
 * Body files carry frontmatter + H1 like real notes — the
 * strip-helper convention is what keeps GitHub bodies clean.
 */
interface VaultRepoFixture {
  vault: string;
  repo: string;
  prBodyFile: string;
  issueBodyFile: string;
}

function makeVaultRepoFixture(repo: string): VaultRepoFixture {
  const vault = makeVaultFixture();
  const prsDir = join(vault, "open-source", "github", repo, "prs");
  const issuesDir = join(vault, "open-source", "github", repo, "issues");
  mkdirSync(prsDir, { recursive: true });
  mkdirSync(issuesDir, { recursive: true });
  const prBodyFile = join(prsDir, `2026-08-14-pr1-${repo}-test.md`);
  writeFileSync(
    prBodyFile,
    "---\ntags: [test]\n---\n# Title\n\nCloses #12\n\nBody.\n",
  );
  const issueBodyFile = join(issuesDir, `2026-08-14-issue1-${repo}-test.md`);
  writeFileSync(
    issueBodyFile,
    "---\ntags: [test]\n---\n# Title\n\nIssue body text.\n",
  );
  return { vault, repo, prBodyFile, issueBodyFile };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The pinned perl substitution form the vault body-file rules require. */
function stripSubstitution(file: string): string {
  return `<(perl -0777 -pe '${BODY_STRIP}' "${file}")`;
}

/**
 * JS mirror of the pinned perl program (test stub only — the real
 * behavior is pinned by body-strip.test.ts spawning perl).
 */
function stripFrontmatter(content: string): string {
  return content.replace(
    /^(?:\uFEFF)?---\r?\n(?:.*?\r?\n)?(?:---|\.\.\.)\r?\n(?:\r?\n)*(?:[ \t]*\r?\n)*(?:#(?![\S])[^\n]*(?:\r?\n)?(?:[ \t]*\r?\n)*)?/,
    "",
  );
}

/**
 * Build a host whose `exec` stub answers git queries as if the cwd is
 * a github clone on a feature branch, and answers the keyword
 * rule's pinned-perl call with the frontmatter-stripped file content
 * (exactly what gh would upload).
 */
function hostWithRemote(
  remoteUrl: string,
): ReturnType<typeof createRecordingHost> {
  return createRecordingHost({
    exec: (cmd, args) => {
      const sub = args[0];
      if (cmd === "git" && sub === "branch" && args[1] === "--show-current") {
        return Promise.resolve({
          stdout: "main",
          stderr: "",
          code: 0,
          killed: false,
        } satisfies ExecResult);
      }
      if (
        cmd === "git" &&
        sub === "config" &&
        args[1] === "--get" &&
        args[2] === "remote.origin.url"
      ) {
        return Promise.resolve({
          stdout: remoteUrl,
          stderr: "",
          code: 0,
          killed: false,
        } satisfies ExecResult);
      }
      if (cmd === "perl" && args[0] === "-0777" && args[1] === "-pe") {
        // The keyword check runs the pinned one-liner: answer with
        // the stripped file content (canonical = what gh uploads).
        const file = args[3];
        if (file === undefined) {
          return Promise.resolve({
            stdout: "",
            stderr: "perl: no file",
            code: 1,
            killed: false,
          } satisfies ExecResult);
        }
        let stripped = "";
        try {
          stripped = stripFrontmatter(readFileSync(file, "utf8"));
        } catch {
          return Promise.resolve({
            stdout: "",
            stderr: "no such file",
            code: 1,
            killed: false,
          } satisfies ExecResult);
        }
        return Promise.resolve({
          stdout: stripped,
          stderr: "",
          code: 0,
          killed: false,
        } satisfies ExecResult);
      }
      return Promise.resolve({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      } satisfies ExecResult);
    },
  });
}

function hostOnMainGithub(): ReturnType<typeof createRecordingHost> {
  return hostWithRemote("https://github.com/cad0p/Goldmine.git");
}

/**
 * Evaluate a bash command at a given cwd. Uses a fresh host + ctx per
 * call so exec state doesn't leak across assertions. The cwd must be
 * a REAL directory — the vault predicate walks the filesystem.
 * Returns the raw block reason too (for the dynamic byte-diff
 * diagnostic pins, #43).
 */
async function evaluateBash(
  cwd: string,
  command: string,
  host: ReturnType<typeof createRecordingHost> = hostOnMainGithub(),
): Promise<{
  block: boolean;
  rule: string | null | undefined;
  reason: string;
}> {
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
    return { block: false, rule: null, reason: "" };
  }
  const raw = result.reason ?? "";
  const reason = typeof raw === "string" ? raw : String(raw);
  // The tag is line 1 on pre-preamble steering (<0.2.0-20260901.0)
  // and line 2 once the block-reason preamble landed (pi-steering
  // #85: `…not executed; blocked by a steering rule:\n\n[steering:
  // <rule>@<source>] …`). Match at a line start for both formats.
  const match = reason.match(/(?:^|\n)\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
  return { block: true, rule: match ? match[1] : null, reason };
}

describe("github plugin — shape", () => {
  it("registers strict rules in roster order with the vault predicate", () => {
    const plugin = config.plugins?.find((p) => p.name === "github");
    assert.ok(plugin, "github plugin should be registered");
    // Body-file rule first — first-match-wins routing.
    assert.deepEqual(
      plugin?.rules?.map((r) => r.name),
      [
        "gh-repo-flag-before-subcommand",
        "pr-body-from-vault-file",
        "pr-create-needs-issue-link",
        "pr-merge-needs-closing-keywords",
        "issue-body-from-vault-file",
        "gh-repo-create-needs-seed",
      ],
    );
    for (const r of plugin?.rules ?? []) {
      assert.equal(r.tool, "bash");
      if (r.tool === "bash") {
        assert.equal(r.command, "gh");
        assert.ok(!("field" in r), `${r.name} must not carry field:`);
        assert.ok(!("pattern" in r), `${r.name} must not carry pattern:`);
      }
      assert.ok(!("noOverride" in r), `${r.name} must be strict`);
    }
    assert.equal(typeof plugin?.predicates?.missingVaultBodyFile, "function");
  });
});

describe("github plugin — PR rules (issue-link + vault body-file policy)", () => {
  const repo = "fixture-repo";
  const remote = `https://github.com/cad0p/${repo}.git`;
  const host = hostWithRemote(remote);

  // ---- pr-body-from-vault-file (runs FIRST — first-match-wins) ----

  it("allows pr create with keyword title + stripped vault prs/ body file (frontmatter + H1)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows pr create with a stripped body file in a nested-layout vault (.obsidian/.napkin/)", async () => {
    const vault = makeNestedVaultFixture();
    const prsDir = join(vault, "open-source", "github", repo, "prs");
    mkdirSync(prsDir, { recursive: true });
    const bodyFile = join(prsDir, "2026-08-14-pr1-nested.md");
    writeFileSync(bodyFile, "Closes #12\n");
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(bodyFile)}`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows pr edit with a stripped vault prs/ body file", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr edit 46 --body-file ${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows issue create with a stripped vault issues/ body file", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh issue create --title "tracking" --body-file ${stripSubstitution(fx.issueBodyFile)}`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows issue edit with a stripped vault issues/ body file", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh issue edit 29 --body-file ${stripSubstitution(fx.issueBodyFile)}`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("#44: label/title edits pass without the substitution (no body write)", async () => {
    // The pi#8845 live over-block: `gh issue edit 8845 --add-label
    // bug` only touches labels — the vault-body policy applies to an
    // edit solely when a body-affecting flag is present.
    for (const cmd of [
      "gh issue edit 8845 --add-label bug",
      'gh pr edit 46 --title "feat: x (closes #12)"',
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (block by ${rule})`,
      );
    }
  });

  it("#44: body-carrying edits stay gated (inline --body / direct path)", async () => {
    const inline = await evaluateBash(
      makeFixtureDir(),
      `gh issue edit 29 --body "plain text"`,
      host,
    );
    assert.equal(inline.block, true, "expected block");
    assert.equal(inline.rule, "issue-body-from-vault-file");
    const fx = makeVaultRepoFixture(repo);
    const direct = await evaluateBash(
      makeFixtureDir(),
      `gh pr edit 46 --body-file "${fx.prBodyFile}"`,
      host,
    );
    assert.equal(direct.block, true, "expected block");
    assert.equal(direct.rule, "pr-body-from-vault-file");
  });

  it("allows the glued --body-file=<(…) form (walker-split into two words)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file=${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("blocks pr create with inline --body (vault body file required)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body "Closes #12"`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("blocks a DIRECT vault path (only the strip-helper substitution is accepted)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file "${fx.prBodyFile}"`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("blocks issue create with a DIRECT vault path", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh issue create --title "tracking" --body-file "${fx.issueBodyFile}"`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "issue-body-from-vault-file");
  });

  it("blocks pr create with a non-strip inner command (<(cat …))", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file <(cat "${fx.prBodyFile}")`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("blocks pr edit with a mutated strip program and reports the byte-exact divergence (#43)", async () => {
    // The pi#8845 incident: a 2-char swap (*)? → ?)*) at byte 129 of
    // 135 — the static reason could not show it; the dynamic reason
    // pins the byte offset and the divergent core spans.
    const fx = makeVaultRepoFixture(repo);
    const mutatedProgram =
      BODY_STRIP.slice(0, 129) + "?)*" + BODY_STRIP.slice(132);
    const { block, rule, reason } = await evaluateBash(
      makeFixtureDir(),
      `gh pr edit 46 --body-file <(perl -0777 -pe '${mutatedProgram}' "${fx.prBodyFile}")`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
    assert.ok(reason.includes("at byte 129"), `reason: ${reason}`);
    assert.ok(reason.includes("- expected: *)?"), `reason: ${reason}`);
    assert.ok(reason.includes("+ got:      ?)*"), `reason: ${reason}`);
  });

  it("blocks pr edit with a cat inner command and reports the full-line got (#43)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule, reason } = await evaluateBash(
      makeFixtureDir(),
      `gh pr edit 46 --body-file <(cat "${fx.prBodyFile}")`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
    assert.ok(reason.includes("+ got:      cat "), `reason: ${reason}`);
    assert.ok(
      reason.includes(
        "substitution inner command deviates from the pinned strip:",
      ),
      `reason: ${reason}`,
    );
  });

  it("byte-exact substitution outside any vault blocks with mirror + trace + recipe (#50)", async () => {
    // Form byte-perfect → ok stage → the vault-path check is what
    // blocks. The reason now mirrors the received path, traces the
    // walk to the failing vault stage, and ends with the recipe —
    // with bare VAULT/REPO slots (both undiscovered past the stop).
    const outside = makeFixtureDir();
    const bodyFile = join(outside, "body.md");
    writeFileSync(bodyFile, "Closes #12\n");
    const { block, rule, reason } = await evaluateBash(
      makeFixtureDir(),
      `gh pr edit 46 --body-file ${stripSubstitution(bodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
    assert.ok(
      reason.includes(`--body-file path as received: ${bodyFile}`),
      `reason: ${reason}`,
    );
    assert.ok(reason.includes("exists: yes"), `reason: ${reason}`);
    assert.ok(
      reason.includes("vault: none — not inside a napkin vault, fail-closed"),
      `reason: ${reason}`,
    );
    assert.ok(reason.includes("VAULT/**/REPO/prs/"), `reason: ${reason}`);
    assert.ok(
      !reason.includes("substitution program diverges"),
      `reason must not take the diff branch for byte-exact forms: ${reason}`,
    );
    assert.ok(
      !reason.includes("<vault>") && !reason.includes("<repo>"),
      `reason must carry no angle-bracket placeholders: ${reason}`,
    );
  });

  it("blocks pr create with a substitution pointing OUTSIDE any vault", async () => {
    // Form OK, but the path must resolve inside a napkin vault — a
    // non-vault path is missing (restored validation, #12).
    const outside = makeFixtureDir();
    const bodyFile = join(outside, "body.md");
    writeFileSync(bodyFile, "Closes #12\n");
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(bodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("blocks pr create with a substitution pointing at a wrong-section file", async () => {
    // issues/ file carrying a keyword: the vault-relative path must
    // contain <repo>/<section>/ (restored validation, #12).
    const fx = makeVaultRepoFixture(repo);
    const kwFile = join(dirname(fx.issueBodyFile), "2026-08-14-issue2-kw.md");
    writeFileSync(kwFile, "Closes #12\n");
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(kwFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("blocks pr create with a substitution pointing at another repo's file", async () => {
    // File lives under open-source/github/other-repo/prs/ — the
    // vault-relative path must contain the COMMAND repo's name
    // (origin basename, cwd-folder fallback) (restored, #12).
    const fx = makeVaultRepoFixture("other-repo");
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it('blocks a substitution under a dynamic cwd (cd "$X") — fail-closed', async () => {
    // The path resolves against the command's cwd; a walker-unknown
    // cwd is unverifiable → missing (restored validation, #12).
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `cd "$X" && gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("blocks pr edit with inline --body", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr edit 46 --body "Closes #12"`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("blocks issue create with inline --body", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh issue create --title "tracking" --body "notes"`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "issue-body-from-vault-file");
  });

  it("blocks issue create with a prs/ file via substitution (wrong section)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh issue create --title "tracking" --body-file ${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "issue-body-from-vault-file");
  });

  // ---- pr-create-needs-issue-link ----

  it("blocks pr create when the stripped vault body lacks the closing keyword", async () => {
    const fx = makeVaultRepoFixture(repo);
    const badFile = join(dirname(fx.prBodyFile), "2026-08-14-pr2-nokw.md");
    writeFileSync(badFile, "## What\n\nNo keywords here.\n");
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(badFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-create-needs-issue-link");
  });

  it("blocks pr create when the closing keyword ONLY appears in frontmatter", async () => {
    const fx = makeVaultRepoFixture(repo);
    const kwFile = join(dirname(fx.prBodyFile), "2026-08-14-pr2-fmkw.md");
    writeFileSync(
      kwFile,
      "---\ncloses: #12\n---\n# Title\n\nNo keyword here.\n",
    );
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(kwFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-create-needs-issue-link");
  });

  it("blocks pr create when the title lacks the keyword (body file has it)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x" --body-file ${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-create-needs-issue-link");
  });

  it("blocks pr create with a bare (#12) title mention (mention != close)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (#12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-create-needs-issue-link");
  });

  it("allows multi-issue keyword-per-issue in the vault body file", async () => {
    const fx = makeVaultRepoFixture(repo);
    const multiFile = join(dirname(fx.prBodyFile), "2026-08-14-pr3-multi.md");
    writeFileSync(multiFile, "Closes #12, closes #15\n");
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "fix: multi (closes #12)" --body-file ${stripSubstitution(multiFile)}`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  // ---- pr-merge-needs-closing-keywords ----

  it("allows the isInfoOnly default flags and GitHub's additive -h", async () => {
    for (const cmd of [
      `gh pr merge --help`,
      `gh pr merge -h`,
      `gh pr merge --version`,
      `gh pr merge --squash --help`,
      `gh pr merge --help --squash`,
      // Flag-first shapes (#41): the carve-out leaves are argv-token
      // based, so they fire regardless of leading-flag position —
      // routed by the gate (released: no -R) or straight to this
      // rule via its widened anchor, either way a clean allow.
      `gh -v pr merge --help`,
      `gh --hostname h pr merge --squash -h`,
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (got block by ${rule})`,
      );
    }
  });

  it("allows attached info flags and keeps -v gated", async () => {
    for (const cmd of [
      `gh pr merge --help=value`,
      `gh pr merge --version=1`,
      `gh pr merge --squash -h=value`,
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (got block by ${rule})`,
      );
    }
    for (const cmd of [`gh pr merge -v`, `gh pr merge -v=value`]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(block, true, `expected block for: ${cmd}`);
      assert.equal(rule, "pr-merge-needs-closing-keywords", `for: ${cmd}`);
    }
  });

  it("allows pr merge --help with a positional PR number / after --subject value", async () => {
    for (const cmd of [
      `gh pr merge 123 --help`,
      `gh pr merge 123 -h`,
      `gh pr merge --squash --subject "feat: x (closes #12)" -h`,
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (got block by ${rule})`,
      );
    }
  });

  it("blocks bare pr merge (no args — real merge of current-branch PR)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-merge-needs-closing-keywords");
  });

  it("blocks pr merge --squash (no --subject, no closing keyword)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-merge-needs-closing-keywords");
  });

  it("allows pr merge with keyword in BOTH --subject and --body", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash --subject "feat: x (closes #12)" --body "Closes #12"`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("blocks pr merge without --subject (commit-subject channel required)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash --body "Closes #12"`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-merge-needs-closing-keywords");
  });

  it("allows pr merge with --subject only (commit subject closes; body optional)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash --subject "feat: x (closes #12)"`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows -t/-b short flags with a PR number argument", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge 123 -s -t "fix: y (closes #7)" -b "Closes #7"`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows --subject= glued forms, colons and case variants", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --auto --squash --subject="feat: x (RESOLVES #4)"`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows multiple issues with keyword per issue in the merge subject", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash --subject "fix: x (closes #12, closes #15)"`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("BEHAVIOR DELTA (#23-a): attached short form -t=<ref> now allowed", async () => {
    // pflag-correct flip: `-t=<value>` is valid attached-value syntax.
    // The old hand-rolled scan only knew bare `-t` and the `--subject=`
    // prefix, so `-t=` was invisible → subject null → BLOCK. The
    // requiresFlagValue predicate matches the `${flag}=` prefix per
    // alias → value found → ALLOW.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash -t="feat: x (closes #12)"`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("blocks pr merge with a bare mention only", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash --subject "feat: x (see #12)" --body "see #12"`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-merge-needs-closing-keywords");
  });

  it("blocks help/version tokens INSIDE quoted subject values", async () => {
    // The helper is token-level on walker argv: a help/version token
    // inside a VALUE is still a real merge subject and must block.
    for (const cmd of [
      `gh pr merge --squash --subject "see --help"`,
      `gh pr merge --squash --subject="see --help"`,
      `gh pr merge --squash --subject "see --version"`,
      `gh pr merge --squash --subject="see --version"`,
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(block, true, `expected block for: ${cmd}`);
      assert.equal(rule, "pr-merge-needs-closing-keywords", `for: ${cmd}`);
    }
  });

  it("pins exact quoted info tokens as an accepted quote-removal limitation", async () => {
    // After the walker removes quotes, an exact quoted value is
    // indistinguishable from a bare info flag, so the helper allows it.
    for (const cmd of [
      `gh pr merge --squash --subject "--help"`,
      `gh pr merge --squash --subject "--version"`,
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(block, false, `expected accepted limitation for: ${cmd}`);
      assert.notEqual(rule, "pr-merge-needs-closing-keywords", `for: ${cmd}`);
    }
  });

  it("honors gh's last-flag-wins precedence for repeated --subject/-t", async () => {
    // Cobra semantics: the LAST flag occurrence wins. A valid later
    // `--subject` overrides an earlier bare `-t`…
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash -t "see #13" --subject "closes #12"`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
    // …and a bare `-t` as the LAST flag with no ref still blocks.
    const { block: blockLast } = await evaluateBash(
      makeFixtureDir(),
      `gh pr merge --squash --subject "closes #12" -t "see #13"`,
      host,
    );
    assert.equal(blockLast, true, "expected block");
  });

  it("does not gate other gh subcommands (view / branch / close)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh pr view 12 --json body,title`,
      host,
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
    const { block: blockClose } = await evaluateBash(
      makeFixtureDir(),
      `gh issue close 12`,
      host,
    );
    assert.equal(blockClose, false, `expected allow, got block by ${rule}`);
  });

  it("command-first routing boundaries (structural — no regex surface)", async () => {
    // Non-gated subcommands stay ungated EVEN with a foreign -R: the
    // gate's subcommand set has no [pr, view] / [issue, list] member.
    for (const cmd of [
      "gh -R cad0p/other pr view 12",
      "gh -R cad0p/other issue list",
      "gh -R cad0p/other issue close 3",
      // Typo subcommands never match a two-word sequence exactly.
      "gh pr created --title t",
      "gh pr merged",
      // Basename-exact routing: echo prefixes never reach gh rules.
      "echo gh pr merge --squash",
      "echo gh repo create x",
      // Bare introspection carries no subcommand (extraction unknown
      // → onUnknown allow on every rule).
      "gh --help",
      "gh --version",
    ]) {
      const { block, rule } = await evaluateBash(makeFixtureDir(), cmd, host);
      assert.equal(
        block,
        false,
        `expected allow for: ${cmd} (block by ${rule})`,
      );
    }
    // Case-exact routing: `GH` is a different basename (runtime
    // command-not-found) — the old /i anchors routed it, command:
    // does not. Accepted delta, pinned.
    const upper = await evaluateBash(
      makeFixtureDir(),
      "GH pr merge --squash",
      host,
    );
    assert.equal(upper.block, false, `expected allow, got block`);
  });
});

describe("github plugin — gh-repo-create-needs-seed (repo create must seed)", () => {
  it("blocks bare gh repo create with the rule name in the reason tag", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh repo create cad0p/pi-config",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-create-needs-seed");
  });

  it("blocks gh repo create with only non-seed flags (--source . --push)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh repo create cad0p/pi-config --source . --push",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-create-needs-seed");
  });

  it("blocks the gh repo new alias (new = create)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh repo new cad0p/pi-config",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-create-needs-seed");
  });

  it("allows gh repo create with --add-readme", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh repo create cad0p/pi-config --add-readme",
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("allows gh repo create with --license mit", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh repo create cad0p/pi-config --license mit",
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("#41: multi-pair flag-first bare create blocks BY the seed rule", async () => {
    // Pre-widening this escaped the empty-repo gate entirely (no
    // anchor matched between gh and repo). The redirect router still
    // EXCLUDES repo create (nothing to cd into) — the seed rule is
    // what catches it now.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh --hostname h repo create foo",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-create-needs-seed");
    const onePair = await evaluateBash(
      makeFixtureDir(),
      "gh -v repo create foo",
    );
    assert.equal(onePair.block, true, "expected block");
    assert.equal(onePair.rule, "gh-repo-create-needs-seed");
  });

  it("#41: seeded flag-first create passes the gate cleanly", async () => {
    // Same shape, seed flag present → the whole-command exemption
    // scan releases it; nothing else matches → clean allow.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh --hostname h repo create foo --add-readme",
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("#41: -R x/y repo create escapes the REDIRECT but not the seed gate", async () => {
    // Orthogonality pin: REPO_FLAG_ANCHOR deliberately excludes repo
    // create (foreign gate — nothing to cd into yet), but that
    // exclusion is NOT a policy bypass: the seed rule's widened
    // anchor catches the bare create.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R x/y repo create foo",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-create-needs-seed");
  });
});

describe("github plugin — gh-repo-flag-before-subcommand (-R foreign-target gate)", () => {
  // The gate is declarative over two leaves: `not.infoOnly({
  // extraFlags: ["-h"] })` + this package's `foreignRepoTarget`
  // predicate. The default evaluateBash host answers the cwd repo as
  // `cad0p/Goldmine` (origin URL), so `Goldmine`-basenamed targets
  // are the fork→upstream flow and anything else is FOREIGN.

  it("blocks a foreign -R target with the redirect reason tag", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R cad0p/other-repo pr create --title t",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("blocks a foreign --repo=x/y glued long form too", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh --repo=cad0p/other-repo issue create --title t",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("glue-aware: own-repo -Rcad0p/x short form releases INTO THE POLICY STACK (flags#11 + #41)", async () => {
    // The walker keeps `-Rcad0p/Goldmine` as ONE word; glue-aware
    // target resolution (`{ gluedShorts: ["R"] }`, upstream
    // cad0p/pi-steering-flags#11) sees it → basename equality → the
    // gate releases. #41 widening: the released command LANDS on the
    // vault-body policy (create without a vault body file — blocked
    // there, NOT a clean allow; pre-widening this was a subject/body
    // policy bypass).
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -Rcad0p/Goldmine pr create --title t",
    );
    assert.equal(block, true, `expected block, got allow`);
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("glue-aware: foreign -Rcad0p/x short form blocks", async () => {
    // Glue awareness cuts both ways: a FOREIGN owner/repo in glued
    // short form resolves instead of fail-closing on null → basename
    // mismatch → block.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -Rcad0p/other-repo issue create --title t",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("fork→upstream flow passes the gate and lands on the body policy (#41)", async () => {
    // `gh -R upstream/Goldmine pr create` from inside the
    // `cad0p/Goldmine` clone — the most common legit `-R` use. The
    // basename-equality release still stands; post-widening the
    // command lands on pr-body-from-vault-file (no vault body file
    // here), which is exactly the bypass #41 closes.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R upstream/Goldmine pr create --title t",
    );
    assert.equal(block, true, `expected block, got allow`);
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("slashless -R upstream releases the gate and lands on the body policy (#41)", async () => {
    // Remote-name form (no `/`) → not a foreign redirect → release;
    // post-widening the create lands on the vault-body rule.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R upstream pr create --title t",
    );
    assert.equal(block, true, `expected block, got allow`);
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("GATE-SCOPED carve-out (#36/#41): bare --version exempts the REDIRECT but not the stack", async () => {
    // `not.infoOnly` exempts THIS gate only; the per-subcommand rules
    // never had an infoOnly exemption for create, so post-widening
    // the command lands on the vault-body policy and blocks. Same
    // outcome class as its subcommand-first twin (`gh pr create
    // --version` always matched PR_BODY_ANCHOR). Invalid invocation
    // either way — nothing real can happen.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R cad0p/other-repo pr create --version",
    );
    assert.equal(block, true, `expected block, got allow`);
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("GATE-SCOPED carve-out (#36/#41): attached --version=1 lands on the body policy too", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R cad0p/other-repo pr create --version=1",
    );
    assert.equal(block, true, `expected block, got allow`);
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("keeps -v gated (deliberately absent from the infoOnly set)", async () => {
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -R cad0p/other-repo pr create -v",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("BEHAVIOR DELTA (#39): subcommand-first foreign merge now blocks (was released)", async () => {
    // The #39 class: `--repo=` after the subcommand used to escape
    // the gate entirely (flag-first-only anchor). Now routed and
    // blocked with the redirect.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh pr merge --repo=cad0p/other-repo --squash",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("#41: TWO leading flag pairs route — a foreign target blocks BY this rule", async () => {
    // Pre-#41 this shape escaped the router entirely (one-pair cap):
    // `--hostname h -R …` is two flag(+value) pairs. The redirect
    // masks the closing-keywords allowance as usual (first-fires-wins).
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      'gh --hostname h -R cad0p/other-repo pr merge --subject "feat: x (closes #12)"',
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });

  it("#41: two leading flag pairs with an OWN-repo target RELEASE onto the merge policy", async () => {
    // Fixture cwd repo basename is cad0p/Goldmine (default host
    // remote). Same shape as the foreign twin below — routed by the
    // widened router anchor, released by the predicate on the
    // basename match, and post-widening the released command LANDS on
    // pr-merge-needs-closing-keywords (no --subject → blocked there,
    // NOT a clean allow; pre-widening this was a subject-policy
    // bypass dating back to #39's one-pair class).
    const own = await evaluateBash(
      makeFixtureDir(),
      "gh --hostname h -R cad0p/Goldmine pr merge --squash",
    );
    assert.equal(own.block, true, `expected block, got allow`);
    assert.equal(own.rule, "pr-merge-needs-closing-keywords");
    const foreign = await evaluateBash(
      makeFixtureDir(),
      "gh --hostname h -R cad0p/other-repo pr merge --squash",
    );
    assert.equal(foreign.block, true, "expected block");
    assert.equal(foreign.rule, "gh-repo-flag-before-subcommand");
  });

  it("#41: two leading flag pairs + own repo + VALID subject passes the full stack", async () => {
    // The complement of the pin above: the gate releases byte-for-byte
    // AND the landed policy is satisfied → clean allow. Proves the
    // release is real end-to-end (a fail-closed regression would block
    // by gh-repo-flag-before-subcommand instead).
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      'gh --hostname h -R cad0p/Goldmine pr merge --squash --subject "fix: x (closes #12)"',
    );
    assert.equal(block, false, `expected allow, got block by ${rule}`);
  });

  it("#41: multi-flag command without -R anywhere falls through to closing-keywords", async () => {
    // THE #41 acceptance example: routed by the unbounded anchor;
    // absent repo flag → predicate releases; the widened
    // PR_MERGE_ANCHOR catches the released form and the missing
    // closing-keyword subject blocks. Pre-widening this was a clean
    // allow — the exact bypass the widening exists to close.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh -v --hostname h pr merge --squash",
    );
    assert.equal(block, true, `expected block, got allow`);
    assert.equal(rule, "pr-merge-needs-closing-keywords");
  });

  it("#41: multi-flag create lands on the vault-body rule", async () => {
    // Leading flags + inline body: pr-body-from-vault-file matches
    // the flag-first shape now and blocks before the issue-link rule
    // even evaluates (roster order).
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      'gh --hostname h pr create --title "Closes #1" --body "inline"',
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-body-from-vault-file");
  });

  it("fall-through: no-flag mutations reach the per-subcommand rules", async () => {
    // `gh pr merge --squash` ROUTES the foreign gate first since #39
    // (zero leading flags) but carries NO repo flag → predicate
    // releases → the closing-keywords rule fires. Asserting the OTHER
    // rule's name proves release-fall-through end-to-end.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      "gh pr merge --squash",
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "pr-merge-needs-closing-keywords");
  });

  it("masking: a foreign target masks the closing-keywords allowance until cd", async () => {
    // The --subject carries a VALID closing keyword — the merge rule
    // alone would allow this command — but the foreign redirect fires
    // first (first-fires-wins) and masks it. Per-subcommand policies
    // apply naturally after cd into the foreign repo.
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      'gh pr merge --repo=cad0p/other-repo --squash --subject "feat: x (closes #12)"',
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "gh-repo-flag-before-subcommand");
  });
});

describe("github plugin — body-file mirror + trace reasons (#50)", () => {
  const repo = "fixture-repo";
  const remote = `https://github.com/cad0p/${repo}.git`;
  const host = hostWithRemote(remote);

  it("#48 regression: `<`-prefixed relative path mirrors the `<` (issue)", async () => {
    // Session-exact typo shape: the shell input-redirection `<` typed
    // inside the substitution instead of a bare path argument. The
    // block is a correct fail-closed verdict — and the reason now
    // shows the `<` via the path-token mirror (before: bare STATIC).
    const typoPath =
      "<../Goldmine/personal/github/pcad.it-infra/issues/2026-09-01-issue188-test.md";
    const { block, rule, reason } = await evaluateBash(
      makeFixtureDir(),
      `gh issue create --title "tracking" --body-file <(perl -0777 -pe '${BODY_STRIP}' "${typoPath}")`,
      host,
    );
    assert.equal(block, true, "expected block (verdict unchanged)");
    assert.equal(rule, "issue-body-from-vault-file");
    assert.ok(
      reason.includes(`--body-file path as received: ${typoPath}`),
      `reason must mirror the typo: ${reason}`,
    );
    assert.ok(reason.includes("exists: no"), `reason: ${reason}`);
  });

  it("#49 regression: `<`-prefixed absolute path mirrors the `<` (pr)", async () => {
    const fx = makeVaultRepoFixture(repo);
    const typoPath = `<${fx.prBodyFile}`;
    const { block, rule, reason } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file <(perl -0777 -pe '${BODY_STRIP}' "${typoPath}")`,
      host,
    );
    assert.equal(block, true, "expected block (verdict unchanged)");
    assert.equal(rule, "pr-body-from-vault-file");
    assert.ok(
      reason.includes(`--body-file path as received: ${typoPath}`),
      `reason must mirror the typo: ${reason}`,
    );
    assert.ok(reason.includes("exists: no"), `reason: ${reason}`);
  });

  it("direct vault path blocks with the verbatim-upload mirror", async () => {
    const fx = makeVaultRepoFixture(repo);
    const { block, rule, reason } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file "${fx.prBodyFile}"`,
      host,
    );
    assert.equal(block, true, "expected block (verdict unchanged)");
    assert.equal(rule, "pr-body-from-vault-file");
    assert.ok(
      reason.includes(`--body-file path as received: ${fx.prBodyFile}`),
      `reason: ${reason}`,
    );
    assert.ok(
      reason.includes("direct paths upload verbatim"),
      `reason: ${reason}`,
    );
  });

  it("misplaced vault file blocks with filled vault/repo slots", async () => {
    // Well-formed but misplaced: an issues/ file for a pr create.
    // The trace walks to the placement stage with both slots filled.
    const fx = makeVaultRepoFixture(repo);
    const { block, rule, reason } = await evaluateBash(
      makeFixtureDir(),
      `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.issueBodyFile)}`,
      host,
    );
    assert.equal(block, true, "expected block (verdict unchanged)");
    assert.equal(rule, "pr-body-from-vault-file");
    assert.ok(reason.includes(`vault root: ${fx.vault}`), `reason: ${reason}`);
    assert.ok(
      reason.includes(`repo (command cwd): ${repo}`),
      `reason: ${reason}`,
    );
    assert.ok(
      reason.includes(`is not under ${repo}/prs/ — fail-closed`),
      `reason: ${reason}`,
    );
    assert.ok(
      reason.includes(`${fx.vault}/**/${repo}/prs/`),
      `reason: ${reason}`,
    );
  });

  it("verdict matrix unchanged: typo shapes stay blocked, valid stays allowed", async () => {
    // Fail-closed preservation pin for #50: only reasons change.
    const fx = makeVaultRepoFixture(repo);
    const cases: { cmd: string; block: boolean; rule: string | null }[] = [
      {
        cmd: `gh pr create --title "feat: x (closes #12)" --body-file ${stripSubstitution(fx.prBodyFile)}`,
        block: false,
        rule: null,
      },
      {
        cmd: `gh issue create --title "tracking" --body-file ${stripSubstitution(fx.issueBodyFile)}`,
        block: false,
        rule: null,
      },
      {
        cmd: `gh pr create --title "feat: x (closes #12)" --body-file <(perl -0777 -pe '${BODY_STRIP}' "<${fx.prBodyFile}")`,
        block: true,
        rule: "pr-body-from-vault-file",
      },
      {
        cmd: `gh issue create --title "tracking" --body-file <(perl -0777 -pe '${BODY_STRIP}' "<../Goldmine/note.md")`,
        block: true,
        rule: "issue-body-from-vault-file",
      },
      {
        cmd: `gh pr create --title "feat: x (closes #12)" --body-file "${fx.prBodyFile}"`,
        block: true,
        rule: "pr-body-from-vault-file",
      },
      {
        cmd: `gh pr create --title "feat: x (closes #12)" --body "Closes #12"`,
        block: true,
        rule: "pr-body-from-vault-file",
      },
    ];
    for (const c of cases) {
      const res = await evaluateBash(makeFixtureDir(), c.cmd, host);
      assert.equal(res.block, c.block, `verdict flipped for: ${c.cmd}`);
      if (c.block) assert.equal(res.rule, c.rule, `for: ${c.cmd}`);
    }
  });
});

describe("github plugin — body-file tilde expansion (shell-exact ~/…)", () => {
  const repo = "fixture-repo";
  const remote = `https://github.com/cad0p/${repo}.git`;
  const host = hostWithRemote(remote);

  /**
   * A vault fixture rooted under the REAL home dir: the real
   * harness seeds the tracked env from `process.env.HOME`, so a
   * bare `~/…` path in the typed command expands to this vault
   * exactly like the Goldmine layout in production. Removed with
   * the other fixtures in `afterEach`.
   */
  function makeHomeVaultRepoFixture(): VaultRepoFixture {
    const homeBase = mkdtempSync(join(homedir(), "steering-fixture-"));
    fixtures.push(homeBase);
    const vault = join(homeBase, "Goldmine");
    const prsDir = join(vault, "open-source", "github", repo, "prs");
    const issuesDir = join(vault, "open-source", "github", repo, "issues");
    mkdirSync(prsDir, { recursive: true });
    mkdirSync(issuesDir, { recursive: true });
    mkdirSync(join(vault, ".napkin"), { recursive: true });
    const prBodyFile = join(prsDir, `2026-08-14-pr1-${repo}-test.md`);
    writeFileSync(
      prBodyFile,
      "---\ntags: [test]\n---\n# Title\n\nCloses #12\n\nBody.\n",
    );
    const issueBodyFile = join(issuesDir, `2026-08-14-issue1-${repo}-test.md`);
    writeFileSync(
      issueBodyFile,
      "---\ntags: [test]\n---\n# Title\n\nIssue body text.\n",
    );
    return { vault, repo, prBodyFile, issueBodyFile };
  }

  it("bare ~/… vault path allows (the typed command works)", async () => {
    const fx = makeHomeVaultRepoFixture();
    const tildePath = `~${fx.issueBodyFile.slice(homedir().length)}`;
    assert.ok(tildePath.startsWith("~/"), tildePath);
    const { block, rule } = await evaluateBash(
      makeFixtureDir(),
      `gh issue create --title "tracking" --body-file <(perl -0777 -pe '${BODY_STRIP}' ${tildePath})`,
      host,
    );
    assert.equal(block, false, "bare ~/… must allow");
    assert.equal(rule, null);
  });

  it('quoted "~/…" blocks with the literal path in the trace', async () => {
    // Bash-exact: quotes suppress the expansion — the literal
    // `~/…` joins onto the cwd and fails exists.
    const fx = makeHomeVaultRepoFixture();
    const tildePath = `~${fx.issueBodyFile.slice(homedir().length)}`;
    const cwd = makeFixtureDir();
    const { block, rule, reason } = await evaluateBash(
      cwd,
      `gh issue create --title "tracking" --body-file <(perl -0777 -pe '${BODY_STRIP}' "${tildePath}")`,
      host,
    );
    assert.equal(block, true, "expected block");
    assert.equal(rule, "issue-body-from-vault-file");
    assert.ok(
      reason.includes(`--body-file path as received: ${tildePath}`),
      `reason: ${reason}`,
    );
    assert.ok(
      reason.includes(`${cwd}/${tildePath}`),
      `trace must show the literal join: ${reason}`,
    );
    assert.ok(reason.includes("exists: no"), `reason: ${reason}`);
  });
});
