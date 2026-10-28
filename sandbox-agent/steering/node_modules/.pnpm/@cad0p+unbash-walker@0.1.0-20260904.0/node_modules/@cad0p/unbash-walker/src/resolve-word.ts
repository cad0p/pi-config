// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Word resolution — two exported helpers, two modes:
 *
 * - {@link resolveWord} — **value-mode**: resolves a {@link Word}
 *   to the unquoted runtime string the shell would produce
 *   (`cd "$WS/pkg"` → `/workspace/pkg`). Quotes are stripped.
 *   Process substitution `<(…)` is intractable (the fd path is
 *   unknowable) → `undefined`, and consumers (cwd tracker,
 *   envTracker assignment-RHS resolution) fail closed.
 * - {@link resolveWordText} — **text-mode**: rebuilds the word's
 *   SOURCE TEXT with every expandable part replaced by its
 *   resolved string, preserving quoting. It is a superset of
 *   `resolveWord`: everything value-mode resolves, text-mode
 *   resolves to the same string (modulo preserved quotes); on top
 *   of that it expands the words INSIDE a process substitution
 *   (`<(perl … "$BODY")` → `<(perl … "/vault/…")`), because the
 *   text form is what guardrail predicates can match against —
 *   the runtime fd path is unknowable, but the command text with
 *   variables expanded is exactly what "predicates validate what
 *   executes" needs.
 *
 * Both are pure: env snapshots come from an explicit map, no
 * `process.env` reads inside, so plugin authors can seed their
 * own env state for testing and sandboxing (the walker modifier
 * protocol hands env via the cross-tracker `allState` — see
 * {@link import("./tracker.ts").Modifier}).
 *
 * Shared scope (v0.1.0 — bundled with the envTracker):
 *
 *   - ✅ Literal, SingleQuoted. DoubleQuoted if every inner part
 *        resolves.
 *   - ✅ `$NAME` (SimpleExpansion) via env lookup.
 *   - ✅ `${NAME}` (ParameterExpansion with no operator / index /
 *        slice / replace / length / indirect) via env lookup.
 *   - ✅ Leading `~` / `~/…` via `env.get("HOME")`.
 *   - ❌ `${NAME:-default}`, `${NAME#pattern}`, … (parameter-
 *        expansion with modifiers) → undefined.
 *   - ❌ Command substitution, arithmetic expansion, ext-glob,
 *        brace expansion, ANSI-C, locale-quoted → undefined.
 *
 * text-mode only:
 *
 *   - ✅ Process substitution `<(cmd …)` / `>(cmd …)` whose inner
 *        script is a single top-level command: each inner word
 *        (name + suffix) is resolved recursively with quoting
 *        preserved, and the line is rebuilt as `<(` + joined +
 *        `)`. Nested process substitutions recurse naturally.
 *   - ❌ Inner scripts with 2+ top-level commands (pipelines,
 *        `;` / `&&` sequences) → undefined (documented limit).
 *   - ↔ When the parser could not parse the inner body
 *        (`part.script === undefined`), the part's raw `text` is
 *        contributed verbatim — nothing to expand, safe.
 *
 * Fail-closed rule (both modes): if ANY part is unresolvable the
 * WHOLE word returns `undefined` and the caller keeps the raw
 * word. Deferred classes are documented inline (see the scope
 * lists above) and graduate when a motivating use case lands; the
 * underlying AST is already typed, so adding a case is structural
 * (new `WordPart.type` arm → helper or undefined).
 */

import type {
  DoubleQuotedChild,
  ProcessSubstitutionPart,
  Word,
  WordPart,
} from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { isIdentifierName } from "./internal/identifier.ts";

