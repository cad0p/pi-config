// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Unit tests for {@link synthesizeSpeculativeEntries}.
 *
 * Table-driven across (watch, joiner) shapes per PR #5 spec. These
 * tests pin the behaviour the evaluator relies on when threading the
 * synthesis output into `walkerState.events`; the integration-level
 * `&&`-chain tests in `evaluator.test.ts` still drive end-to-end
 * behaviour through the built-in `missing` predicate.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  type CommandRef,
  expandWrapperCommands,
  extractAllCommandsFromAST,
  parse as parseBash,
} from "@cad0p/unbash-walker";
import type { Observer } from "../schema.ts";
import {
  SPECULATIVE_BASELINE,
  type SyntheticEntry,
  synthesizeSpeculativeEntries,
} from "./speculative-synthesis.ts";

function refsFor(command: string): readonly CommandRef[] {
  const script = parseBash(command);
  const extracted = extractAllCommandsFromAST(script, command);
  return expandWrapperCommands(extracted).commands;
}

const SYNC_DONE = "sync-done" as const;
const UPSTREAM_FAILED = "upstream-failed" as const;

/**
 * Empty resolved-text map — callers that don't care about env
 * resolution exercise the raw {@link refToText} fallback path.
 */
const EMPTY_RESOLVED_TEXTS = new Map<CommandRef, string>();

function syncObserver(overrides: Partial<Observer> = {}): Observer {
  return {
    name: "sync-tracker",
    writes: [SYNC_DONE],
    watch: {
      toolName: "bash",
      inputMatches: { command: /^sync\b/ },
      exitCode: "success",
    },
    onResult: () => {},
    ...overrides,
  };
}

describe("synthesizeSpeculativeEntries: joiner reachability", () => {
  it("empty refs → empty result", () => {
    const out = synthesizeSpeculativeEntries(
      [],
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.equal(out.size, 0);
  });

  it("`sync && cr` — cr sees sync's synthetic entry", () => {
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const syncView = out.get(refs[0]!);
    const crView = out.get(refs[1]!);
    assert.deepEqual(syncView, {}, "first ref sees empty chain");
    assert.ok(crView?.[SYNC_DONE], "cr sees sync's synthetic entry");
    assert.equal(crView[SYNC_DONE].length, 1);
    assert.deepEqual(crView[SYNC_DONE][0], {
      data: {},
      timestamp: SPECULATIVE_BASELINE + 1, // baseline + 1 + ref index 0
      speculative: true,
    });
  });

  it("`cr && sync` — cr has no prior && producer", () => {
    const refs = refsFor("cr --review && sync");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[0]!), {}, "cr sees empty");
    // sync is after cr in source order, so sync sees whatever cr
    // produced — but cr doesn't match the observer, so sync sees empty.
    assert.deepEqual(out.get(refs[1]!), {});
  });

  it("`sync ; cr` — `;` does NOT propagate synthesis across", () => {
    const refs = refsFor("sync ; cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[1]!), {}, "cr after `;` sees no chain");
  });

  it("`sync || cr` — `||` breaks the chain", () => {
    const refs = refsFor("sync || cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[1]!), {});
  });

  it("`lint || sync && cr` — `||` early kills reachability", () => {
    // lint.joiner=||, sync.joiner=&&, cr.joiner=undef. Because
    // `lint` is followed by `||`, reachability clears. `sync`'s
    // `&&` happens on an unreachable segment → sync is not an
    // eligible producer for cr.
    const refs = refsFor("lint || sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[2]!), {});
  });

  it("`cd /x ; sync && cr` — `;` restores reachability", () => {
    const refs = refsFor("cd /x ; sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[refs.length - 1]!);
    assert.ok(
      crView?.[SYNC_DONE],
      "after `;`, sync && cr grants a synthetic entry for cr",
    );
  });

  it("`echo foo && sync && cr` — transitive chain", () => {
    const refs = refsFor("echo foo && sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[2]!);
    assert.ok(crView?.[SYNC_DONE], "cr inherits the && chain");
  });
});

describe("synthesizeSpeculativeEntries: observer watch gating", () => {
  it("observer without inputMatches.command → no synthesis", () => {
    const looseObs: Observer = {
      name: "loose",
      writes: [SYNC_DONE],
      watch: { toolName: "bash" },
      onResult: () => {},
    };
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [looseObs],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[1]!), {});
  });

  it("observer with non-bash toolName → no synthesis", () => {
    const readObs: Observer = {
      name: "read-obs",
      writes: [SYNC_DONE],
      watch: {
        toolName: "read",
        inputMatches: { command: /^sync\b/ },
      },
      onResult: () => {},
    };
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [readObs],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[1]!), {});
  });

  it("observer gated on exitCode: 'failure' → no synthesis (success event)", () => {
    // The synthesized event is `exitCode: 0`; a watch demanding
    // failure rejects it via `matchesWatch`. Delegation to
    // matchesWatch — no subset re-impl here.
    const failObs = syncObserver({
      name: "fail-gated",
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
        exitCode: "failure",
      },
    });
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [failObs],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[1]!), {});
  });

  it("observer with inputMatches pattern not hitting the ref → no synthesis", () => {
    const tightObs = syncObserver({
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync --lock\b/ },
        exitCode: "success",
      },
    });
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [tightObs],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[1]!), {});
  });

  it("observer without writes[] → no synthesis", () => {
    const noWritesObs: Observer = {
      name: "no-writes",
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
      },
      onResult: () => {},
    };
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [noWritesObs],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[1]!), {});
  });

  it("multiple observers on same type — first match wins, no duplicate entries", () => {
    const obsA = syncObserver({
      name: "obs-a",
      watch: {
        toolName: "bash",
        inputMatches: { command: /^never-match\b/ },
      },
    });
    const obsB = syncObserver({
      name: "obs-b",
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
      },
    });
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [obsA, obsB],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[1]!);
    assert.equal(
      crView?.[SYNC_DONE]?.length,
      1,
      "one synthetic entry per (ref, customType) — dedup across observers",
    );
  });
});

