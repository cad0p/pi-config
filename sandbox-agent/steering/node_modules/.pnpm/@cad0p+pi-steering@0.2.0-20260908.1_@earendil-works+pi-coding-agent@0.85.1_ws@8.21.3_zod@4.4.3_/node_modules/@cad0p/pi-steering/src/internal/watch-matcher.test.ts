// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Parity regression test for the shared observer-watch filter
 * contract.
 *
 * Two consumers need the same answer to "would this observer fire on
 * a successful bash tool_result with command=X?":
 *
 *   1. The production dispatcher ({@link matchesWatch} applied to a
 *      real `ToolResultEvent` arriving from pi).
 *   2. The evaluator's `when.missing` with `in: "tool_call"` speculative-allow
 *      (synthesizes a minimal successful bash event from a prior
 *      `&&` ref and calls {@link matchesWatch}).
 *
 * Before commit 12, path 2 hand-rolled a SUBSET of the filter. Three
 * reviewer-caught bugs (reachability aside) were all "drift between
 * the hand-rolled subset and the dispatcher's real filter":
 *
 *   - medium-001: exitCode / toolName checks missing in the subset.
 *   - FIND-3: dedup missing (not a filter drift, fixed separately).
 *   - future-drift: any new `watch` field would need parallel updates.
 *
 * Commit 12 collapsed path 2 onto {@link matchesWatch} via a
 * synthesized event. This test pins that the two paths agree on every
 * combination of `watch` field against representative ref-text inputs.
 * If a future commit adds a new `watch` field to {@link matchesWatch}
 * and forgets to exercise it in the synthesized event, the mismatch
 * shows up here first.
 *
 * Semantic layer note: tool_call-scope speculative allow ALSO layers an
 * extra "observer must declare `inputMatches.command`" gate on top of
 * the shared filter (to prevent allow on command-agnostic watches —
 * not a filter-semantic question, but a speculative-synthesis safety
 * requirement). That gate is covered end-to-end in the evaluator tests
 * ("observer without inputMatches.command → no speculative allow"). It
 * is intentionally OUT OF SCOPE here: this file verifies that when
 * both paths see the same event + watch, they compute the same filter
 * answer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ObserverWatch, ToolResultEvent } from "../schema.ts";
import { WATCH_DEFAULT_WALK } from "./walk-registry.ts";
import { extractRefTextsForBash, matchesWatch } from "./watch-matcher.ts";

// Standalone walk options for direct extractRefTextsForBash callers in
// this file: no plugin state is in play, so the builtin default walk
// + inert cwd sentinel apply (same as the matchesWatch default
// provider). Production threads buildWalkRegistry + per-event cwd.
const STANDALONE_WALK = {
  trackers: WATCH_DEFAULT_WALK,
  cwd: "/",
} as const;

// ---------------------------------------------------------------------------
// Synthetic-event constructor
// ---------------------------------------------------------------------------
//
// The exact synthesis the evaluator's speculative-entry producer
// (see `evaluator-internals/speculative-synthesis.ts`) uses for a
// prior `&&` ref. Kept in lockstep with the real one: if the
// evaluator's synthesis grows a field, mirror it here so the test
// exercises the same shape.

