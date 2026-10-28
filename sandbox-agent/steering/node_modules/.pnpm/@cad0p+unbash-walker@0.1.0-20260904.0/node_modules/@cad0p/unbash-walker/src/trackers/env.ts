// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Built-in env tracker — walker state for shell variable assignments
 * the walker can statically resolve.
 *
 * Scope (v0.1.0):
 *
 *   - ✅ Bare assignment as its own command: `FOO=value`
 *   - ✅ `export FOO=value`
 *   - ✅ `unset FOO`
 *   - ✅ Seeded from `process.env.HOME`, `process.env.USER`,
 *        `process.env.PWD` at tracker initialization (so `cd ~`
 *        and `cd "$HOME/x"` resolve on the first walk).
 *   - ❌ `readonly FOO=value` — attribute-bearing, deferred.
 *   - ❌ `local FOO=value` — function scope not modelled.
 *   - ❌ `declare` / `typeset` — attribute semantics deferred.
 *   - ❌ `source` / `.` — opaque file inclusion.
 *   - ❌ Function-body walking — function definitions don't execute.
 *   - ❌ Compound assignment shapes (skipped at the parser-prefix
 *        synthesis step in `tracker.ts:synthesizeAssignmentWords`):
 *        - `FOO+=value` (append) — no-op; a future version may read
 *          `allState.env` and do `env.set(NAME, old + value)` once
 *          multi-hop env resolution lands.
 *        - `FOO=(a b c)` (array init) — we don't track bash arrays;
 *          skipped so scalar FOO is untouched.
 *        - `FOO[0]=value` (array-index assignment) — same.
 *
 * The full deferred-scope rationale lives in the file-level
 * header above and the per-class notes on each modifier below,
 * including the trigger criteria for graduating each class out
 * of "deferred" into a future `pi-steering-env` plugin or a
 * v0.1.x additive extension.
 *
 * Subshell semantics: `"isolated"` — matches bash, where env
 * changes inside `(A; B)` don't escape to the outer scope. The
 * walker handles this generically via `subshellSemantics` on
 * every tracker.
 *
 * Prefix assignments (`FOO=bar cmd`) are NOT handled here: those
 * are one-shot env for that single command, not a shell-state
 * mutation. The evaluator's `PredicateToolInput.envAssignments`
 * surface already exposes them per-ref; plugin predicates read
 * that directly.
 */

import type { Word } from "unbash";
import { isIdentifierName } from "../internal/identifier.ts";
import { seedProcessEnv } from "../internal/seed-process-env.ts";
import { expandTildeIfLeading, resolveWord } from "../resolve-word.ts";
import type { Modifier, Tracker } from "../tracker.ts";

/**
 * Shape of the env tracker's state: a read-only map from variable
 * name to its statically-resolved value. `ReadonlyMap` so consumers
 * can hand it to plugin predicates without worrying about
 * accidental mutation.
 */
export type EnvState = ReadonlyMap<string, string>;

/**
 * Resolve a synthesized assignment Word (shape: Literal("NAME=") +
 * RHS parts) into `{ name, value }`. Returns `undefined` when:
 *   - the word's RHS isn't statically resolvable (dynamic value),
 *   - the word doesn't conform to the `NAME=VALUE` shape,
 *   - or NAME is not a valid bash identifier.
 *
 * Uses {@link resolveWord} to concatenate the synthesized parts,
 * which correctly unquotes double-quoted values and rejects
 * parameter expansions. The result is then split on the FIRST
 * `=` — same splitting rule as raw token parsing, but applied
 * after static resolution so `FOO="value with=sign"` resolves
 * to name="FOO" / value="value with=sign" cleanly.
 *
 * Tilde expansion in the RHS (issue #13): bash expands a leading
 * `~` after the `=` in assignments (`VAULT=~/x` → `$HOME/x`), but
 * NOT when it is quoted (`VAULT="~/x"` stays literal).
 * `resolveWord` strips quotes, so by the time the resolved string
 * reaches this function the "was it quoted?" information is lost
 * — instead we re-apply quote awareness on the ORIGINAL word's
 * parts (see {@link expandAssignmentValueTilde}).
 */
function resolveAssignmentWord(
  word: Word,
  env: EnvState,
): { name: string; value: string } | undefined {
  const resolved = resolveWord(word, env);
  if (resolved === undefined) return undefined;
  const parsed = parseAssignmentToken(resolved);
  if (parsed === undefined) return undefined;
  const value = expandAssignmentValueTilde(word, parsed.value, env);
  if (value === undefined) return undefined;
  return { name: parsed.name, value };
}