describe("synthesizeSpeculativeEntries: timestamp convention", () => {
  it("speculative timestamp uses fixed reserved baseline + 1 + astIndex", () => {
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const entry = out.get(refs[1]!)?.[SYNC_DONE]?.[0];
    // sync is at index 0, baseline + 1 + 0
    assert.equal(entry?.timestamp, SPECULATIVE_BASELINE + 1);
  });

  it("baseline is strictly greater than any realistic epoch-ms timestamp", () => {
    // Date.now() is < 2^48 for any date through ~year 10,890 AD. Our
    // baseline is 2^52. The gap is the headroom that makes
    // speculative > real trivially.
    assert.ok(SPECULATIVE_BASELINE > Date.now() * 100);
  });

  it("AST-order monotonic — later ref has later speculative timestamp", () => {
    // `echo foo && sync && cr`: echo.idx=0, sync.idx=1. Only sync
    // matches the observer. Its timestamp: baseline + 1 + 1.
    const refs = refsFor("echo foo && sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const entry = out.get(refs[2]!)?.[SYNC_DONE]?.[0];
    assert.equal(entry?.timestamp, SPECULATIVE_BASELINE + 2);
  });

  it("two speculative writes in same chain — later ref has later timestamp", () => {
    // `A && B && cr` where A writes X and B writes Y. AST order:
    // A.idx=0, B.idx=1. Timestamps: X=SPECULATIVE_BASELINE+1, Y=SPECULATIVE_BASELINE+2.
    // Downstream `when.missing: { event: X, since: Y }` reads X
    // as stale — the two-speculative-writes-with-since-invalidator
    // correctness case.
    const EVENT_X = "event-x";
    const EVENT_Y = "event-y";
    const obsA: Observer = {
      name: "a-tracker",
      writes: [EVENT_X],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^a\b/ },
      },
      onResult: () => {},
    };
    const obsB: Observer = {
      name: "b-tracker",
      writes: [EVENT_Y],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^b\b/ },
      },
      onResult: () => {},
    };
    const refs = refsFor("a && b && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [obsA, obsB],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[2]!);
    assert.equal(
      crView?.[EVENT_X]?.[0]?.timestamp,
      SPECULATIVE_BASELINE + 1,
      "X ts = baseline + 1 + 0",
    );
    assert.equal(
      crView?.[EVENT_Y]?.[0]?.timestamp,
      SPECULATIVE_BASELINE + 2,
      "Y ts = baseline + 1 + 1",
    );
    // Invariant: X older than Y in the speculative timeline.
    assert.ok(
      crView![EVENT_X]![0]!.timestamp < crView![EVENT_Y]![0]!.timestamp,
      "AST order preserved among speculatives",
    );
  });
});