function synthesizedSuccessBashEvent(refText: string): ToolResultEvent {
  return {
    toolName: "bash",
    input: { command: refText },
    output: undefined,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Fixture matrix
// ---------------------------------------------------------------------------

interface WatchCase {
  readonly name: string;
  readonly watch: ObserverWatch | undefined;
}

const WATCH_CASES: readonly WatchCase[] = [
  { name: "undefined watch → fires on everything", watch: undefined },
  { name: "empty watch object", watch: {} },
  { name: "toolName: bash", watch: { toolName: "bash" } },
  { name: "toolName: read", watch: { toolName: "read" } },
  {
    name: "inputMatches.command (RegExp)",
    watch: { inputMatches: { command: /^sync\b/ } },
  },
  {
    name: "inputMatches.command (string)",
    watch: { inputMatches: { command: "^sync\\b" } },
  },
  {
    name: "inputMatches.command — no match",
    watch: { inputMatches: { command: /^never-match\b/ } },
  },
  {
    name: "inputMatches multi-key (path absent on bash event)",
    watch: { inputMatches: { command: /^sync\b/, path: /^\// } },
  },
  { name: "exitCode: success", watch: { exitCode: "success" } },
  { name: "exitCode: failure", watch: { exitCode: "failure" } },
  { name: "exitCode: any", watch: { exitCode: "any" } },
  { name: "exitCode: 0 (numeric)", watch: { exitCode: 0 } },
  { name: "exitCode: 1 (numeric non-zero)", watch: { exitCode: 1 } },
  {
    name: "toolName+inputMatches+exitCode combo (all satisfied)",
    watch: {
      toolName: "bash",
      inputMatches: { command: /^sync\b/ },
      exitCode: "success",
    },
  },
  {
    name: "toolName+inputMatches+exitCode combo (exitCode fails)",
    watch: {
      toolName: "bash",
      inputMatches: { command: /^sync\b/ },
      exitCode: "failure",
    },
  },
  {
    name: "toolName+inputMatches+exitCode combo (toolName fails)",
    watch: {
      toolName: "read",
      inputMatches: { command: /^sync\b/ },
      exitCode: "success",
    },
  },
];

interface DispatcherEventCase {
  readonly name: string;
  readonly refText: string;
  /** Real dispatcher-facing event for the same ref text. */
  readonly dispatcherEvent: ToolResultEvent;
}

/**
 * For each ref text we build two events:
 *   - the speculative SYNTHESIS (constructed above),
 *   - the dispatcher equivalent: the same bash tool_result the
 *     dispatcher would see after a successful run of `refText`.
 *
 * Both events carry `toolName: "bash"`, `input.command = refText`,
 * and `exitCode: 0`. The only field-level difference is that the
 * dispatcher event has an `output` array (pi's `content`) whereas the
 * synthesis leaves `output` undefined. {@link matchesWatch} does not
 * inspect `output` today; this parity test also pins that invariant.
 */
const EVENT_CASES: readonly DispatcherEventCase[] = [
  {
    name: "sync (matches /^sync\\b/)",
    refText: "sync",
    dispatcherEvent: {
      toolName: "bash",
      input: { command: "sync" },
      output: [{ type: "text", text: "" }],
      exitCode: 0,
    },
  },
  {
    name: "sync --lock (still matches /^sync\\b/)",
    refText: "sync --lock",
    dispatcherEvent: {
      toolName: "bash",
      input: { command: "sync --lock" },
      output: [{ type: "text", text: "" }],
      exitCode: 0,
    },
  },
  {
    name: "git push (no match for /^sync\\b/)",
    refText: "git push",
    dispatcherEvent: {
      toolName: "bash",
      input: { command: "git push" },
      output: [{ type: "text", text: "" }],
      exitCode: 0,
    },
  },
  {
    name: "empty-args ref",
    refText: "pwd",
    dispatcherEvent: {
      toolName: "bash",
      input: { command: "pwd" },
      output: [{ type: "text", text: "" }],
      exitCode: 0,
    },
  },
];

// ---------------------------------------------------------------------------
// Parity assertion
// ---------------------------------------------------------------------------

describe("matchesWatch: synthesized-event parity with dispatcher event", () => {
  // Cross-product: every watch × every (refText, dispatcher event)
  // combination exercises both paths with the same semantic inputs.
  // If they disagree for ANY combination, the subset has drifted.
  for (const wc of WATCH_CASES) {
    for (const ec of EVENT_CASES) {
      it(`watch "${wc.name}" on event "${ec.name}" — both paths agree`, () => {
        const synthetic = synthesizedSuccessBashEvent(ec.refText);
        const syntheticResult = matchesWatch(wc.watch, synthetic);
        const dispatcherResult = matchesWatch(wc.watch, ec.dispatcherEvent);
        assert.equal(
          syntheticResult,
          dispatcherResult,
          `Synthesized-event path returned ${syntheticResult} but ` +
            `dispatcher event returned ${dispatcherResult} for the ` +
            `same watch/command. Synthesis must carry every field ` +
            `matchesWatch inspects for a successful bash event.`,
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Direct ground-truth tests
// ---------------------------------------------------------------------------
//
// The parity matrix above pins that both paths AGREE — but "both
// always return false" is also agreement. These tests pin the actual
// filter semantics per ADR so a refactor that breaks the ground truth
// (e.g. exitCode: "failure" now passes on success) doesn't slip
// through under the parity check.

describe("matchesWatch: ground-truth semantics", () => {
  it("undefined watch fires on everything", () => {
    assert.equal(
      matchesWatch(undefined, synthesizedSuccessBashEvent("anything")),
      true,
    );
  });

  it("toolName: 'bash' accepts a bash event", () => {
    assert.equal(
      matchesWatch({ toolName: "bash" }, synthesizedSuccessBashEvent("sync")),
      true,
    );
  });

  it("toolName: 'read' rejects a bash event", () => {
    assert.equal(
      matchesWatch({ toolName: "read" }, synthesizedSuccessBashEvent("sync")),
      false,
    );
  });

  it("inputMatches.command matches ref text", () => {
    assert.equal(
      matchesWatch(
        { inputMatches: { command: /^sync\b/ } },
        synthesizedSuccessBashEvent("sync"),
      ),
      true,
    );
  });

  it("inputMatches.command rejects non-matching ref text", () => {
    assert.equal(
      matchesWatch(
        { inputMatches: { command: /^sync\b/ } },
        synthesizedSuccessBashEvent("git push"),
      ),
      false,
    );
  });

  it("exitCode: 'success' accepts synthesized (exit 0)", () => {
    assert.equal(
      matchesWatch(
        { exitCode: "success" },
        synthesizedSuccessBashEvent("sync"),
      ),
      true,
    );
  });

  it("exitCode: 'failure' rejects synthesized (exit 0)", () => {
    // This pins the medium-001 regression: the pre-refactor subset
    // ignored exitCode entirely and would have let a failure-gated
    // observer grant speculative-allow on a successful `&&` chain.
    assert.equal(
      matchesWatch(
        { exitCode: "failure" },
        synthesizedSuccessBashEvent("sync"),
      ),
      false,
    );
  });

  it("exitCode: 1 rejects synthesized (exit 0)", () => {
    assert.equal(
      matchesWatch({ exitCode: 1 }, synthesizedSuccessBashEvent("sync")),
      false,
    );
  });

  it("exitCode: 0 accepts synthesized (exit 0)", () => {
    assert.equal(
      matchesWatch({ exitCode: 0 }, synthesizedSuccessBashEvent("sync")),
      true,
    );
  });

  it("exitCode: 'any' accepts synthesized", () => {
    assert.equal(
      matchesWatch({ exitCode: "any" }, synthesizedSuccessBashEvent("sync")),
      true,
    );
  });

  it("multi-key inputMatches with absent key fails closed", () => {
    // The synthesized event has `input: { command: refText }` —
    // `path` is absent. ADR fail-closed: absent key → whole filter
    // fails. Pins that the synthesis doesn't accidentally pass
    // filters it shouldn't.
    assert.equal(
      matchesWatch(
        { inputMatches: { command: /^sync\b/, path: /^\// } },
        synthesizedSuccessBashEvent("sync"),
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// extractRefTextsForBash — env-resolved per-ref text (issue #51)
// ---------------------------------------------------------------------------

describe("extractRefTextsForBash: env-resolved ref text (issue #51)", () => {
  function bashResult(command: string): ToolResultEvent {
    return {
      toolName: "bash",
      input: { command },
      output: [{ type: "text", text: "" }],
      exitCode: 0,
    };
  }

  it("returns null for non-bash events", () => {
    assert.equal(
      extractRefTextsForBash(
        {
          toolName: "read",
          input: { path: "/x" },
          output: undefined,
        },
        STANDALONE_WALK,
      ),
      null,
    );
  });

  it("returns null when the command is missing or empty", () => {
    assert.equal(extractRefTextsForBash(bashResult(""), STANDALONE_WALK), null);
  });

  it("static commands render identically to raw refToText", () => {
    const texts = extractRefTextsForBash(
      bashResult("git push origin main"),
      STANDALONE_WALK,
    );
    assert.deepEqual(texts, ["git push origin main"]);
  });

  it("chain-assigned $VAR resolves against the walk's env", () => {
    const texts = extractRefTextsForBash(
      bashResult('T="feat: x (closes #12)" && gh pr create --title "$T"'),
      STANDALONE_WALK,
    );
    assert.ok(texts);
    // The bare-assignment ref renders as its own (empty) ref; the gh
    // ref resolves `$T` via the walk's chain env (value-mode).
    const gh = texts.find((t) => t.startsWith("gh pr create"));
    assert.equal(gh, "gh pr create --title feat: x (closes #12)");
  });

  it("process substitution word expands its inner $VAR in the ref text", () => {
    const texts = extractRefTextsForBash(
      bashResult(
        "BODY=/vault/repo/prs/note.md && gh pr create --body-file=<(perl -0777 -pe '<BODY_STRIP>' \"$BODY\")",
      ),
      STANDALONE_WALK,
    );
    assert.ok(texts);
    const gh = texts.find((t) => t.startsWith("gh pr create"));
    assert.equal(
      gh,
      "gh pr create --body-file= <(perl -0777 -pe '<BODY_STRIP>' \"/vault/repo/prs/note.md\")",
    );
  });

  it("same-ref prefix assignments do NOT resolve event-side words (bash-faithful)", () => {
    // Parity with the evaluator's rule side — both resolve against the
    // RAW walker env snapshot: BODY is not in the snapshot (the prefix
    // binds for the direct child's env only, NOT for the same
    // command's word expansions), so the word stays raw.
    const texts = extractRefTextsForBash(
      bashResult(
        'BODY=/vault/repo/prs/note.md gh pr create --body-file "$BODY"',
      ),
      STANDALONE_WALK,
    );
    assert.ok(texts);
    const gh = texts.find((t) => t.startsWith("gh pr create"));
    assert.equal(gh, "gh pr create --body-file $BODY");
  });

  it("unresolvable vars stay raw (fail-closed)", () => {
    const texts = extractRefTextsForBash(
      bashResult('gh pr create --title "$UNDEF"'),
      STANDALONE_WALK,
    );
    assert.deepEqual(texts, ["gh pr create --title $UNDEF"]);
  });

  it("wrapper inner refs without walk state fall back to raw refToText", () => {
    // `sh -c '…'` inner refs come from wrapper expansion, not the
    // outer AST the walk covers — no walk state → raw fallback
    // (identical to the evaluator's per-ref fallback).
    const texts = extractRefTextsForBash(
      bashResult("sh -c 'BODY=/x && echo \"$BODY\"'"),
      STANDALONE_WALK,
    );
    assert.ok(texts);
    const inner = texts.find((t) => t.startsWith("echo"));
    assert.equal(inner, "echo $BODY", "no walk state → raw refToText");
  });

  it("matchesWatch inputMatches.command sees the resolved ref text", () => {
    const event = bashResult(
      'T="feat: x (closes #12)" && gh pr create --title "$T"',
    );
    assert.equal(
      matchesWatch({ inputMatches: { command: /closes #\d+/ } }, event),
      true,
      "watch pattern matches the RESOLVED title (raw '$T' would not)",
    );
    assert.equal(
      matchesWatch({ inputMatches: { command: /--title \$T/ } }, event),
      false,
      "watch pattern on the RAW variable no longer matches",
    );
  });
});