/**
 * Bash-faithful tilde expansion of an assignment RHS, applied
 * AFTER the split on the first `=` (issue #13).
 *
 * The expansion gate is three-layered:
 *
 *   - **Raw-text** (issue #16, checked first): bash decides tilde
 *     expansion on the raw token before backslash removal, so the raw
 *     RHS (from `word.text`) must itself be a bare `~` or start with
 *     `~/`. `VAULT=~\/x` (raw `~\`) stays literal even though the
 *     resolved value looks like `~/x` on unbash v4. The literal keeps
 *     bash-exact quote removal (`~\/x` → `~/x`) on both v3 and v4.
 *
 *   - **Value-level** (mirrors bash's rule): expand only when the
 *     value is a bare `~` or starts with `~/`. `~$X` (tilde
 *     followed by a variable) stays literal in bash (`~bin`) —
 *     excluded. `~user/x` and escaped-tilde shapes (`~\/x`) are
 *     excluded too — `expandTildeIfLeading` returns them
 *     unchanged, and the value-level gate skips them outright.
 *   - **Quote-aware** (AST-level): `resolveWord` already unquoted
 *     the value, so a quoted `"~/x"` would LOOK expandable on the
 *     resolved string alone. Quoted tildes arrive as
 *     DoubleQuoted / SingleQuoted parts (never a bare Literal), so
 *     the first RHS part must be a bare `Literal` for the
 *     expansion to apply. Every bare-assignment synthesis emits a
 *     second part (even `FOO=` → Literal("")), so the partless
 *     branch is export-only; there quoting is ABSENT BY
 *     CONSTRUCTION (any quote in the source makes the parser emit
 *     parts), so expanding the leading `~` on the raw token is
 *     safe.
 *
 * The tilde-bearing PREFIX of the value must be a contiguous run
 * of bare-Literal parts — a quoted tilde ANYWHERE before the
 * first `/` keeps the value literal (`VAULT=~"x"` and
 * `VAULT="~"x` stay literal, matching bash). Only the final
 * (typically single) bare-Literal prefix part may carry the `~`;
 * every part before it must also be a bare Literal so a quoted
 * prefix (`VAULT="~"x`) cannot smuggle a tilde past the gate.
 *
 * Returns `undefined` when HOME is absent and the value would
 * expand — the assignment is discarded, mirroring the fail-closed
 * `FOO=$UNDEFINED` skip (env.has(NAME) stays false).
 */