describe("synthesizeSpeculativeEntries: flag + identity", () => {
  it("all synthetic entries carry `speculative: true`", () => {
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const entry = out.get(refs[1]!)?.[SYNC_DONE]?.[0];
    assert.equal(entry?.speculative, true);
  });

  it("output is keyed by ref identity, not index", () => {
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    for (const ref of refs) {
      assert.ok(out.has(ref), `result has ref ${ref.node.name?.text ?? ""}`);
    }
  });

  it("single ref with no joiner → empty view", () => {
    const refs = refsFor("cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(out.get(refs[0]!), {});
  });
});

describe("synthesizeSpeculativeEntries: subshell coverage", () => {
  it("`(sync) && cr` — subshell refs participate in the chain", () => {
    const refs = refsFor("(sync) && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    // cr is the last ref; sync's synthetic entry must be visible.
    const crView = out.get(refs[refs.length - 1]!);
    assert.ok(crView?.[SYNC_DONE], "subshell sync feeds cr's chain");
  });

  it("`(echo hi && sync) && cr` — multi-ref subshell", () => {
    // GAP-01 regression fence. Both refs inside `(...)` participate
    // in cr's prior chain; sync matches the observer.
    const refs = refsFor("(echo hi && sync) && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[refs.length - 1]!);
    assert.ok(crView?.[SYNC_DONE], "multi-ref subshell: sync feeds cr");
  });

  it("`foo && (bar ; sync) && cr` — `;` inside subshell clears chain", () => {
    // GAP-02 conservative-under fence. After the `;`, only sync is
    // in cr's prior chain; foo is dropped. Observer matches ONLY
    // foo → no synthesis for cr.
    const fooObs = syncObserver({
      name: "foo-only",
      watch: {
        toolName: "bash",
        inputMatches: { command: /^foo\b/ },
        exitCode: "success",
      },
    });
    const refs = refsFor("foo && (bar ; sync) && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [fooObs],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[refs.length - 1]!);
    assert.deepEqual(
      crView,
      {},
      "conservative-under: foo dropped from cr's chain by `;`",
    );
  });
});

describe("synthesizeSpeculativeEntries: per-ref isolation", () => {
  it("earlier refs do not see later producers", () => {
    // Load-bearing safety property. `sync && cr`: sync (idx 0)
    // must NOT see its own synthetic entry. Only cr (idx 1) does.
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    assert.deepEqual(
      out.get(refs[0]!),
      {},
      "sync cannot see entries it (would) produce",
    );
  });

  it("map entries are distinct per ref (no cross-ref mutation)", () => {
    const refs = refsFor("echo foo && sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const echoView = out.get(refs[0]!);
    const syncView = out.get(refs[1]!);
    const crView = out.get(refs[2]!);
    // echo, sync should both see empty (sync hasn't produced yet
    // for itself). cr should see sync's entry.
    assert.deepEqual(echoView, {});
    assert.deepEqual(syncView, {});
    assert.ok(crView?.[SYNC_DONE]);
  });
});

describe("synthesizeSpeculativeEntries: multi-type coexistence", () => {
  it("writes by distinct observers for different customTypes coexist", () => {
    const OTHER = "other-event";
    const otherObs: Observer = {
      name: "other",
      writes: [OTHER],
      watch: {
        toolName: "bash",
        inputMatches: { command: /^sync\b/ },
      },
      onResult: () => {},
    };
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver(), otherObs],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[1]!);
    assert.ok(crView?.[SYNC_DONE]);
    assert.ok(crView?.[OTHER]);
  });

  it("custom type with no observers remains unrepresented", () => {
    const refs = refsFor("sync && cr --review");
    const out = synthesizeSpeculativeEntries(
      refs,
      [syncObserver()],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[1]!) as Record<
      string,
      readonly SyntheticEntry[]
    >;
    assert.equal(crView[UPSTREAM_FAILED], undefined);
  });
});

describe("synthesizeSpeculativeEntries: resolved command text (issue #51)", () => {
  it("watch pattern matches a prior $VAR-bearing ref via resolved text", () => {
    // Producer ref is `T="feat: x" gh pr create --title "$T"` (the
    // `T=` assignment is the gh ref's OWN prefix — one ref); the
    // resolved text turns the `--title "$T"` word into
    // `--title "feat: x"`, so a watch on the RESOLVED title fires
    // for the later `&&`-reached consumer (raw text would not match
    // — that's the contract shift).
    const refs = refsFor(
      'T="feat: x" gh pr create --title "$T" && cr --review',
    );
    const ghRef = refs[0]!;
    const crRef = refs[1]!;
    const resolvedTexts = new Map<CommandRef, string>([
      [ghRef, 'gh pr create --title "feat: x"'],
    ]);
    const titleObs = syncObserver({
      name: "title-tracker",
      watch: {
        toolName: "bash",
        inputMatches: { command: /--title "feat: x"/ },
        exitCode: "success",
      },
    });
    const out = synthesizeSpeculativeEntries(refs, [titleObs], resolvedTexts);
    const crView = out.get(crRef)!;
    assert.ok(
      crView[SYNC_DONE],
      "consumer sees the producer's synthetic entry via resolved text",
    );
  });

  it("refs absent from the resolved-text map fall back to raw refToText", () => {
    // Same command, empty map → raw `--title "$T"` never matches the
    // resolved-title watch → no synthesis (fallback path pinned).
    const refs = refsFor(
      'T="feat: x" gh pr create --title "$T" && cr --review',
    );
    const titleObs = syncObserver({
      name: "title-tracker",
      watch: {
        toolName: "bash",
        inputMatches: { command: /--title "feat: x"/ },
        exitCode: "success",
      },
    });
    const out = synthesizeSpeculativeEntries(
      refs,
      [titleObs],
      EMPTY_RESOLVED_TEXTS,
    );
    const crView = out.get(refs[1]!);
    assert.deepEqual(
      crView,
      {},
      "raw text doesn't match the resolved-title watch — fallback keeps synthesis strict",
    );
  });
});
