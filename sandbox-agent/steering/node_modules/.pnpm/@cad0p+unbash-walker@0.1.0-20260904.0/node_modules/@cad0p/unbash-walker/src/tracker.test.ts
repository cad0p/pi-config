// SPDX-License-Identifier: MIT
// Tests for the generalized Tracker / walk API. Part of unbash-walker.
//
// These tests exercise `walk` directly with small hand-crafted trackers to
// pin the semantics of the generalization — independent of the built-in
// cwd tracker. For end-to-end cwd coverage see `trackers/cwd.test.ts`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { getBasename } from "./resolve.ts";
import {
  isStaticallyResolvable,
  type Modifier,
  type Tracker,
  walk,
} from "./tracker.ts";
import { cwdTracker } from "./trackers/cwd.ts";
import type { CommandRef } from "./types.ts";

// --------------------------------------------------------------------------
// Test trackers
// --------------------------------------------------------------------------

/**
 * A toy "counter" tracker. Each `inc` call increments the value by 1.
 * Useful for sequential-propagation tests: a counter ends at N after N `inc`
 * invocations regardless of their position within control flow.
 */
const counterTracker: Tracker<number> = {
  initial: 0,
  unknown: -1,
  modifiers: {
    inc: {
      scope: "sequential",
      apply: (_args, current) => current + 1,
    },
  },
  subshellSemantics: "isolated",
};

/**
 * A toy "label" tracker. `set LABEL` applies sequentially; `tag LABEL`
 * applies only to the command it's attached to. Exercises the sequential
 * vs per-command distinction and the `undefined` → unknown translation.
 */
const labelTracker: Tracker<string> = {
  initial: "initial",
  unknown: "?",
  modifiers: {
    set: {
      scope: "sequential",
      apply: (args, _current) => {
        const w = args[0];
        if (!w || !isStaticallyResolvable(w)) return undefined;
        return w.value;
      },
    },
    tag: {
      scope: "per-command",
      apply: (args, _current) => {
        const w = args[0];
        if (!w || !isStaticallyResolvable(w)) return undefined;
        return w.value;
      },
    },
  },
  subshellSemantics: "isolated",
};

/**
 * A "global" tracker — changes made inside a subshell escape. Used to
 * pin the Tracker.subshellSemantics contract independently.
 */