function expandAssignmentValueTilde(
  word: Word,
  value: string,
  env: EnvState,
): string | undefined {
  // Raw-text tilde gate (issue #16): bash decides tilde expansion on
  // the RAW token BEFORE backslash removal, so `VAULT=~\/x` (tilde
  // followed by `\`, not `/`) must NOT expand — even though unbash
  // v4 correctly strips the backslash in `Word.value` (upstream fix
  // webpro-nl/unbash@5f8bbee48), making the resolved `~/x` LOOK
  // expandable. The raw RHS (from `word.text` up to the first `=`,
  // which the bare-assignment synthesis preserves verbatim as `p.text`
  // and export words carry as their raw token) must itself be a bare
  // `~` or start with `~/`; otherwise keep the resolved value literal.
  // Bash still performs quote removal on the literal (`~\/x` → `~/x`,
  // verified: `HOME=/home/me bash -c 'VAULT=~\/x; …'` → `<~/x>`) —
  // v4 already strips it, v3 preserves it (upstream bug), so drop that
  // single escape here for the `~\` shape so BOTH yield bash-exact
  // `~/x`. Fail-closed: when the raw text is unavailable, fall through
  // to the pre-existing gates below (unchanged behavior).
  const rawToken = word.text;
  if (rawToken !== undefined) {
    const eq = rawToken.indexOf("=");
    const rawRhs = eq === -1 ? rawToken : rawToken.slice(eq + 1);
    if (!(rawRhs === "~" || rawRhs.startsWith("~/"))) {
      if (rawRhs.startsWith("~\\") && value.startsWith("~\\")) {
        return `~${value.slice(2)}`;
      }
      return value;
    }
  }

  if (!(value === "~" || value.startsWith("~/"))) return value;

  const parts = word.parts ?? [];
  // Bare-assignment synthesis emits parts[0] = Literal("NAME=") then
  // the RHS parts. The tilde-bearing PREFIX of the RHS must be a
  // contiguous run of bare-Literal parts: a quoted tilde anywhere
  // before the first `/` keeps the value literal (`VAULT=~"x"` and
  // `VAULT="~"x` stay literal, matching bash). parts[0] (the
  // `NAME=` leader) is part of that prefix, so every part up to and
  // including the first `~/`-carrying literal must be a bare Literal.
  // Parts AFTER the first `/` (e.g. the `$X` in `VAULT=~/$X`) are
  // not part of the tilde prefix and don't block expansion.
  //
  // Structural, not positional: scan the parts in order, summing
  // their UNQUOTED lengths (part.value — every part reaching this
  // point is a narrowed bare Literal) until we've covered the first
  // `/` in the
  // resolved value. Every part contributing to that prefix must be
  // a bare Literal.
  if (parts.length >= 2) {
    // Bare tilde (`~` alone, no slash) always expands when the RHS
    // is a single bare Literal after the leader.
    if (value === "~") {
      const rhs = parts.slice(1);
      if (rhs.length === 1 && rhs[0]?.type === "Literal") {
        return expandTildeIfLeading(value, env);
      }
      return value;
    }
    const slash = value.indexOf("/");
    if (slash === -1) return value;
    // The tilde sits at value offset 0 (after the `NAME=` leader is
    // stripped). Find the part that CARRIES the `~` — it must be a
    // bare Literal (a quoted name at parts[0] — `export 'VAULT'=~/x`
    // → [SingleQuoted("VAULT"), Literal("=~/x")] — ends the search
    // before the `~`, keeping the value literal, matching bash).
    // From that part, the contiguous run of bare Literals must reach
    // STRICTLY PAST the first `/` (the `/` belongs to a Literal part
    // only if that part also contributes content after it). Quoted
    // parts anywhere before the `/` — `VAULT="~/x"`, `VAULT=~"x"`,
    // `VAULT="~"x` — end the run and keep the value literal.
    let tildeIdx = -1;
    let tildeOffset = 0; // value offset of the `~` within its part
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.type !== "Literal") break; // quoted name/leader ends it
      const v = p.value;
      const t = v.indexOf("~");
      if (t !== -1) {
        tildeIdx = i;
        tildeOffset = t;
        break;
      }
      tildeOffset += v.length;
    }
    if (tildeIdx === -1) return value;
    // Measure the run length from the `~` itself (value offset 0):
    // the tilde-bearing part contributes `len - tildeOffset`, later
    // Literals contribute fully. This keeps the comparison in the
    // value coordinate space even when the `=` sits inside the
    // tilde-carrying literal (`export VAULT=~/x` → parts
    // [Literal("VAULT=~"), …], tildeOffset 6).
    let runLen = 0;
    for (let i = tildeIdx; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.type !== "Literal") break;
      const v = p.value;
      runLen += i === tildeIdx ? v.length - tildeOffset : v.length;
    }
    // Strictly past the slash: `runLen > slash` (not `>=`) — a run
    // ending exactly AT the slash means the `/` is the first char of
    // a non-Literal part (`VAULT=~"/x"` → runLen 1 == slash 1).
    if (runLen <= slash) return value;
  } else if (parts.length !== 0) {
    // Unexpected shapes (e.g. export of a fully-quoted argument
    // `export 'VAULT=~/x'` → a single SingleQuoted part) — never
    // expand; the quoted tilde stays literal.
    return value;
  }
  // Partless word (`export VAULT=~/x` arrives as one raw token;
  // quoting absent by construction) or the synthesized
  // `[Literal("VAULT="), Literal("~/x")]` shape — expand.
  return expandTildeIfLeading(value, env);
}

// --------------------------------------------------------------------------
// Assignment parsing
// --------------------------------------------------------------------------

/**
 * Split a "NAME=VALUE" token into `{ name, value }`. Returns
 * `undefined` when the token is malformed or NAME isn't a valid
 * bash identifier.
 *
 * We deliberately accept only `NAME=VALUE` form. `NAME+=VALUE`
 * (append), `NAME[i]=VALUE` (array), and `NAME=(…)` (array init)
 * are deferred — they live in the same "not modelled" bucket as
 * `readonly` / `declare`.
 */
function parseAssignmentToken(
  raw: string,
): { name: string; value: string } | undefined {
  const eq = raw.indexOf("=");
  if (eq <= 0) return undefined;
  const name = raw.slice(0, eq);
  if (!isIdentifierName(name)) return undefined;
  const value = raw.slice(eq + 1);
  return { name, value };
}