/**
 * Resolve a {@link Word} to its runtime string value using the
 * given env snapshot for `$VAR` / `${VAR}` / `~` expansion.
 *
 * Returns `undefined` when the word contains any part the helper
 * cannot statically evaluate (command substitution, parameter
 * expansion with modifiers, arithmetic, process substitution,
 * brace expansion, ext-glob, ANSI-C, locale-quoted, or a `$VAR`
 * whose NAME is absent from `env`).
 *
 * This is the exact semantics downstream rules need: a failure
 * to resolve propagates as `undefined`, which the caller's
 * modifier converts into the tracker's `unknown` sentinel (see
 * the {@link Tracker} contract).
 *
 * @example
 *   // `cd "$WS/pkg"` with env = { WS: "/workspace" }
 *   resolveWord(wordFromTarget, new Map([["WS", "/workspace"]]))
 *   // → "/workspace/pkg"
 *
 *   // `cd "$UNDEFINED/pkg"` with empty env
 *   resolveWord(wordFromTarget, new Map())
 *   // → undefined
 *
 *   // `cd $(pwd)` — command substitution is never resolvable
 *   resolveWord(wordFromTarget, env)
 *   // → undefined
 */
export function resolveWord(
  word: Word,
  env: ReadonlyMap<string, string>,
): string | undefined {
  // No parts: the word is a simple literal. Upstream guarantees
  // `value` (lexical value, unquoted) on every Word, so read it
  // directly — no `text` fallback.
  if (!word.parts || word.parts.length === 0) {
    const bare = word.value;
    // Tilde expansion at word start: `~`, `~/…`. Only applies when
    // the token actually starts with `~` in the raw source — if a
    // user writes `"~"` the parser produces a SingleQuoted /
    // DoubleQuoted part, not a bare word, so we don't accidentally
    // expand quoted tildes here.
    return expandTildeIfLeading(bare, env);
  }

  let out = "";
  for (let i = 0; i < word.parts.length; i++) {
    const part = word.parts[i]!;
    const resolved = resolvePart(part, env);
    if (resolved === undefined) return undefined;
    // Tilde expansion only applies to the very first part AND only
    // when that part is a bare Literal that starts with `~` — same
    // semantic rule as bash (quoted `~` is not expanded).
    if (i === 0 && part.type === "Literal") {
      const expanded = expandTildeIfLeading(resolved, env);
      if (expanded === undefined) return undefined;
      out += expanded;
    } else {
      out += resolved;
    }
  }
  return out;
}

/**
 * Resolve a {@link Word} to its SOURCE TEXT with every expandable
 * part replaced by its resolved string — text-mode, quote-
 * preserving. This is a superset of {@link resolveWord}: the two
 * agree on which words are resolvable and on the resolved string
 * (modulo quoting), and text-mode additionally expands the words
 * inside a process substitution.
 *
 * Quoting semantics (matching bash):
 *
 *   - Literal / SingleQuoted parts contribute their raw source
 *     text (single quotes are never expanded).
 *   - DoubleQuoted parts contribute `"` + resolved children + `"`
 *     — the quotes stay so spaces inside expanded values survive
 *     downstream tokenizers.
 *   - Bare `$NAME` / `${NAME}` contribute the resolved value
 *     UNQUOTED (faithful: the shell word-splits there too).
 *   - Leading `~` / `~/…` expand via `env.get("HOME")` exactly
 *     like {@link resolveWord} (first part, bare Literal only).
 *
 * Process substitution `<(…)` / `>(…)`: the inner script's words
 * are resolved recursively (single top-level command only —
 * pipelines and `;`/`&&` sequences fail closed), the line is
 * rebuilt space-joined with quoting preserved, and re-wrapped in
 * `<( … )` / `>( … )`. The runtime fd path is unknowable, so the
 * expanded TEXT is what predicates can match against. When the
 * parser couldn't parse the inner body (`part.script ===
 * undefined`), the part's raw text is contributed verbatim.
 *
 * Fail-closed: any unresolvable part anywhere (command
 * substitution, parameter expansion with modifiers, arithmetic,
 * absent `$VAR`, multi-command process substitution, …) makes the
 * WHOLE word `undefined` — callers keep the raw word.
 *
 * @example
 *   // `--body-file=<(perl -0777 -pe '<BODY_STRIP>' "$BODY")`
 *   // with env = { BODY: "/vault/repo/prs/note.md" }
 *   resolveWordText(wordFromArg, new Map([["BODY", "/vault/repo/prs/note.md"]]))
 *   // → "<(perl -0777 -pe '<BODY_STRIP>' \"/vault/repo/prs/note.md\")"
 *
 *   // `"feat: x"` — quotes are preserved in text mode
 *   resolveWordText(wordFromArg, new Map())
 *   // → "\"feat: x\""
 *
 *   // multi-command inner script — fail closed
 *   resolveWordText(wordFromArg, new Map())
 *   // → undefined
 */
