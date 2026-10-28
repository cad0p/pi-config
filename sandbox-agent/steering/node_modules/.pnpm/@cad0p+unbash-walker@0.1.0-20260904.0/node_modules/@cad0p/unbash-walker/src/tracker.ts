// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Tracker API — extensible walker state registry.
 *
 * The walker today needs to model four kinds of state modification, each
 * triggered by a command basename:
 *
 *   - `cd DIR` — shell-level cwd change, propagates forward (sequential).
 *   - `git -C DIR subcmd` — per-invocation cwd override for git only
 *     (per-command).
 *   - `env -C DIR cmd`, `make -C DIR target` — same per-command pattern.
 *   - `git checkout X` — branch state change, propagates forward (planned
 *     via the git plugin; the walker itself does not know about it).
 *
 * All four are "state modifications keyed by command basename". This module
 * unifies them under a single registry: callers declare a map of named
 * trackers, the walker threads each tracker's state through the script, and
 * every extracted command gets a snapshot of every tracked dimension.
 *
 * See the accepted ADR (linked from PR #2's description) for the full
 * design rationale — section "Design" → "Tracker API — extensible walker
 * state registry".
 */

import type {
  AndOr,
  AssignmentPrefix,
  BraceGroup,
  Command,
  CompoundList,
  Node,
  Pipeline,
  Script,
  Statement,
  Subshell,
  Word,
  WordPart,
} from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import type { CommandRef } from "./types.ts";

/**
 * How a subshell boundary affects a tracker dimension.
 *
 *   - `"isolated"` (default): the subshell body sees the parent scope's
 *     current value, but any changes made inside the body do NOT escape
 *     back to the outer scope. Correct for cwd (real bash semantics) and
 *     for branch (a subshell can't change the enclosing repo's branch).
 *   - `"global"`: changes cross subshell boundaries. Reserved for future
 *     use; no built-in tracker uses this today.
 */
export type SubshellSemantics = "isolated" | "global";

/**
 * How a modifier's effect propagates to subsequent commands.
 *
 *   - `"sequential"`: the modifier updates the tracker's current value,
 *     which then propagates to every later sibling command in the same
 *     scope. Use for shell-level state changes (`cd`, `git checkout`,
 *     future `pushd`/`popd`).
 *   - `"per-command"`: the modifier applies to the current command's
 *     recorded state only; the tracker's threaded value is unchanged for
 *     subsequent commands. Use for per-invocation overrides (`git -C DIR`,
 *     `env -C DIR`, `make -C DIR`).
 *
 * The walker applies both kinds during `handleCommand`: sequential first
 * (updates the value recorded AND threaded), per-command second (updates
 * ONLY the value recorded for this command).
 *
 * Discriminated union (not flattened interface). The two variants have
 * identical `apply` signatures today, but the union form leaves room for
 * scope-specific metadata in future revisions (e.g., per-command modifiers
 * declaring their flag vocabulary for smarter tokenization).
 *
 * The `apply` contract is the same across both variants:
 *
 * Given the command's argument words, the tracker's current value, and
 * a snapshot of every OTHER tracker's state at this ref (`allState`),
 * return the new value.
 *
 * `allState` is the cross-tracker-read protocol (D1 in Tier B of PR #5).
 * Modifiers that need to consult another dimension — e.g. cd reading env
 * to expand `$VAR` — use the second type parameter `TAll` to declare the
 * shape they need. Modifiers that don't read cross-tracker state ignore
 * the parameter and get the default `Record<string, unknown>` type.
 * Processing order within a single ref follows tracker registration
 * order: callers register `envTracker` before `cwdTracker` so cd's
 * modifier sees the current ref's env.
 *
 * Return `undefined` to signal "can't resolve statically" (e.g. the
 * target is a `$VAR` or `$(cmd)` whose runtime value we refuse to
 * invent). The walker responds to `undefined`:
 *
 *   - For `per-command` modifiers: the command's recorded value becomes
 *     the tracker's `unknown` sentinel; the threaded value is left
 *     unchanged (per-command overrides don't propagate anyway).
 *   - For `sequential` modifiers: the threaded value also becomes the
 *     `unknown` sentinel, so every subsequent command in this scope
 *     sees `unknown` and the walker stops trying to refine it further.
 *
 * `apply` must be pure — no I/O, no mutation of `args`, `current`, or
 * `allState`.
 */
export type Modifier<
  T,
  TAll extends Record<string, unknown> = Record<string, unknown>,
> =
  | {
      /** Propagates to this command AND all subsequent sibling commands.
       *  Example: `cd DIR`, `git checkout X`. */
      scope: "sequential";
      // Method syntax (`apply(...)`) keeps TAll BIVARIANT for parameter
      // type compatibility. Under strict mode an arrow-typed `apply` on
      // a narrower TAll isn't assignable to a wider TAll, even though the
      // walker always passes the full outer state object and the narrow
      // modifier simply reads a subset. Bivariance here matches the
      // runtime contract — modifiers requesting narrower allState still
      // satisfy the Tracker.modifiers storage type.
      apply(
        args: readonly Word[],
        current: T,
        allState: Readonly<TAll>,
      ): T | undefined;
    }
  | {
      /** Applies to this command only; caller's next-command state is unchanged.
       *  Example: `git -C DIR subcmd`, `env -C DIR cmd`, `make -C DIR target`. */
      scope: "per-command";
      apply(
        args: readonly Word[],
        current: T,
        allState: Readonly<TAll>,
      ): T | undefined;
    };

/**
 * A named dimension of walker state.
 *
 * Each tracker defines an initial value, a sentinel for unresolvable values,
 * and a set of modifiers keyed by command basename. A basename may appear
 * in multiple trackers (e.g. `git` modifies both the `cwd` and a future
 * `branch` tracker).
 *
 * Tracker name collision (two plugins registering the same tracker name)
 * is a hard error; the walker itself is unopinionated here, but consumers
 * wiring plugins together should fail at load time.
 */
export interface Tracker<T> {
  /**
   * Value used when no explicit entry for this tracker is present in
   * `initialState`. Pure documentation / placeholder for built-in
   * trackers — in practice callers almost always pass an explicit
   * `initialState.<name>` (session cwd, current branch, …).
   */
  initial: T;

  /**
   * Sentinel value emitted when a modifier returns `undefined` (the
   * tracker can't resolve statically). Consumers check for this value
   * to apply their `onUnknown: "allow" | "block"` policy on predicates.
   */
  unknown: T;

  /**
   * Modifiers keyed by command basename. When the walker visits a
   * command, it looks up `modifiers[basename]` in every registered
   * tracker and applies each matching modifier.
   *
   * A single basename may map to either one modifier or an array of
   * modifiers (e.g. `git` has a per-command `-C` modifier today, plus a
   * future sequential `checkout` modifier in the git plugin). When an
   * array is given, modifiers are applied left-to-right.
   */
  modifiers: Record<string, Modifier<T> | Modifier<T>[]>;

  /**
   * How subshell boundaries affect this tracker. Defaults to `"isolated"`
   * (the safe and correct choice for every built-in dimension).
   */
  subshellSemantics?: SubshellSemantics;
}

/**
 * Result of a `walk` call: for each command ref, a snapshot of every
 * registered tracker's value AT THE COMMAND'S POSITION. The snapshot is a
 * plain object keyed by tracker name; consumers read whichever fields they
 * care about.
 *
 * Keys are CommandRef objects (same identity as the caller-supplied refs,
 * if any, matched by `.node` identity).
 */
export type WalkResult<T extends Record<string, unknown>> = Map<CommandRef, T>;

/**
 * Walk the script, threading each tracker's state through the AST and
 * recording a per-command snapshot for every extracted command.
 *
 * Semantics modelled (same as the original effectiveCwd walker, generalized
 * over the tracker map):
 *
 *   - Sequential modifiers update the tracker's threaded value in the
 *     current scope; the new value propagates forward to subsequent sibling
 *     commands.
 *   - Per-command modifiers update ONLY the command's recorded snapshot;
 *     the threaded value is unchanged.
 *   - Pipelines (`A | B`): each peer runs in its own subshell — no
 *     propagation across peers or back to the outer scope.
 *   - Subshells (`(A; B)`): respect each tracker's `subshellSemantics`.
 *     Default `"isolated"` — the body sees the outer value but changes
 *     don't escape. `"global"` is reserved for future use.
 *   - BraceGroups (`{ A; B; }`): sequential changes DO propagate out.
 *   - Control flow (if / while / for / select / case): conservative merge.
 *     For constructs with exactly-one-of-N branches (if, case), propagate
 *     a tracker's value forward only if every branch agrees on the same
 *     value; otherwise fall back to the pre-construct value. For
 *     constructs whose body may run zero times (while, for, select),
 *     never propagate the body's changes.
 *
 * If `refs` is provided, the returned Map's keys are those exact refs
 * (matched by `.node` identity). Otherwise, the walker allocates fresh
 * refs via `extractAllCommandsFromAST`.
 *
 * @typeParam T - shape of the tracker state map, e.g. `{ cwd: string }`.
 * @param script - unbash AST to walk.
 * @param initialState - starting values for each tracker; any missing key
 *   falls back to that tracker's `initial`. Typically callers pass all
 *   fields they care about explicitly (e.g. the session cwd from pi).
 * @param trackers - registry of named trackers to thread through the walk.
 * @param refs - optional CommandRef[] to reuse as Map keys.
 */
export function walk<T extends Record<string, unknown>>(
  script: Script,
  initialState: Partial<T>,
  trackers: { readonly [K in keyof T]: Tracker<T[K]> },
  refs?: readonly CommandRef[],
): WalkResult<T> {
  const ownRefs = refs ?? extractAllCommandsFromAST(script, "");

  // Seed the initial state: for every tracker, take the caller's override
  // if present, otherwise fall back to the tracker's declared `initial`.
  const state = {} as T;
  for (const name of Object.keys(trackers) as Array<keyof T>) {
    const seeded = initialState[name];
    state[name] = (
      seeded !== undefined ? seeded : trackers[name].initial
    ) as T[typeof name];
  }

  const byNode = new Map<Command, T>();
  walkNode<T>(script, state, trackers, byNode);

  const result: WalkResult<T> = new Map();
  for (const ref of ownRefs) {
    const snap = byNode.get(ref.node);
    if (snap !== undefined) result.set(ref, snap);
  }
  return result;
}

/**
 * Walk a node, recording each Command's snapshot into `byNode`, and
 * return the state that results after executing the node (to let the
 * caller thread sequential changes through a sequence).
 *
 * Generalizes the original private `walk` in effective-cwd.ts from a single
 * `cwd: string` value to an arbitrary `T extends Record<string, unknown>`.
 */
function walkNode<T extends Record<string, unknown>>(
  node: Script | Node | undefined,
  state: T,
  trackers: { readonly [K in keyof T]: Tracker<T[K]> },
  byNode: Map<Command, T>,
): T {
  if (!node) return state;

  switch (node.type) {
    case "Script":
    case "CompoundList":
      return walkSequence<T>(
        (node as Script | CompoundList).commands,
        state,
        trackers,
        byNode,
      );

    case "Statement":
      return walkNode<T>((node as Statement).command, state, trackers, byNode);

    case "AndOr":
      return walkSequence<T>((node as AndOr).commands, state, trackers, byNode);

    case "Pipeline":
      // Each peer runs in its own subshell; no propagation across peers
      // or back to the outer scope.
      for (const peer of (node as Pipeline).commands) {
        walkNode<T>(peer, state, trackers, byNode);
      }
      return state;

    case "Subshell":
      // Subshell body: every tracker's `subshellSemantics` governs whether
      // changes escape. "isolated" is the default (and correct for cwd,
      // branch, and every built-in dimension). "global" would let changes
      // out — reserved for future use.
      return walkSubshell<T>((node as Subshell).body, state, trackers, byNode);

    case "BraceGroup":
      // Brace group: sequential changes DO propagate.
      return walkNode<T>((node as BraceGroup).body, state, trackers, byNode);

    case "Command":
      return handleCommand<T>(node as Command, state, trackers, byNode);

    case "If": {
      const n = node as Extract<Node, { type: "If" }>;
      const clauseState = walkNode<T>(n.clause, state, trackers, byNode);
      const thenState = walkNode<T>(n.then, clauseState, trackers, byNode);
      const elseState = n.else
        ? walkNode<T>(n.else, clauseState, trackers, byNode)
        : clauseState;
      return mergeBranches<T>(trackers, clauseState, [thenState, elseState]);
    }

    case "While": {
      const n = node as Extract<Node, { type: "While" }>;
      const clauseState = walkNode<T>(n.clause, state, trackers, byNode);
      // Body may run zero or more times. Walk it so inner commands get
      // recorded, but don't propagate the body's changes forward.
      walkNode<T>(n.body, clauseState, trackers, byNode);
      return clauseState;
    }

    case "For":
    case "Select": {
      const n = node as Extract<Node, { type: "For" | "Select" }>;
      walkNode<T>(n.body, state, trackers, byNode);
      return state;
    }

    case "Case": {
      const n = node as Extract<Node, { type: "Case" }>;
      const itemStates = n.items.map((item) =>
        walkNode<T>(item.body, state, trackers, byNode),
      );
      if (itemStates.length === 0) return state;
      return mergeBranches<T>(trackers, state, itemStates);
    }

    case "Function":
      // A function definition doesn't change state. We don't descend — it
      // only runs when called, and callers may invoke it anywhere.
      return state;

    default:
      // Coproc, TestCommand, Arithmetic*, etc. — no state effects modelled.
      return state;
  }
}

/** Walk a sequence of nodes threading state left-to-right. */
function walkSequence<T extends Record<string, unknown>>(
  nodes: readonly Node[],
  state: T,
  trackers: { readonly [K in keyof T]: Tracker<T[K]> },
  byNode: Map<Command, T>,
): T {
  let s = state;
  for (const n of nodes) {
    s = walkNode<T>(n, s, trackers, byNode);
  }
  return s;
}

/**
 * Walk a subshell body. For each tracker, respect its `subshellSemantics`:
 * `"isolated"` (default) — the outer state is preserved; `"global"` — the
 * body's changes escape. We support both by walking the body with a fresh
 * copy of the outer state, then mixing the per-tracker result back in.
 */
function walkSubshell<T extends Record<string, unknown>>(
  body: Node | undefined,
  state: T,
  trackers: { readonly [K in keyof T]: Tracker<T[K]> },
  byNode: Map<Command, T>,
): T {
  if (!body) return state;
  const innerOut = walkNode<T>(body, { ...state }, trackers, byNode);
  // Start from the outer state; for any tracker declared "global", replace
  // with the subshell's final value. The outer state already carries the
  // pre-subshell values for "isolated" trackers.
  const out = { ...state } as T;
  for (const name of Object.keys(trackers) as Array<keyof T>) {
    const semantics = trackers[name].subshellSemantics ?? "isolated";
    if (semantics === "global") {
      out[name] = innerOut[name];
    }
  }
  return out;
}

/**
 * Merge multiple branch outcomes (from if/case) conservatively: for each
 * tracker, propagate the common value only if every branch agrees;
 * otherwise fall back to the pre-construct value.
 */
function mergeBranches<T extends Record<string, unknown>>(
  trackers: { readonly [K in keyof T]: Tracker<T[K]> },
  fallback: T,
  branches: readonly T[],
): T {
  if (branches.length === 0) return fallback;
  const out = {} as T;
  for (const name of Object.keys(trackers) as Array<keyof T>) {
    const first = branches[0]![name];
    const allAgree = branches.every((b) => b[name] === first);
    out[name] = allAgree ? first : fallback[name];
  }
  return out;
}

/**
 * Apply every registered tracker's modifiers to a single Command.
 *
 * Sequential modifiers update the tracker's threaded value (propagating
 * to subsequent sibling commands); per-command modifiers update only the
 * value recorded for this command. We record the *pre-sequential* value
 * for a command that is itself a sequential modifier — matching the
 * original effectiveCwd behavior where `cd /x` is recorded at the pre-cd
 * cwd, and `cmd` on the next line is recorded at `/x`.
 *
 * Cross-tracker reads via `allState`: every modifier receives a
 * read-only snapshot of the pre-ref state of every registered tracker
 * as its third argument (D1 in Tier B of PR #5). All modifiers at a
 * single ref see the same `state` snapshot, so registration order
 * only matters for ambiguous composition (e.g. a future `export`
 * modifier that also updates cwd); for the built-in env + cwd pair,
 * env goes first so cd's `$VAR` expansion reads env's current value.
 */
function handleCommand<T extends Record<string, unknown>>(
  node: Command,
  state: T,
  trackers: { readonly [K in keyof T]: Tracker<T[K]> },
  byNode: Map<Command, T>,
): T {
  const basename = commandBasename(node);
  // Bare-assignment command (basename "" + non-empty prefix): the shell
  // treats `FOO=bar` as a stand-alone statement that mutates the env.
  // unbash parses this as a Command with no `name` and a non-empty
  // `prefix`. We synthesize per-assignment Words from the prefix so
  // trackers registered on basename "" (e.g. envTracker) can apply them
  // uniformly through the same `apply(args, current, allState)` path as
  // every other modifier. Prefix assignments attached to a real command
  // (`FOO=bar cmd`) are NOT routed here — those belong to the
  // per-command scope surfaced via `input.envAssignments` at the
  // evaluator, not to the shell-state env tracker.
  const args: readonly Word[] =
    basename === "" && node.prefix.length > 0 && node.suffix.length === 0
      ? synthesizeAssignmentWords(node.prefix)
      : node.suffix;

  // All modifiers at this ref see the same pre-ref snapshot. Typing the
  // shared `allState` parameter as `Readonly<T>` keeps callers honest;
  // modifiers declaring a narrower `TAll` via the second type parameter
  // are assignable from this wider shape at their call sites.
  const allState = state as Readonly<T>;

  // Per-tracker: compute the pre-command value (= sequential applied) and
  // the recorded value (= per-command applied on top). Sequential updates
  // also flow back into the returned state so subsequent commands see them.
  const recorded = {} as T;
  const next = {} as T;
  for (const name of Object.keys(trackers) as Array<keyof T>) {
    const tracker = trackers[name];
    const current = state[name] as T[typeof name];
    const mods =
      basename !== undefined ? tracker.modifiers[basename] : undefined;
    const modList: Modifier<T[typeof name]>[] | undefined = mods
      ? Array.isArray(mods)
        ? (mods as Modifier<T[typeof name]>[])
        : [mods as Modifier<T[typeof name]>]
      : undefined;

    // 1. We want the command's RECORDED value to be `current` (pre-
    //    sequential), so that a `cd /x` is recorded at the pre-cd cwd.
    //    Per-command modifiers still layer on top of that recorded value.
    let recordedValue: T[typeof name] = current;
    if (modList) {
      for (const mod of modList) {
        if (mod.scope !== "per-command") continue;
        const res = mod.apply(args, recordedValue, allState);
        if (res === undefined) {
          recordedValue = tracker.unknown as T[typeof name];
          // Stop layering further per-command modifiers: once the
          // recorded value is "unknown", additional per-command
          // overrides can't sharpen it.
          break;
        }
        recordedValue = res;
      }
    }
    recorded[name] = recordedValue;

    // 2. Sequential modifiers update the THREADED value — what sibling
    //    commands after this one will see.
    let threaded: T[typeof name] = current;
    if (modList) {
      for (const mod of modList) {
        if (mod.scope !== "sequential") continue;
        const res = mod.apply(args, threaded, allState);
        if (res === undefined) {
          threaded = tracker.unknown as T[typeof name];
          break;
        }
        threaded = res;
      }
    }
    next[name] = threaded;
  }

  byNode.set(node, recorded);
  return next;
}

/**
 * Synthesize one Word per assignment-prefix entry, carrying the raw
 * `NAME=VALUE` source text plus a concatenated `parts` array that
 * reflects the RHS's static-ness.
 *
 * Why synthesize: the walker dispatches modifiers by basename with
 * `args = node.suffix`. Bare-assignment commands have an empty suffix
 * — the assignment payload lives on `node.prefix` (AssignmentPrefix[]).
 * Reshaping the prefix entries into Word[] lets trackers registered on
 * basename "" consume them through the same `apply(args, ...)` surface
 * as every other modifier, keeping the Tracker API uniform.
 *
 * Parts concatenation:
 *   - Literal `"NAME="` prefix (so `isStaticallyResolvable` accounts for
 *     the name),
 *   - followed by every part of `prefix.value` (if present) —
 *     preserving whether the RHS is literal, single-quoted,
 *     parameter-expanded, command-substituted, etc.
 *
 * If `prefix.value` is undefined (`FOO=`), the synthetic parts are
 * `[Literal("NAME=")]` — a trivially-static empty-value assignment.
 * If `prefix.value` has no parts (pure literal), we still emit the
 * Literal-prefix + Literal-value shape so `isStaticallyResolvable`
 * (which returns `true` on empty-parts) produces a consistent answer.
 */
function synthesizeAssignmentWords(
  prefix: readonly AssignmentPrefix[],
): readonly Word[] {
  const out: Word[] = [];
  for (const p of prefix) {
    // Skip compound-assignment shapes that the parser flags but the
    // env tracker doesn't model (Tier B correctness fixes H2/H3/H4):
    //
    //   - `FOO+=append` (`p.append === true`) — append op. The
    //     previous code silently REPLACED FOO with the RHS
    //     (synthesizing `FOO=append`), losing the existing value.
    //     Skip for now; a follow-up can handle true append semantics
    //     by reading `allState.env` once multi-hop env resolution
    //     lands (v0.2 deferred per env.ts's module header).
    //   - `FOO=(a b c)` array init (`p.array !== undefined`, `p.value
    //     === undefined`). Previously surfaced as
    //     `{name: "FOO", value: ""}` — an empty scalar that spuriously
    //     flipped `env.has("FOO")` predicates. We don't track bash
    //     arrays; skip.
    //   - `FOO[0]=value` array-index assignment (`p.index !== undefined`).
    //     Previously wrote to the scalar FOO; bash would write to the
    //     array slot instead. Skip — we don't track arrays.
    if (p.append === true) continue;
    if (p.array !== undefined) continue;
    if (p.index !== undefined) continue;
    const name = p.name ?? "";
    const leader: WordPart = {
      type: "Literal",
      value: `${name}=`,
      text: `${name}=`,
    };
    const valueParts: readonly WordPart[] = p.value
      ? // Value has sub-parts: preserve them so parameter expansion,
        // command substitution, etc. remain visible to
        // `isStaticallyResolvable`.
        p.value.parts && p.value.parts.length > 0
        ? p.value.parts
        : [
            {
              type: "Literal",
              value: p.value.value,
              text: p.value.text,
            },
          ]
      : [];
    out.push({
      text: p.text,
      value: p.text,
      pos: p.pos,
      end: p.end,
      parts: [leader, ...valueParts],
    });
  }
  return out;
}

/** Return the command's basename (e.g. `/usr/bin/git` → `git`), or "". */
function commandBasename(node: Command): string {
  const name = node.name?.value;
  if (!name) return "";
  // Avoid requiring `node:path` here — path.basename handles separators
  // based on the platform, but command basenames are POSIX-shaped. Cheap
  // manual split matches `path.posix.basename` semantics on the values we
  // care about (no Windows path munging).
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * True if this word's value can be determined from the source text alone
 * (no runtime expansion). Pure literals and single-quoted strings qualify.
 * Double-quoted strings qualify only if every inner part is itself static.
 *
 * ParameterExpansion / CommandExpansion / ArithmeticExpansion /
 * SimpleExpansion (`$VAR`) / ProcessSubstitution / BraceExpansion /
 * ExtendedGlob / ANSI-C / LocaleString etc. are all treated as
 * unresolvable — we do not invent values for them.
 *
 * Exposed for tracker modifier authors: return `undefined` from `apply`
 * whenever a relevant argument is not statically resolvable, and the
 * walker will substitute the tracker's `unknown` sentinel.
 */
export function isStaticallyResolvable(w: Word | undefined): boolean {
  if (!w) return true;
  if (!w.parts || w.parts.length === 0) return true;
  return w.parts.every(isStaticPart);
}

function isStaticPart(p: WordPart): boolean {
  if (p.type === "Literal") return true;
  if (p.type === "SingleQuoted") return true;
  if (p.type === "DoubleQuoted") {
    return (p.parts ?? []).every((child) => isStaticPart(child as WordPart));
  }
  return false;
}