/**
 * Build a new map from `current` with the given entry set.
 *
 * `ReadonlyMap` doesn't expose mutation, but we intentionally
 * construct a fresh `Map` so the new reference signals "state
 * changed" to downstream consumers (e.g. a future memoization
 * layer doing reference-equality diffs on per-ref state).
 */
function withSet(current: EnvState, name: string, value: string): EnvState {
  const next = new Map(current);
  next.set(name, value);
  return next;
}

function withDelete(current: EnvState, names: readonly string[]): EnvState {
  let changed = false;
  for (const n of names) {
    if (current.has(n)) {
      changed = true;
      break;
    }
  }
  if (!changed) return current;
  const next = new Map(current);
  for (const n of names) next.delete(n);
  return next;
}

// --------------------------------------------------------------------------
// Modifiers
// --------------------------------------------------------------------------

/**
 * Bare assignment: the "command" is an assignment-prefix-only
 * statement (`FOO=value`). In unbash's AST these appear as a Command
 * with `name === undefined` and a non-empty `prefix`. Routing them
 * into this modifier happens in {@link handleCommand} — the walker
 * synthesizes one Word per prefix entry (raw text `"NAME=VALUE"`,
 * `parts` concatenating `Literal("NAME=")` + the RHS's original
 * parts) so static-resolvability checks reflect dynamic RHS values
 * (`FOO=$VAR` → word resolves to `undefined`; `FOO=bar` → word
 * resolves to `"FOO=bar"`). The modifier registers on basename `""`
 * so the walker reaches it through the same basename-keyed dispatch
 * every other tracker uses.
 *
 * Multiple prefix assignments on one line — `A=1 B=2` — arrive
 * here as multiple synthetic Words. We process them in order so
 * both assignments land.
 *
 * Multi-hop values (`FOO=$BAR` where BAR was set earlier in the chain)
 * resolve against the modifier's threaded state. `resolveAssignmentWord`
 * receives the accumulating env (`next`), so each iteration sees
 * both prior-ref assignments (threaded via `current`) and same-call
 * prior-assignment effects (threaded via `next`). `A=1; B=$A; cmd`
 * ends with `env = {A:1, B:"1"}` at cmd.
 *
 * Dynamic values that can't be resolved — command substitution
 * (`FOO=$(pwd)`), arithmetic (`FOO=$((1+2))`), unknown vars
 * (`FOO=$UNDEFINED`) — produce `undefined` from `resolveWord`, which
 * the modifier reads as "not statically known, skip". The assignment
 * is discarded from the env map; env.has(NAME) is false.
 *
 * Double-quoted values (`FOO="some value"`) resolve through
 * `resolveWord` to their unquoted inner string (`"some value"`) —
 * the Word's inner `DoubleQuoted` part concatenates static child
 * parts to the unquoted value, matching the shell's own behavior.
 */
const bareAssignModifier: Modifier<EnvState> = {
  scope: "sequential",
  apply: (args, current) => {
    let next = current;
    for (const w of args) {
      const resolved = resolveAssignmentWord(w, next);
      if (resolved === undefined) continue;
      next = withSet(next, resolved.name, resolved.value);
    }
    return next;
  },
};

/**
 * `export NAME=VALUE` / `export NAME` / `export -p` / …
 *
 * We accept:
 *   - `export NAME=VALUE` → write to env map (same as bare).
 *   - `export NAME`       → no-op (we don't track the
 *                            exported-without-value attribute).
 *
 * Flags (`-n`, `-p`, `-f`) are skipped. `-n NAME` (un-export)
 * leaves the value in the env map — we model env presence, not
 * the exported-bit attribute.
 *
 * Dynamic values and dynamic names (`export "FOO=$BAR"`,
 * `export $NAME=x`) are no-ops.
 */
const exportModifier: Modifier<EnvState> = {
  scope: "sequential",
  apply: (args, current) => {
    let next = current;
    for (const w of args) {
      const raw = w.value;
      // Skip flags — bash's `export` accepts `-n`, `-p`, `-f`, `--`.
      // `-n NAME` takes the following arg but since we don't model
      // the exported-bit attribute, skipping the flag and NOT
      // consuming the next arg is the right call: `export -n FOO`
      // leaves FOO in the env map, matching our "presence only"
      // semantics.
      if (raw === "--") continue;
      if (raw.startsWith("-")) continue;
      // `export NAME=VALUE` — resolve through the shared static-word
      // helper so double-quoted values unquote correctly and dynamic
      // values skip cleanly. `export NAME` (bare export, no value)
      // produces a resolved string with no `=`, which
      // parseAssignmentToken rejects — matching our "we don't track
      // the exported-bit attribute" stance.
      const resolved = resolveAssignmentWord(w, next);
      if (resolved === undefined) continue;
      next = withSet(next, resolved.name, resolved.value);
    }
    return next;
  },
};