export function resolveWordText(
  word: Word,
  env: ReadonlyMap<string, string>,
): string | undefined {
  // No parts: the word is a bare token. Text-mode keeps the raw
  // source (`word.text`) — for a partless word that is also the
  // runtime value. Tilde expansion applies exactly like value-mode.
  if (!word.parts || word.parts.length === 0) {
    return expandTildeIfLeading(word.text, env);
  }

  let out = "";
  for (let i = 0; i < word.parts.length; i++) {
    const part = word.parts[i]!;
    const rebuilt = resolveWordTextPart(part, env);
    if (rebuilt === undefined) return undefined;
    // Tilde expansion only applies to the very first part AND only
    // when that part is a bare Literal that starts with `~` — same
    // semantic rule as bash (quoted `~` is not expanded).
    if (i === 0 && part.type === "Literal") {
      const expanded = expandTildeIfLeading(rebuilt, env);
      if (expanded === undefined) return undefined;
      out += expanded;
    } else {
      out += rebuilt;
    }
  }
  return out;
}

/**
 * Apply tilde expansion to a leading `~` using `env.get("HOME")`.
 *
 * Semantics:
 *   - `~` alone → HOME, or `undefined` if HOME is absent (walker
 *     emits unknown sentinel → engine fail-closes via `onUnknown`).
 *   - `~/rest` → `HOME + "/" + rest`, or `undefined` if HOME absent.
 *   - `~user` / `~user/rest` → returned unchanged (we don't model
 *     arbitrary user HOME directories; cd would fail at runtime
 *     on a nonexistent user). Documented known limit — narrow
 *     enough that flipping it to `undefined` is left as a
 *     follow-up if it becomes an agent-bypass class.
 *   - No leading `~` → returns input unchanged.
 *
 * Exported for the assignment-RHS tilde rule in the env tracker
 * (`src/trackers/env.ts:resolveAssignmentWord`) — the same
 * quote-aware semantics, applied to the value after the first `=`.
 * The function is defined outside `resolveWord` to keep the hot
 * path inside the parts-loop short (no closure).
 */
export function expandTildeIfLeading(
  s: string,
  env: ReadonlyMap<string, string>,
): string | undefined {
  if (s.length === 0) return s;
  if (s[0] !== "~") return s;
  if (s === "~") {
    const home = env.get("HOME");
    return home ?? undefined;
  }
  if (s.startsWith("~/")) {
    const home = env.get("HOME");
    if (home === undefined) return undefined;
    return home + s.slice(1);
  }
  // `~user` / `~user/rest` — unsupported; returned unchanged.
  return s;
}

/**
 * Resolve a single {@link WordPart} to its rebuilt SOURCE TEXT
 * (text-mode). Returns the quote-preserving string slice this part
 * contributes to the word, or `undefined` if the part is
 * intractable. Mirrors {@link resolvePart} with two differences:
 * Literal / SingleQuoted keep their raw text (quotes included) and
 * ProcessSubstitution parts are expanded (see
 * {@link resolveProcessSubstitutionText}).
 */
