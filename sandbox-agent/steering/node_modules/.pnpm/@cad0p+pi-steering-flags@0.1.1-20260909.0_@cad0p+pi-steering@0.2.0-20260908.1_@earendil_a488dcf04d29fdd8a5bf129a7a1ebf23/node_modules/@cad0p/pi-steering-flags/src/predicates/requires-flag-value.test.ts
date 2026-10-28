// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateWord } from "@cad0p/pi-steering";
import {
  type MockContextOptions,
  testPredicate,
} from "@cad0p/pi-steering/testing";
import { requiresFlagValue } from "./requires-flag-value.ts";

function W(value: string): PredicateWord {
  return { value, text: value, pos: 0, end: value.length, rawText: value };
}

// Closing-keywords-only pattern: "closes #12" satisfies it, "see #13"
// does NOT — which is what makes the last-wins rows (6/7) observable.
const CLOSING = /\b(closes?|fixe?s?|resolves?)\s+#\d+\b/i;

function bashCtx(args: PredicateWord[]): MockContextOptions {
  return {
    input: {
      tool: "bash",
      command: "gh pr merge",
      basename: "gh",
      args,
    },
    descriptors: {
      gh: {
        flags: {
          subject: { aliases: ["--subject", "-t"], takesValue: true },
        },
      },
    },
  };
}

describe("requiresFlagValue", () => {
  it("does NOT fire when the separated-form value matches", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject"), W("closes #12")]),
    );
    assert.equal(fires, false);
  });

  it("does NOT fire when the attached-form value matches", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject=closes #12")]),
    );
    assert.equal(fires, false);
  });

  it("fires when the value is present but does NOT match", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject"), W("see #13")]),
    );
    assert.equal(fires, true);
  });

  it("fires when the flag is absent entirely (fail-closed core)", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--squash")]),
    );
    assert.equal(fires, true);
  });

  it("fires when a trailing flag has no value", async () => {
    // `gh pr merge -t foo --subject` — pflag rejects this anyway; the
    // helper fail-closes on the trailing valueless occurrence.
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("-t"), W("foo"), W("--subject")]),
    );
    assert.equal(fires, true);
  });

  it("alias last-wins: later --subject wins over earlier -t (no fire)", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("-t"), W("see #13"), W("--subject"), W("closes #12")]),
    );
    assert.equal(fires, false);
  });

  it("alias last-wins reversed: later -t wins over earlier --subject (fires)", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject"), W("closes #12"), W("-t"), W("see #13")]),
    );
    assert.equal(fires, true);
  });

  it("repeated same flag: LAST occurrence wins (no fire)", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject"), W("x"), W("--subject"), W("closes #12")]),
    );
    assert.equal(fires, false);
  });

  it("attached-empty value (--subject=) fires — empty string ≠ match", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject=")]),
    );
    assert.equal(fires, true);
  });

  it("quote-aware: reads .value before .text", async () => {
    // Walker-resolved .value is the quoted arg's real content; the raw
    // .text deliberately disagrees so reading .text would flip this.
    const quoted: PredicateWord = {
      value: "closes #12",
      text: "see #13",
      pos: 0,
      end: 9,
      rawText: "see #13",
    };
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject"), quoted]),
    );
    assert.equal(fires, false);
  });

  it("malformed args fail-open (no fire)", async () => {
    const ctx = bashCtx([W("--squash")]);
    // Missing both fields.
    assert.equal(
      await testPredicate(requiresFlagValue, {} as never, ctx),
      false,
    );
    // Missing flags.
    assert.equal(
      await testPredicate(
        requiresFlagValue,
        { matches: CLOSING } as never,
        ctx,
      ),
      false,
    );
    // Empty flags array.
    assert.equal(
      await testPredicate(
        requiresFlagValue,
        { flags: [], matches: CLOSING } as never,
        ctx,
      ),
      false,
    );
    // matches is not a RegExp.
    assert.equal(
      await testPredicate(
        requiresFlagValue,
        { flags: ["--subject"], matches: "closes #12" } as never,
        ctx,
      ),
      false,
    );
  });

  it("fires when ctx.input.args is undefined", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      {
        flags: ["--subject", "-t"],
        matches: CLOSING,
      },
      {
        input: {
          tool: "bash",
          command: "gh pr merge",
          basename: "gh",
          // args omitted
        },
        descriptors: {
          gh: {
            flags: {
              subject: { aliases: ["--subject", "-t"], takesValue: true },
            },
          },
        },
      },
    );
    assert.equal(fires, true);
  });

  it("/g regex statefulness: same predicate + args re-evaluate correctly", async () => {
    // First .test() drives lastIndex past the end; without the
    // predicate's reset the second verdict would intermittently flip.
    const args = { flags: ["--subject"], matches: /x/g };
    const ctx = bashCtx([W("--subject"), W("x")]);
    assert.equal(await testPredicate(requiresFlagValue, args, ctx), false);
    assert.equal(await testPredicate(requiresFlagValue, args, ctx), false);
  });

  it("non-string alias entry fails open (no fire)", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", 42], matches: CLOSING } as never,
      bashCtx([W("--subject"), W("closes #12")]),
    );
    assert.equal(fires, false);
  });

  it("next token that looks like a flag is taken as the value", async () => {
    // getFlagValue doesn't second-guess the next token;
    // "--force" becomes the value and (not matching) fires.
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject"), W("--force")]),
    );
    assert.equal(fires, true);
  });

  it('separated-empty value (--subject "") reads as null and fires', async () => {
    // Distinct from the attached-empty case above: the walker resolves
    // the empty quoted arg to "" and the helper treats it as valueless.
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject"), W("")]),
    );
    assert.equal(fires, true);
  });

  it("prefix collision: --subject-extra=x does not satisfy --subject", async () => {
    const fires = await testPredicate(
      requiresFlagValue,
      { flags: ["--subject", "-t"], matches: CLOSING },
      bashCtx([W("--subject-extra=x")]),
    );
    assert.equal(fires, true);
  });
});