const globalFlagTracker: Tracker<string> = {
  initial: "outside",
  unknown: "?",
  modifiers: {
    mark: {
      scope: "sequential",
      apply: (args, _current) => {
        const w = args[0];
        if (!w || !isStaticallyResolvable(w)) return undefined;
        return w.value;
      },
    },
  },
  subshellSemantics: "global",
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Run `walk` with a single tracker under name `name` and return the
 *  ordered list of `[basename, value]` pairs. */
function orderedValues<T>(
  raw: string,
  name: string,
  tracker: Tracker<T>,
  initial?: T,
): Array<[string, T]> {
  const ast = parseBash(raw);
  const trackers = { [name]: tracker } as { [k: string]: Tracker<T> };
  const initialState = initial !== undefined ? { [name]: initial } : {};
  const map = walk<Record<string, T>>(ast, initialState, trackers);
  return Array.from(map, ([ref, snap]) => [getBasename(ref), snap[name]!]);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("walk — generic Tracker semantics", () => {
  describe("initial state & defaults", () => {
    it("uses the tracker's `initial` when caller provides no override", () => {
      const out = orderedValues("echo hi", "counter", counterTracker);
      assert.deepEqual(out, [["echo", 0]]);
    });

    it("uses the caller-provided initial value when given", () => {
      const out = orderedValues("echo hi", "counter", counterTracker, 42);
      assert.deepEqual(out, [["echo", 42]]);
    });

    it("records a snapshot per extracted command — same shape as effective-cwd ports", () => {
      const ast = parseBash("a && b && c");
      const map = walk(ast, {}, { counter: counterTracker });
      assert.equal(map.size, 3);
      for (const [, snap] of map) {
        assert.equal(typeof snap.counter, "number");
      }
    });
  });

  describe("sequential modifiers", () => {
    it("propagate to subsequent sibling commands", () => {
      const out = orderedValues(
        "inc && inc && echo done",
        "counter",
        counterTracker,
      );
      // inc recorded AT pre-sequential value; subsequent sees the update.
      assert.deepEqual(out, [
        ["inc", 0],
        ["inc", 1],
        ["echo", 2],
      ]);
    });

    it("don't cross pipeline peers", () => {
      const out = orderedValues(
        "inc | echo mid | inc",
        "counter",
        counterTracker,
      );
      assert.deepEqual(out, [
        ["inc", 0],
        ["echo", 0],
        ["inc", 0],
      ]);
    });

    it("propagate through brace groups", () => {
      const out = orderedValues(
        "{ inc; inc; } && echo done",
        "counter",
        counterTracker,
      );
      assert.deepEqual(out, [
        ["inc", 0],
        ["inc", 1],
        ["echo", 2],
      ]);
    });

    it("do NOT propagate out of an isolated subshell", () => {
      const out = orderedValues(
        "(inc; inc) && echo done",
        "counter",
        counterTracker,
      );
      assert.deepEqual(out, [
        ["inc", 0],
        ["inc", 1],
        ["echo", 0], // outer scope unchanged
      ]);
    });

    it("propagate out of a `global` subshell (reserved, rare)", () => {
      const out = orderedValues(
        "(mark inner) && echo done",
        "flag",
        globalFlagTracker,
      );
      assert.deepEqual(out, [
        ["mark", "outside"], // recorded pre-sequential
        ["echo", "inner"], // sequential update escaped
      ]);
    });
  });

  describe("per-command modifiers", () => {
    it("update recorded value for the command only, not subsequent ones", () => {
      const out = orderedValues(
        "tag A && echo mid && tag B && echo done",
        "label",
        labelTracker,
      );
      assert.deepEqual(out, [
        ["tag", "A"], // tagged to A
        ["echo", "initial"], // per-command didn't propagate
        ["tag", "B"],
        ["echo", "initial"],
      ]);
    });

    it("compose with sequential modifiers on unrelated basenames", () => {
      // `set X` is sequential; `tag Y` is per-command. After `set X`, the
      // sequential baseline is X; `tag Y` records Y (per-command applied
      // on top of the threaded X) but leaves the threaded value at X; the
      // final `echo` sees X.
      const out = orderedValues(
        "set X && tag Y && echo done",
        "label",
        labelTracker,
      );
      assert.deepEqual(out, [
        ["set", "initial"], // recorded pre-sequential
        ["tag", "Y"], // per-command sets tag's own recorded to Y
        ["echo", "X"], // threaded value from `set X` reaches echo
      ]);
    });

    it("unknown sentinel: modifier returning undefined records tracker.unknown", () => {
      const out = orderedValues(
        "tag $DYNAMIC && echo done",
        "label",
        labelTracker,
      );
      // tag's apply returns undefined → walker records `labelTracker.unknown`.
      assert.equal(out[0]?.[1], "?");
      // per-command didn't propagate: echo still sees the initial.
      assert.equal(out[1]?.[1], "initial");
    });

    it("sequential unknown: propagates forward to subsequent siblings", () => {
      const out = orderedValues(
        "set $DYNAMIC && echo mid && set X && echo done",
        "label",
        labelTracker,
      );
      // `set $DYNAMIC` → undefined → threaded value becomes "?"; subsequent
      // `echo` sees "?". A later `set X` sharpens it back to X.
      assert.equal(out[0]?.[1], "initial", "set recorded pre-sequential");
      assert.equal(out[1]?.[1], "?", "echo sees the unknown sentinel");
      assert.equal(
        out[2]?.[1],
        "?",
        "second set recorded pre-sequential (unknown)",
      );
      assert.equal(out[3]?.[1], "X", "echo sees sharpened value");
    });
  });

  describe("multi-tracker composition", () => {
    it("every tracker gets its own independent snapshot per command", () => {
      const ast = parseBash("inc && set X && echo done");
      const map = walk(
        ast,
        {},
        { counter: counterTracker, label: labelTracker },
      );
      const entries = Array.from(map, ([ref, snap]) => ({
        name: getBasename(ref),
        counter: snap.counter,
        label: snap.label,
      }));
      assert.deepEqual(entries, [
        { name: "inc", counter: 0, label: "initial" },
        { name: "set", counter: 1, label: "initial" },
        { name: "echo", counter: 1, label: "X" },
      ]);
    });

    it("initial state threading is per-tracker", () => {
      const ast = parseBash("echo hi");
      const map = walk(
        ast,
        { counter: 10, label: "seeded" },
        { counter: counterTracker, label: labelTracker },
      );
      const first = Array.from(map.values())[0];
      assert.equal(first?.counter, 10);
      assert.equal(first?.label, "seeded");
    });

    it("multi-tracker + same basename: one command can advance two trackers with independent modifiers", () => {
      // Synthetic branch tracker: sequential modifier on `git` that reads
      // the subcommand and records a branch label for `checkout`. Shares
      // the `git` basename with cwdTracker's per-command `-C` modifier.
      const branchTracker: Tracker<string> = {
        initial: "main",
        unknown: "unknown",
        modifiers: {
          git: {
            scope: "sequential",
            apply: (args, current) => {
              const subcmd = args[0]?.value;
              if (subcmd !== "checkout") return current;
              const target = args[1]?.value;
              return target ?? current;
            },
          },
        },
      };

      const ast = parseBash(
        "cd /repo && git checkout feat && git -C /other push && git commit -m x",
      );
      const refs = extractAllCommandsFromAST(ast, "");
      const result = walk(
        ast,
        { cwd: "/start", branch: "main" },
        { cwd: cwdTracker, branch: branchTracker },
        refs,
      );

      // Pick out the three `git` commands by arg inspection
      const byArgs = (first: string): readonly CommandRef[] =>
        refs.filter(
          (r) => getBasename(r) === "git" && r.node.suffix[0]?.value === first,
        );

      const checkoutRef = byArgs("checkout")[0]!;
      const pushRef = byArgs("-C")[0]!;
      const commitRef = byArgs("commit")[0]!;

      // checkout: both trackers have advanced via sequential cd; branch is
      // initial (checkout itself is the mutation, not the post-state).
      assert.equal(result.get(checkoutRef)?.cwd, "/repo");
      assert.equal(result.get(checkoutRef)?.branch, "main");

      // push: cwd overridden per-command by `-C /other`, but the next
      // command's cwd is still /repo (per-command doesn't propagate).
      // branch: checkout's sequential effect has propagated → "feat".
      assert.equal(result.get(pushRef)?.cwd, "/other");
      assert.equal(result.get(pushRef)?.branch, "feat");

      // commit: cwd back to /repo (push's -C didn't propagate).
      // branch: still "feat" — the git commit doesn't modify branch.
      assert.equal(result.get(commitRef)?.cwd, "/repo");
      assert.equal(result.get(commitRef)?.branch, "feat");
    });
  });

  describe("control flow", () => {
    it("if branches agreeing → propagate", () => {
      const out = orderedValues(
        "if test -f x; then set A; else set A; fi; echo done",
        "label",
        labelTracker,
      );
      assert.equal(out.at(-1)?.[1], "A");
    });

    it("if branches disagreeing → fall back to pre-if value", () => {
      const out = orderedValues(
        "if test -f x; then set A; else set B; fi; echo done",
        "label",
        labelTracker,
      );
      assert.equal(out.at(-1)?.[1], "initial");
    });

    it("while body may run zero times → never propagate forward", () => {
      const out = orderedValues(
        "while true; do set A; done; echo done",
        "label",
        labelTracker,
      );
      assert.equal(out.at(-1)?.[1], "initial");
    });

    it("case items all agree → propagate", () => {
      const out = orderedValues(
        "case $x in a) set Z ;; b) set Z ;; esac; echo done",
        "label",
        labelTracker,
      );
      assert.equal(out.at(-1)?.[1], "Z");
    });

    it("case items disagree → fall back to pre-case value", () => {
      const out = orderedValues(
        "case $x in a) set A ;; b) set B ;; esac; echo done",
        "label",
        labelTracker,
      );
      assert.equal(out.at(-1)?.[1], "initial");
    });

    it("per-tracker branch merge: one tracker's branches agree, another's disagree, fallback is per-tracker", () => {
      // A synthetic tracker whose sequential `mark X` modifier sets the
      // current value to X. Shares no basename with cwd.
      const labelTracker: Tracker<string> = {
        initial: "pre",
        unknown: "unknown",
        modifiers: {
          mark: {
            scope: "sequential",
            apply: (args) => args[0]?.value,
          },
        },
      };

      // `if`: both branches `cd /agreed` (cwd agrees at /agreed) but the
      // `then` branch marks "A" and the `else` branch marks "B" (label
      // disagrees). After the if, `ls`:
      //   cwd.ls  === "/agreed"   (branches agree → propagated)
      //   label.ls === "pre"       (branches disagree → pre-if fallback)
      const ast = parseBash(
        "if test -f x; then cd /agreed && mark A; else cd /agreed && mark B; fi\nls",
      );
      const refs = extractAllCommandsFromAST(ast, "");
      const result = walk(
        ast,
        { cwd: "/start", label: "pre" },
        { cwd: cwdTracker, label: labelTracker },
        refs,
      );

      const ls = refs.find((r) => getBasename(r) === "ls");
      assert.ok(ls);
      assert.equal(
        result.get(ls!)?.cwd,
        "/agreed",
        "cwd tracker propagates because branches agree on the final cwd",
      );
      assert.equal(
        result.get(ls!)?.label,
        "pre",
        "label tracker falls back to pre-if value because branches disagree",
      );
    });
  });

  describe("caller-supplied refs[]", () => {
    it("keys the result Map with caller refs (identity-preserving)", () => {
      const raw = "set X && echo done";
      const ast = parseBash(raw);
      const externalRefs = extractAllCommandsFromAST(ast, raw);
      const map = walk(ast, {}, { label: labelTracker }, externalRefs);
      for (const ref of externalRefs) {
        assert.ok(
          map.has(ref),
          `map should contain external ref ${getBasename(ref)}`,
        );
      }
    });
  });

  describe("commands with no registered modifier", () => {
    it("pass through with the threaded value unchanged", () => {
      // `nothing-here` has no modifier in counterTracker — value is
      // whatever the sequential trackers have threaded to that point.
      const out = orderedValues(
        "inc && nothing-here && inc",
        "counter",
        counterTracker,
      );
      assert.deepEqual(out, [
        ["inc", 0],
        ["nothing-here", 1],
        ["inc", 1],
      ]);
    });
  });

  describe("modifier can be provided as an array", () => {
    it("array of modifiers is applied left-to-right", () => {
      const multiTracker: Tracker<number> = {
        initial: 0,
        unknown: -1,
        modifiers: {
          bump: [
            {
              scope: "sequential",
              apply: (_args, current) => current + 1,
            } satisfies Modifier<number>,
            {
              scope: "sequential",
              apply: (_args, current) => current * 10,
            } satisfies Modifier<number>,
          ],
        },
      };
      const out = orderedValues("bump && bump", "n", multiTracker);
      // Each `bump` does: current + 1, then * 10. Starting from 0:
      //   first bump: (0 + 1) * 10 = 10 (recorded pre-sequential = 0)
      //   second bump: (10 + 1) * 10 = 110 (recorded pre-sequential = 10)
      assert.deepEqual(out, [
        ["bump", 0],
        ["bump", 10],
      ]);
    });
  });
});

describe("isStaticallyResolvable", () => {
  it("pure literal is resolvable", () => {
    const ast = parseBash("echo hello");
    const cmd = ast.commands[0] as any;
    // Navigate Statement → Command.
    const w = cmd.command.suffix[0];
    assert.equal(isStaticallyResolvable(w), true);
  });

  it("$VAR is NOT resolvable", () => {
    const ast = parseBash("echo $VAR");
    const cmd = ast.commands[0] as any;
    const w = cmd.command.suffix[0];
    assert.equal(isStaticallyResolvable(w), false);
  });

  it("$(cmd) is NOT resolvable", () => {
    const ast = parseBash("echo $(pwd)");
    const cmd = ast.commands[0] as any;
    const w = cmd.command.suffix[0];
    assert.equal(isStaticallyResolvable(w), false);
  });

  it("single-quoted literal is resolvable", () => {
    const ast = parseBash("echo 'hi-$VAR'");
    const cmd = ast.commands[0] as any;
    const w = cmd.command.suffix[0];
    assert.equal(isStaticallyResolvable(w), true);
  });

  it("double-quoted with embedded expansion is NOT resolvable", () => {
    const ast = parseBash('echo "hi-$VAR"');
    const cmd = ast.commands[0] as any;
    const w = cmd.command.suffix[0];
    assert.equal(isStaticallyResolvable(w), false);
  });

  it("undefined word is resolvable (no arg to worry about)", () => {
    assert.equal(isStaticallyResolvable(undefined), true);
  });
});