function resolveWordTextPart(
  part: WordPart,
  env: ReadonlyMap<string, string>,
): string | undefined {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
      // Raw source text, quote-preserving. Single-quoted content is
      // never expanded (bash semantics) — the quotes are part of the
      // text a downstream tokenizer needs.
      return part.text;

    case "DoubleQuoted": {
      // Double-quoted strings concatenate their inner parts, keeping
      // the surrounding quotes so expanded values survive downstream
      // tokenizers. If ANY inner part is intractable, the whole word
      // is intractable.
      let out = "";
      for (const child of part.parts) {
        const resolved = resolveDoubleQuotedChild(child, env);
        if (resolved === undefined) return undefined;
        out += resolved;
      }
      return `"${out}"`;
    }

    case "SimpleExpansion": {
      // `$NAME` form — see {@link resolvePart} for the special-
      // parameter caveat. Resolved value is UNQUOTED even in text
      // mode: outside double quotes the shell word-splits there,
      // so the unquoted value is the faithful text.
      const raw = part.text;
      if (!raw.startsWith("$")) return undefined;
      const name = raw.slice(1);
      if (!isIdentifierName(name)) return undefined;
      return env.get(name);
    }

    case "ParameterExpansion": {
      // `${NAME}` bare shape only — same gate as value-mode. Any
      // operator / slice / replace / length / indirect / index form
      // is deferred (fail-closed).
      if (
        part.operator !== undefined ||
        part.slice !== undefined ||
        part.replace !== undefined ||
        part.length === true ||
        part.indirect === true ||
        part.index !== undefined
      ) {
        return undefined;
      }
      if (!isIdentifierName(part.parameter)) return undefined;
      return env.get(part.parameter);
    }

    case "ProcessSubstitution":
      return resolveProcessSubstitutionText(part, env);

    // Intractable categories — see file-header comment.
    case "CommandExpansion":
    case "ArithmeticExpansion":
    case "ExtendedGlob":
    case "BraceExpansion":
    case "AnsiCQuoted":
    case "LocaleString":
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Resolve a {@link DoubleQuotedChild} inside a DoubleQuoted part.
 * Children are already inside preserved quotes, so they contribute
 * their resolved value (no quoting of their own). Command
 * substitution / arithmetic children are intractable.
 */
function resolveDoubleQuotedChild(
  child: DoubleQuotedChild,
  env: ReadonlyMap<string, string>,
): string | undefined {
  switch (child.type) {
    case "Literal":
      // Use `text` (raw source), NOT `value`: unbash's `value` for a
      // double-quoted literal child is the UNESCAPED content, so
      // `"a\"b"` would rebuild as `"a"b"` (mis-tokenized) and
      // `"\$X"` would turn an escaped dollar into a live expansion.
      // `text` keeps the escapes byte-identical, matching what the
      // shell actually executes.
      return child.text;

    case "SimpleExpansion": {
      const raw = child.text;
      if (!raw.startsWith("$")) return undefined;
      const name = raw.slice(1);
      if (!isIdentifierName(name)) return undefined;
      return env.get(name);
    }

    case "ParameterExpansion": {
      if (
        child.operator !== undefined ||
        child.slice !== undefined ||
        child.replace !== undefined ||
        child.length === true ||
        child.indirect === true ||
        child.index !== undefined
      ) {
        return undefined;
      }
      if (!isIdentifierName(child.parameter)) return undefined;
      return env.get(child.parameter);
    }

    // Intractable inside double quotes too.
    case "CommandExpansion":
    case "ArithmeticExpansion":
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Text-mode resolution for a ProcessSubstitution part (`<(…)` /
 * `>(…)`).
 *
 * The runtime fd path is unknowable, so the best a predicate can
 * match against is the TEXT of the inner command with variables
 * expanded. We therefore recurse into the inner script: extract its
 * commands with {@link extractAllCommandsFromAST}, require exactly
 * ONE top-level command (nested expansions — including nested
 * process substitutions — are flattened into the ref list under
 * their own group IDs, so only group-0 refs count), resolve the
 * command's name and suffix words recursively, and rebuild the
 * line space-joined inside `<( … )` / `>( … )`.
 *
 * Fail-closed:
 *   - 2+ top-level commands (pipelines, `;`/`&&` sequences) →
 *     `undefined` (documented limit).
 *   - Any inner word that doesn't resolve (command substitution,
 *     absent `$VAR`, modifier forms, …) → `undefined`.
 *
 * When `part.script === undefined` (the parser could not parse the
 * inner body) there is nothing to expand — the part's raw `text`
 * is contributed verbatim (safe, not fail-closed).
 */
function resolveProcessSubstitutionText(
  part: ProcessSubstitutionPart,
  env: ReadonlyMap<string, string>,
): string | undefined {
  const { script } = part;
  if (!script) {
    // Parser couldn't parse the inner body — keep the raw source
    // verbatim; there is nothing we could expand.
    return part.text;
  }

  // NOTE: the rebuilt text covers the inner command's NAME + SUFFIX
  // words only — inner redirects and assignment prefixes
  // (`<(cmd >out)`, `<(FOO=bar cmd)`) are dropped from the rebuild
  // (locked spec scope). The rebuilt text is therefore the expanded
  // COMMAND-LINE form, not a byte-exact rewrite; consumers that need
  // byte fidelity should treat unresolvable/redirect-bearing forms
  // as out of scope.
  const refs = extractAllCommandsFromAST(script, part.text);
  const topLevel = refs.filter((ref) => ref.group === 0);
  if (topLevel.length !== 1) return undefined;
  const cmd = topLevel[0]!.node;

  const pieces: string[] = [];
  if (cmd.name) {
    const name = resolveWordText(cmd.name, env);
    if (name === undefined) return undefined;
    pieces.push(name);
  }
  for (const word of cmd.suffix) {
    const resolved = resolveWordText(word, env);
    if (resolved === undefined) return undefined;
    pieces.push(resolved);
  }

  return `${part.operator}(${pieces.join(" ")})`;
}

/**
 * Resolve a single {@link WordPart} against the env map. Returns
 * the concatenable string slice contributed by this part, or
 * `undefined` if the part is intractable.
 */
function resolvePart(
  part: WordPart,
  env: ReadonlyMap<string, string>,
): string | undefined {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
      return part.value;

    case "DoubleQuoted": {
      // Double-quoted strings concatenate their inner parts. If ANY
      // inner part is intractable, the whole word is intractable.
      let out = "";
      for (const child of part.parts) {
        const resolved = resolvePart(child as WordPart, env);
        if (resolved === undefined) return undefined;
        out += resolved;
      }
      return out;
    }

    case "SimpleExpansion": {
      // `$NAME` form. Parser preserves the raw text `$NAME`; the
      // name is everything after the leading `$`. Special forms
      // `$@`, `$*`, `$#`, `$?`, `$$`, `$!`, `$0`…`$9` are not
      // modelled — they behave as intractable.
      const raw = part.text;
      if (!raw.startsWith("$")) return undefined;
      const name = raw.slice(1);
      if (!isIdentifierName(name)) return undefined;
      return env.get(name);
    }

    case "ParameterExpansion": {
      // `${NAME}` form. We accept ONLY the bare shape with none of
      // bash's parameter-expansion operators. Anything with
      // `operator` (`:-`, `#`, `%`, `/`, `^`, …), `slice`,
      // `replace`, `length`, `indirect`, or `index` is deferred
      // (see env-tracker-deferred-scope.md).
      if (
        part.operator !== undefined ||
        part.slice !== undefined ||
        part.replace !== undefined ||
        part.length === true ||
        part.indirect === true ||
        part.index !== undefined
      ) {
        return undefined;
      }
      if (!isIdentifierName(part.parameter)) return undefined;
      return env.get(part.parameter);
    }

    // Intractable categories — see file-header comment.
    case "CommandExpansion":
    case "ArithmeticExpansion":
    case "ProcessSubstitution":
    case "ExtendedGlob":
    case "BraceExpansion":
    case "AnsiCQuoted":
    case "LocaleString":
      return undefined;

    default:
      return undefined;
  }
}