/**
 * `unset NAME [NAME2 ...]`
 *
 * Removes each statically-named var from the env map.
 *
 * Flag handling:
 *   - `-v NAME` (scalar-unset, the default) — skipped as a flag,
 *     NAME still consumed normally.
 *   - `-f NAME` (function-unset) — bash clears functions only and
 *     leaves the scalar NAME untouched. We short-circuit the entire
 *     modifier invocation on `-f` so the scalar env map survives;
 *     functions aren't tracked at all, so there's nothing to do.
 *   - `-x NAME` — bash errors; we accept and still process NAME.
 *     Fail-open here is consistent with the walker's "over-match on
 *     error chains is fine" stance for guardrail use.
 *
 * Dynamic names bail on that name only; other names in the same
 * command still apply.
 */
const unsetModifier: Modifier<EnvState> = {
  scope: "sequential",
  apply: (args, current) => {
    // If any arg is `-f`, bash's function-only unset applies. We
    // don't track functions — short-circuit so the scalar env is
    // untouched. This fixes a prior bug where `unset -f FOO` would
    // delete the scalar FOO alongside a phantom function clear.
    for (const w of args) {
      const raw = w.value;
      if (raw === "-f") return current;
    }
    const names: string[] = [];
    for (const w of args) {
      const raw = w.value;
      if (raw === "--") continue;
      // `-v`, `-x`: skip the flag, keep scanning. No consume-next.
      // `-f` handled above; we never reach this loop when it's present.
      if (raw.startsWith("-")) continue;
      // Resolve to reject dynamic names (`unset $VAR`) and single-
      // quoted forms alike via the shared helper. Double-quoted
      // literal names (`unset "FOO"`) unquote to valid identifiers
      // and are accepted.
      const resolved = resolveWord(w, current);
      if (resolved === undefined) continue;
      if (!isIdentifierName(resolved)) continue;
      names.push(resolved);
    }
    if (names.length === 0) return current;
    return withDelete(current, names);
  },
};

// --------------------------------------------------------------------------
// The tracker
// --------------------------------------------------------------------------

/**
 * Seed the initial env state from `process.env` at tracker
 * construction time. We pick the three keys agents most commonly
 * reference in chains — `HOME` (for `~` expansion), `USER` (for
 * user-scoped paths), `PWD` (for `$PWD/x` references). A caller
 * that wants different seeding (tests, sandboxed walks) can
 * override via `walk(…, { env: myMap }, …)` — the walker's
 * standard per-dimension seeding.
 */
function seedFromProcessEnv(): EnvState {
  return seedProcessEnv();
}

/**
 * The `unknown` sentinel for env state. Distinct frozen empty
 * map — consumers discriminate via reference equality
 * (`state === envTracker.unknown`), NOT structural emptiness (an
 * initial walk with no `HOME`/`USER`/`PWD` in the process also
 * produces an empty map, but one that MAY be mutated by
 * subsequent assignments).
 *
 * In practice the env tracker's modifiers never return
 * `undefined` — every modifier's handling of a dynamic arg is to
 * skip that arg and keep the rest (no-op for intractable names).
 * So `unknown` is declared for API completeness but not expected
 * to surface in normal walks. Kept here so a future modifier
 * that CAN signal "env fully scrambled" (e.g. a future `eval`
 * handler) has a well-typed sentinel to return.
 */
const UNKNOWN_ENV: EnvState = Object.freeze(new Map<string, string>());

/**
 * Built-in `env` tracker. Register alongside `cwdTracker` to get
 * `$VAR` / `${VAR}` / `~` expansion in cd targets. Plugin
 * predicates reading walker state can consult
 * `ctx.walkerState.env.get("NAME")` directly.
 *
 * Initial seeding pulls from `process.env.{HOME, USER, PWD}`.
 * Override via `walk(script, { env: new Map(...) }, { env:
 * envTracker })` for deterministic tests.
 */
export const envTracker: Tracker<EnvState> = {
  initial: seedFromProcessEnv(),
  unknown: UNKNOWN_ENV,
  modifiers: {
    // Bare-assignment commands have basename "". The walker
    // dispatches on `""` when node.name is absent and node.prefix
    // is non-empty (see handleCommand's bare-assignment branch).
    "": bareAssignModifier,
    export: exportModifier,
    unset: unsetModifier,
  },
  subshellSemantics: "isolated",
};
