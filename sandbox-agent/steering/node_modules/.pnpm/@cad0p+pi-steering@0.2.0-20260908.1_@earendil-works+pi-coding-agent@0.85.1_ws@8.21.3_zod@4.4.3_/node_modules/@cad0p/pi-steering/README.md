# pi-steering

AST-backed steering rules for [pi](https://github.com/earendil-works/pi) agents, with stateful predicates and plugin-first composition.

## What this is

A deterministic guardrail layer that sits between your pi agent and the tools it invokes. You declare TypeScript rules that gate `bash` / `write` / `edit` tool calls; the engine parses every command with [`unbash-walker`](https://github.com/cad0p/unbash-walker), walks a per-call tracker state, matches against your rules, and returns a block verdict before pi executes. Observers record state from `tool_result` events so later rules can say "this must be done first".

Use it when:

- You want to gate commands by structure, not substring — `sh -c 'git push --force'`, `cd /repo && git push --force`, and `git push "--force"` should all trigger the same force-push rule (which blocks every history-rewrite form: `--force*`, bundled shorts like `-uf`, leading-`+` refspecs, `--mirror`), and `echo 'git push --force'` should not.
- You want "must run X before Y" rules that survive across tool calls within the same user prompt.
- You want to ship + version a rule pack as an npm dependency (plugins), not a shared JSON file.

## Install

```bash
pi install npm:@cad0p/pi-steering
```

Requires **Node `>=22.19.0`** (see `package.json#engines`; the same floor as pi itself). The project-layer trust gate (see [Security](#security)) needs **pi `>=0.79.1`** — the release that added `ctx.isProjectTrusted()` (peer floor in `package.json#peerDependencies`). On older pi the gate is inert (project layer loads as before) with a `console.info` breadcrumb at session start. Configs are loaded and transpiled by the bundled [jiti](https://github.com/unjs/jiti) runtime — no `tsx` / `ts-node` needed.

### Local install (during the PoC)

Until the first npm publish, install from a local clone:

```bash
git clone https://github.com/cad0p/pi-steering.git
cd pi-steering

pnpm install
pnpm --filter pi-steering build   # dist/ is gitignored — build first

pi install .
```

Then restart pi.

**After code changes.** Rebuild, then restart pi:

```bash
pnpm --filter pi-steering build
```

Why both steps matter:

- `pi install <local-path>` only registers the path in settings — it does **not** run a build or any install hook.
- The package is compiled (`"main": "./dist/index.js"`) and `dist/` is gitignored, so edits to `src/` only take effect after a build.
- `/reload` inside pi picks up settings, skills, prompts, and themes — but for compiled extension code, transitive `dist/` imports sit in Node's native ESM cache and are not reliably reloaded. A full pi restart is the safe option after rebuilding.

### Hot-reload of the user config

`/reload` **does** pick up edits to your `.pi/steering/index.ts` (or `.pi/steering.ts`) without a pi restart. On every load the loader re-reads the file from disk and evaluates it fresh via jiti — nothing is cached by URL — and an initial-load failure (broken syntax, a runtime throw, a missing default export) doesn't poison subsequent loads after you fix the file. Reload also rebinds a fresh extension instance whose first `session_start` re-runs the runtime build, so config validation — and re-validation after fixes — happens automatically (`session_start` fires with `reason: "reload"`).

It also picks up edits to **everything the config imports**. Each load creates a fresh jiti instance (`moduleCache: false`), so transitive imports route through jiti's loader and get re-read from disk and re-evaluated on every reload:

- **Sibling files** — `.ts` modules next to the config (e.g. `./rules/*.ts`), or `.js` in CommonJS scope (below).
- **`.ts`-shipped plugin sources under `node_modules`** — a plugin whose package entry points at `.ts` source (e.g. `@cad0p/pi-napkin/steering`). This was previously broken outright: Node's native type-stripping hard-refused `.ts` under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), dropping the config with `layer-import-failed`. jiti has no such restriction — the plugin loads, and edits to its source hot-reload.
- **`.js` files in CommonJS scope** — a package without `"type": "module"` in its `package.json`.

Top-level `await` and dynamic `import()` inside the config work as well.

What `/reload` still does **not** pick up:

- Edits to a plugin's **compiled ESM `dist/`** — typically `dist/index.js` from npm in a `"type": "module"` package. Such modules go through jiti's native-import fast path into Node's ESM module map, which caches them by URL for the process lifetime; a full pi restart is needed.
- Edits to pi-steering's own `dist/`. Same reason — the bridge entry is re-evaluated each reload, but transitively-imported compiled ESM modules from `dist/` sit in Node's native ESM cache.

**Recommendation for plugin authors:** ship `.ts` source as the package entry — the case is now stronger than ever: `.ts` under `node_modules` is fully supported (the loader transpiles it itself, on any supported Node — no native type-stripping requirement), and shipping source means plugin edits hot-reload during development, while a compiled ESM `dist` entry never does. The migration is small: switch `package.json#main` to `./src/index.ts`, drop the `tsc` build step (or keep it as `tsc --noEmit` for typecheck), set `allowImportingTsExtensions: true` and `noEmit: true` in `tsconfig.json`, optionally add `erasableSyntaxOnly: true` to reject non-erasable TS features (`enum`, namespaces, parameter properties) at compile time — jiti can transpile those, but keeping the shipped source erasable keeps it consumable by editors and type-stripping tooling.

## Config layers

pi-steering resolves exactly two layers, mirroring pi's own settings model:

- **Project** — `<cwd>/.pi/steering/` (or the `.pi/steering.ts` single-file form), loaded from the directory pi was launched in.
- **Global** — `<agentDir>/steering/`, where `agentDir` is `$PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent` by default. Applies to every project.

The project layer is merged INNERMOST: on rule/plugin/observer-name collision the project entry wins, so a project can override or soften a global rule by declaring the same name. There is no walk-up discovery — intermediate directories contribute nothing, and nothing below `~/.pi/agent/` is special-cased.

**Breaking change (v0.2.0): the old global location `~/.pi/steering/` is no longer loaded** — no alias, no deprecation diagnostic. The only situation where it still works is launching pi from `$HOME` itself, where `<cwd>/.pi/steering/` happens to be `~/.pi/steering/`. Migrate with:

```bash
mv ~/.pi/steering ~/.pi/agent/steering
```

## Quick start

Create `.pi/steering/index.ts` at your project root:

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin, {
  GIT_CLI_DESCRIPTOR,
} from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  // The git plugin declares git's argv facts (which flags consume
  // values, which shorts glue) — the `command:` union below only
  // accepts declared basenames, so the plugin must be listed for
  // `command: "git"` to typecheck.
  plugins: [gitPlugin],
  rules: [
    {
      name: "no-force-push",
      tool: "bash",
      command: "git",
      when: {
        subcommand: "push",
        // Entries always come from the owning plugin's table — never
        // hand-build literals in rules.
        flag: { anyOf: [GIT_CLI_DESCRIPTOR.flags.force] },
      },
      reason:
        "Force pushes rewrite remote history. Create a new commit instead, or ask the user to run one manually.",
    },
  ],
});
```

With this config:

- `git push --force`, `sh -c 'git push --force'`, and `cd /repo && git push --force` all block via your rule.
- `git push --force-with-lease` is blocked too once you rely on the git plugin's sealed `no-force-push` rule instead of the sketch above — it treats every history-rewrite form as unsafe (bundled shorts like `-uf`, leading-`+` refspecs like `git push origin +main`, `--mirror`; see [Defaults](#defaults) below).
- `git commit` on `main` / `master` / `mainline` / `trunk` blocks via the git plugin's `no-main-commit` rule (already declared above — see [Defaults](#defaults) below).
- `echo 'git push --force'` correctly does not block — routing is exact basename equality on real command refs, not substrings of arguments.

## Defaults

**There are none.** Since issue [#72](https://github.com/cad0p/pi-steering/issues/72), the package ships no implicit rules or plugins: a fresh config loads with ZERO active rails, and every guard on your session is something you declared. Protection is explicit, visible, and `pi-steering list`-truthful.

The two safety rails that used to be engine-injected now live in domain plugins, one declaration each:

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";

export default defineConfig({
  plugins: [gitPlugin, rmPlugin],
});
```

What each plugin ships:

- **[git](./src/plugins/git/README.md)** — `no-force-push` and `no-hard-reset` (the destructive-git rails; `no-force-push` is sealed per issue [#65](https://github.com/cad0p/pi-steering/issues/65): it blocks every remote-history-rewrite form — `--force`, `--force-with-lease`, `--force-if-includes`, bundled shorts like `-uf`, leading-`+` refspecs like `git push origin +main`, and `--mirror`), plus the non-overridable `no-main-commit` / `no-main-commit-github` pair (issue #79), the `branch` / `upstream` / `commitsAhead` / `hasStagedChanges` / `isClean` / `remote` predicates, the branch tracker, and the `cwd.git` tracker extension.
- **rm** — `no-rm-rf-slash`, the recursive-force-delete-from-root guard. Non-overridable (`noOverride: true`).

The deleted `async` plugin's `no-long-running-commands` availability rail has no honest home yet (its CLI tables were never verified — see the restoration follow-up, issue [#120](https://github.com/cad0p/pi-steering/issues/120)).

Declaring a plugin is also what feeds its rule / plugin names into `defineConfig`'s generics for typo-checking on `disabledRules` / `disabledPlugins` — an undeclared plugin's names are NOT in the inferred union, so a stale disable entry is a compile error instead of a silent no-op. Runtime registration and type-level visibility cannot diverge.

Customization works per rule, not per bundle:

```ts
import gitPlugin from "@cad0p/pi-steering/plugins/git";

// Keep the git predicates + trackers and every other shipped rule;
// drop just one:
defineConfig({ plugins: [gitPlugin], disabledRules: ["no-force-push"] });
```

**Migrating from ≤ 0.2.0:** add the three declarations above (or just the plugins you want). The old opt-out-of-everything config flag is gone — see the changelog for the full breaking sweep. Rule bindings import from their plugin subpaths now (e.g. `import { noForcePush } from "@cad0p/pi-steering/plugins/git"`).

**Typecheck payoff.** Declare anything that should be typo-checked:

```ts
// @ts-expect-error — "wrong-name" is not a registered rule
disabledRules: ["wrong-name"],
```

This fails at `tsc --noEmit` time — rule / plugin / observer names are threaded through `defineConfig`'s generics and cross-validated.

## Glossary

Three orthogonal axes, three distinct word families. Keep them straight and the docs / rules / errors all line up.

**Time scope** (`TopLevelWhenClause.missing.in`):

- **`agent_loop`** — the current user prompt plus every tool call it spawns. Bumped on pi's `agent_start` event. Most common scope for workflow rules.
- **`session`** — the entire pi session across all agent loops. Persisted in the session JSONL, survives restarts.
- **`tool_call`** — the current bash tool call only. Considers ONLY speculative entries synthesized from `&&`-reachable observers. Use when the event MUST be chained directly before the guarded command.

**Entry origin** (how a session entry came to exist):

- **Real entry** — persisted in pi's session JSONL via `ctx.appendEntry`. Outlives the current tool call.
- **Speculative entry** — synthesized by the engine for a `&&`-chain, representing "if this chain runs to completion, this entry WILL be written." Not persisted; exists only for the current evaluation.
- **Synthesis pass** — walker-level pass that produces speculative entries from observer `writes:` declarations plus `&&`-chain reachability.

**Shell constructs** (what the agent typed):

- **`&&`-chain** — the shell construct `A && B && C`. Legitimate bash terminology throughout these docs; distinct from the retired adjective "chain-aware".
- **Pipeline** (`|`) — each peer runs in its own subshell; cwd / branch / state effects don't propagate across peers.
- **Subshell** (`(…)`) — cwd / branch effects are isolated to the subshell's body.

**Hook surfaces** (where code runs):

- **Tracker** — walker-level, static. Models per-ref state (cwd, branch, …) from the bash AST before execution. Plugin authors register under `Plugin.trackers`. See "Walker extensibility".
- **Observer** — engine-level, dynamic. Watches `tool_result` events and persists session entries via `ctx.appendEntry`. Plugin authors register under `Plugin.observers`. See "Observers".

**Walker terminology** (shell-semantics terms of art):

- **Effective cwd** — the cwd a command runs at, computed statically by the walker from preceding `cd` / `-C` constructs. Always `tool_call`-scoped (fresh per bash invocation).
- **Command ref** (`CommandRef`) — one extracted command node with its args, per bash tool call. Multiple per `&&`-chain.

## How it works

Concrete execution trace — what happens when an agent issues `bash("git push --force && cd /tmp && git log")` under the config above:

```
User prompt sent to pi.

1. pi.on("agent_start") → engine bumps agentLoopIndex from N to N+1.
   One "agent loop" = one user prompt + every tool call it spawns.

2. Agent decides to run the bash tool with:
     command = "git push --force && cd /tmp && git log"

3. pi emits tool_call. Evaluator runs (once per tool_call):

   a. parseBash(command)       → AST
   b. extractAllCommandsFromAST → 3 CommandRefs:
        ref#0: basename="git", args=[push, --force]   (Word[])
        ref#1: basename="cd",  args=[/tmp]
        ref#2: basename="git", args=[log]
   c. expandWrapperCommands    → no wrappers; still 3 refs.
   d. walk(ast, { cwd }, trackers) → per-ref state:
        ref#0 at cwd=/original
        ref#1 at cwd=/original
        ref#2 at cwd=/tmp  (the `cd /tmp` applied)
      Walker-level speculative-entry synthesis runs in the same pass,
      populating `walkerState.events` per ref (see "`&&`-chain
      speculative allow" below).
   e. For each ref × for each rule, build a Candidate:
        input.command   = ref.text (FLATTENED: "git push --force")
        input.basename  = "git"
        input.args      = ref.node.suffix (Word[] with quote-aware .value)
        cwd             = walkerState.cwd   (per-ref)
        walkerState     = { cwd, branch, …, events }  (all trackers +
                          synthesized events under the reserved `events` key)
        agentLoopIndex  = N+1
   f. Route bash rules by exact `command:` basename equality;
      test write/edit rule.pattern / requires / unless against
      their target. Run when.cwd / when.branch / when.missing /
      plugin predicates.
      `when.missing` merges real entries (ctx.findEntries) with
      synthesized speculative ones (walkerState.events) by timestamp
      — one unified latest-entry comparison.
   g. First rule that ALL predicates pass on wins.
      Return { block: true, reason: "This tool call was not
      executed; blocked by a steering rule:\n\n[steering:no-force-push@user] …" }.
      If the rule defines `onFire`, invoke it first (may writeSession entries,
      which the engine auto-tags with _agentLoopIndex).

4. If no rule blocked, pi executes the command.

5. pi emits tool_result. Dispatcher runs (once per tool_result):

   a. Parse event.input.command via walker. (The dispatcher parses
      independently from step 3 today — sub-millisecond per event.
      Cross-step AST caching is a future optimization.)
   b. For every observer whose `watch` filter matches:
        - `watch.inputMatches.command` matches raw outer command
          OR any ref.text (wrapper-aware, ADR §12).
        - `observer.onResult(event, observerCtx)` fires.
        - observerCtx.appendEntry(type, data) writes an entry —
          auto-tagged with _agentLoopIndex for `when.missing` filtering.
```

The important bits worth stressing:

- **One parse, many rules.** The AST walk happens once per tool call; every rule sees the same extracted refs and walker state. Adding rules is cheap.
- **Per-ref evaluation.** `cd /tmp && git log` evaluates the `git log` rule AT cwd `/tmp`, not at `/original`. Walker trackers (cwd by default; branch via the git plugin) update state as refs flow through the command chain.
- **Source-tagged reasons.** Block reasons carry `[steering:<rule>@<source>]` where source is `user` or the shipping plugin name. The agent can see both what fired and where to look it up. Every block reason is prefixed with a fixed preamble — `This tool call was not executed; blocked by a steering rule:` — so the message always states the tool call never executed (issue #85).
- **First match wins.** Rule order matters within a layer, and the project layer beats the global layer on rule-name collision.

## Authoring rules

### Rule shape

```ts
interface Rule {
  name: string;                                 // unique; shown in block reason
  tool: "bash" | "write" | "edit";
  // Bash rules route on the command: first filter (no field/pattern):
  command?: Basename | readonly Basename[];    // bash only — required, exact basename equality
  // Write/edit rules match with field + pattern (untouched):
  field?: "path" | "content";                 // write/edit only — which input field pattern tests
  pattern?: string | RegExp;                    // write/edit only — main match
  requires?: Pattern | PredicateFn;             // AND extra (transient — see retirement note below)
  unless?: Pattern | PredicateFn;               // exemption (transient — see retirement note below)
  when?: TopLevelWhenClause;                   // composable predicates
  reason: string | ReasonFn;                    // message (or fn) to the agent
  noOverride?: boolean;                         // default: true (fail-closed)
  observer?: Observer | string;                 // name-ref to a shipped observer
  writes?: readonly string[];                   // declared session-entry types
  onFire?: (ctx: PredicateContext) => void;     // side-effect hook on block
}

type ReasonFn = (ctx: PredicateContext) => string | Promise<string>;
```

Bash rules carry NO `field` / `pattern` — routing is the required `command:` first filter: exact basename equality against each extracted command ref (`command: "git"` matches `git`, `sh -c 'git push'`, `/usr/bin/git`, and `git -C /x push`; `echo 'git push'` has basename `echo` and never matches). One basename per entry — `command: "git commit"` is illegal (whitespace is rejected at build). A readonly array is plain OR (`command: ["git", "rm"]` — one name = one `disabledRules` / exemption / override entry, NOT shared leaves; leaves stay per-ref AND under arrays, so a leaf meaningless for a binary never fires its refs). An empty array never matches. At `defineConfig` sites the `command:` union narrows to declared descriptor keys (plugin-shipped + inline-literal `cliDescriptors`), so `command: "gti"` is a compile error; with no facts in scope the union is unconstrained `string` and the fail-closed rule-tagged missing-descriptor block covers the rest at evaluation time. Nameless refs (bare `VAR=x` chains — no binary) never match.

For write/edit, the **pattern** tests `path` or `content` directly.

The **reason** is written for the agent. Include what was blocked and what the safe alternative is — the agent reads it and acts on it. A plain string is the common case. For dynamic context (the walker-resolved cwd, a count pulled from `findEntries`), pass a function instead:

```ts
{
  name: "cr-upstream-mainline",
  tool: "bash",
  command: "cr", // enclosing config must declare cr's argv facts:
  // `plugins: [{ name: "cr-facts", cliDescriptors: { cr: {} } }]`
  // (inline-literal plugin — NO new top-level config field; without
  // facts the rule fails closed with a missing-descriptor block).
  reason: (ctx) =>
    ctx.walkerState?.cwd === "unknown"
      ? "Walker could not resolve cwd statically. Retry with a literal path, or run `cr` from inside a package directory."
      : "Your branch's upstream must track origin/mainline before running `cr`.",
}
```

Reason functions are awaited, and the result is prefixed the same way as string reasons (`[steering:<rule>@<source>] …`), after the engine's fixed preamble (`This tool call was not executed; blocked by a steering rule:`, see `BLOCK_REASON_PREAMBLE`). If the function throws or rejects, the engine logs the error with `console.warn` and emits a fail-safe fallback body (`(reason failed to format; see log)`) so the block verdict still lands without leaking the raw error to the agent.

### `TopLevelWhenClause`

```ts
type TopLevelWhenClause<Writes extends string = string> = {
  // Built-in non-registry leaves (lifted onto BuiltInWhenLeavesOuter):
  cwd?: Pattern | Pattern[]
      | { pattern: Pattern | Pattern[]; onUnknown?: "allow" | "block" };
  subcommand?: SubcommandLeaf;   // bare string = EXACT match, NOT regex
  flag?: FlagLeaf;               // { anyOf, onUnknown? }
  missing?: {
    event: Writes;
    in: "agent_loop" | "session" | "tool_call";
    since?: Writes;     // optional invalidation sentinel
    notIn?: "agent_loop" | "session" | "tool_call";  // scope subtraction
  };
  condition?: (ctx: PredicateContext) => boolean | Promise<boolean>;

  // One level of negation (no recursion). Inside `not:`, leaf-level
  // `onUnknown:` is forbidden; the block-level modifier owns the
  // walker-unknown projection (default `"block"` = fail-CLOSED).
  not?: TopLevelWhenClauseNoRecurse<Writes>;
} & {
  // Plugin-registered predicate leaves — narrowed via the
  // PiSteeringPredicates registry. `branch:`, `upstream:`,
  // `isClean:`, etc. each declare their bare / spread shape via
  // `declare global` augmentation in the plugin's index.ts.
  // Homomorphic-with-filter mapping (constraint inlined as `keyof
  // PiSteeringPredicates` + as-clause filter); see the schema
  // doc-comment for why this AST shape is load-bearing for hover.
  [K in keyof PiSteeringPredicates as K extends ReservedPredicateKey
      ? never
      : K]?: OuterValue<K & PluginPredicateKey>;
};
```

Built-ins:

- **`cwd`** — rule fires only when the command's effective cwd matches. For bash, this is the per-ref cwd from the walker (so `cd ~/personal && git commit` evaluates against `~/personal`). Dynamic targets — `cd "$WS_DIR/pkg"`, `cd ~/proj` — resolve through the walker's env tracker (seeded from `process.env.{HOME, USER, PWD}` plus any bare assignments, `export`s, or `unset`s in the same chain). Intractable targets (`cd $(pwd)`, `cd $UNDEFINED`) surface as the `"unknown"` sentinel; apply `onUnknown: "allow" | "block"` (default `"block"`, fail-closed) to choose. For write/edit, it's the session cwd.
- **`missing`** — fires while an entry of `event` is missing in `in` scope. `"agent_loop"` filters by `_agentLoopIndex === ctx.agentLoopIndex` (one user prompt + its tool calls); `"session"` scans the whole session JSONL; `"tool_call"` considers only speculative entries synthesized for THIS tool_call's `&&`-chain. Optional `since` acts as an invalidation sentinel — see "Temporal ordering with `missing.since`" below. Optional `notIn` subtracts a narrower scope from `in` (e.g. `{ in: "agent_loop", notIn: "tool_call" }` means "recorded in a prior tool_call in this loop", blocking the same-tool_call speculative bypass). `notIn` is set subtraction, distinct from the clause-level `not` (boolean negation). Synthesizes speculative entries across `&&` bash chains — see "`&&`-chain speculative allow" below.
- **`not`** — boolean NOT over an inner predicate block. One level only (no `not: not: ...` recursion). Inside `not:`, leaf-level `onUnknown:` is forbidden; the block-level `onUnknown:` modifier projects walker-unknown verdicts (default `"block"` = fail-CLOSED, rule fires).
- **`subcommand`** — rule fires only when the command's extracted subcommand matches. Bare `string` = EXACT equality (`"push"` ≠ `"pushback"`, deliberately not `cwd:`'s regex-source semantics); `RegExp` = test; bare array = positional sequence (`["pr", "create"]` matches `gh pr create ...` — length IS the extraction width, inferred); spread `{ anyOf, onUnknown? }` is the explicit OR, mirroring `flag:` (`{ anyOf: ["pr", "push"] }` fires on either one-word subcommand; `{ anyOf: [["pr", "create"], ["repo", "create"]] }` fires on either sequence). Consuming-flag arity resolves ONLY via the CLI-descriptor registry by basename (`Plugin.cliDescriptors` — e.g. bare `subcommand: "push"` already extracts `push` from `git -C /x push` via the git plugin's declared descriptor, so the plugin must be declared for the match). No descriptor for the ref's basename → the engine throws `MissingDescriptorError` and blocks with an actionable reason (declare the descriptor, or `{ "<basename>": {} }` for explicit strict) — absent descriptors are loud, never silent. `null` extraction (all-flags, trailing consuming flag, after-only shapes like `go -v build`, non-bash tools) → `"unknown"` → `onUnknown:` (default `"block"`, fail-closed).
- **`flag`** — rule fires when any listed entry is present: `{ anyOf: [gitFlags.noPager], onUnknown? }` (`gitFlags` = `GIT_CLI_DESCRIPTOR.flags` from `@cad0p/pi-steering/plugins/git` — entries, OR over entries, each entry ORs aliases; a flag worth gating is worth a table row, so import the owning plugin's table, never hand-build literals in rules). Longs match the exact token or `--flag=value`; single-char shorts match exactly, inside bundles (`-uf` always matches `-u` / `-f` — longs never bundle-match), or glued (`-Rfoo` matches `-R` iff the table derives glue for `R`). Bundle matching derives from the descriptor table via the lead-letter rule: the first table-declared value-taking letter glues the remainder (nothing after it is present); undeclared letters never glue (fail-closed — the remedy is a table row). Consuming-flag values are skipped by position, never by content (table-derived arity; absent basename → `MissingDescriptorError` block, same loudness as `subcommand`). Non-bash tools → `"unknown"` → default `"block"`; otherwise presence is definite.
- **`condition`** — escape hatch for one-off logic. Prefer named plugin predicates (via `definePredicate`, tested per ADR §13) when the logic is reusable, per-binary divergent, or leaf-inexpressible (a flag-AND like recursive-plus-force, a positional scan like leading-`+` refspecs — the `flag:` leaf is OR-only, so such ANDs can't live in leaves and get a name instead of an inline closure): predicate names compose across configs, typecheck at `defineConfig` sites, and carry their own unit tests. `condition:` stays the one-off escape hatch — the rule's single-binary single-use composition that isn't worth a name. Throws (sync or rejected promise) are caught and treated as `"unknown"` → default `"block"` policy fires the rule fail-CLOSED. Authors needing fail-OPEN wrap inside `not: { condition: fn, onUnknown: "allow" }` OR catch the throw inside the callback body.

Plugin-registered predicate leaves come from the `PiSteeringPredicates` registry, populated by each plugin's `declare global` block:

```ts
// inside a plugin's index.ts
import type { Patterns, PredicateShape } from "@cad0p/pi-steering";

declare global {
  interface PiSteeringPredicates {
    // Auto-detected spreadBase form: `Bare` is the bare leaf type;
    // SpreadBase auto-detects to `{ pattern: Bare }` via
    // `DefaultSpreadBase<Bare>`.
    branch: PredicateShape<Patterns>;
    // Or explicit when the auto-detect doesn't fit:
    // commitsAhead: PredicateShape<number, { gt?: number; eq?: number; lt?: number }>;
  }
}
```

`PredicateShape<Bare, SpreadBase = DefaultSpreadBase<Bare>>` takes two type parameters. Each registry key contributes a leaf-level field on `TopLevelWhenClause` accepting the bare or spread form. `when.branch: /^main$/` is valid only when a plugin has augmented `PiSteeringPredicates` with a `branch` key. See `plugins/git/index.ts` for a worked example with all six gitPlugin predicates.

The legacy `WhenClause` interface is `@deprecated` for the JSON-v1 compatibility path (`compat.ts`); new code authors against `TopLevelWhenClause`.

### Predicate context

`PredicateFn`s and plugin `PredicateHandler`s receive a `PredicateContext`:

```ts
interface PredicateContext {
  cwd: string;                                  // effective cwd for this ref
  tool: "bash" | "write" | "edit";
  input: PredicateToolInput;                    // tool-shaped input
  agentLoopIndex: number;                       // current agent loop counter
  exec: (cmd, args, opts?) => Promise<ExecResult>;  // memoized per (cmd, args, cwd)
  appendEntry<T>(type: string, data?: T): void;
  findEntries<T>(type: string): Array<{ data: T; timestamp: number }>;
  walkerState?: Readonly<WhenWalkerState>;      // tracker snapshot (bash only)
}

interface WhenWalkerState {
  readonly cwd: string;                          // effective cwd, or "unknown"
  readonly env: ReadonlyMap<string, string>;     // env map (HOME/USER/PWD + chain writes)
  readonly [key: string]: unknown;               // plugin trackers (e.g. `branch`)
}
```

`exec` is memoized per `(cmd, args, cwd)` within a single tool_call — two rules reading the same git state don't re-fork git. No cross-call cache.

`PredicateToolInput.args` on bash gives you the `Word[]` suffix — quote-aware; `.text` / `.value` carry the ENV-RESOLVED runtime forms (`text` quote-preserving, `value` unquoted) and `rawText` exposes the original source token. Use this when a predicate needs to read `-m "feat: x"` without losing the quoted content.

`walkerState.env` carries the per-ref env map: bare assignments (`FOO=bar`), `export NAME=value`, and `unset NAME` from the same bash chain, plus `HOME`/`USER`/`PWD` seeded from `process.env` at session start. Use it to resolve `$VAR` / `${VAR}` / `~` in user-supplied patterns via the `resolveWord` helper re-exported from the package root:

```ts
import { resolveWord } from "@cad0p/pi-steering";

const myPredicate: PredicateHandler = (args, ctx) => {
  const expanded = resolveWord(userWord, ctx.walkerState!.env);
  return expanded !== undefined && /workspace/.test(expanded);
};
```

`resolveWord` returns `undefined` when any part of the word is statically intractable (unknown var, command substitution, arithmetic, parameter-expansion with modifiers). Handle that the same way the built-in `when.cwd` does — via an `onUnknown: "allow" | "block"` policy on your own predicate surface.

### `requires:` / `unless:` (transient — dated retirement)

`requires` (AND extra) and `unless` (same-rule exemption) predate the `when:` clause tree and stay supported, but they are transient: once [`pi-steering-github#61`](https://github.com/cad0p/pi-steering-github/issues/61) (the `gh` CLI table) lands, they are restricted to write/edit rules and eventually retired in favor of `when:` leaves — the restriction/retirement issue ([#121](https://github.com/cad0p/pi-steering/issues/121)) tracks the date. New rules should use `when:` (+ named plugin predicates) instead; `requires:` / `unless:` / `watch` patterns survive wherever already written.

### `onFire`

`Rule.onFire` runs after all predicates pass and BEFORE the block verdict is returned. Use it for self-marking patterns:

```ts
{
  name: "commit-description-check",
  tool: "bash",
  command: "git",
  when: {
    subcommand: "commit",
    missing: { event: "description-reviewed", in: "agent_loop" },
  },
  reason: "Re-read the commit message first.",
  writes: ["description-reviewed"],
  onFire: (ctx) => ctx.appendEntry("description-reviewed", {}),
}
```

First commit per agent loop blocks + self-marks. Second commit in the same loop: the self-mark satisfies `when.missing`, commit passes.

`onFire` errors are caught, logged, and the block still returns. The block already passed every predicate; a broken self-mark should not invalidate it.

### Observers

```ts
interface Observer {
  name: string;                                  // deduped across plugins
  writes?: readonly string[];
  watch?: ObserverWatch;
  onResult(event, ctx): void | Promise<void>;
}

interface ObserverWatch {
  toolName?: string;
  inputMatches?: Record<string, Pattern>;
  exitCode?: number | "success" | "failure" | "any";
}
```

Observers fire on matching `tool_result` events. `watch.inputMatches.command` is **wrapper-aware** — a regex for `/^npm\s+test/` matches both `npm test` and `sh -c 'npm test'`.

**Watch matching resolves the same walk registry as rules.** `watch.inputMatches.command` against a bash event rewinds the command through the SAME tracker registry the rule surface uses (via `internal/walk-registry.ts`'s `buildWalkRegistry(resolved)`), so plugin-composed env trackers (`trackers: { env }` or `trackerExtensions.env`, e.g. an `.envrc`-style loader) are honored on the watch side too — an observer pattern matches what the command actually resolves to, not the raw `$VAR` form. Each dispatch resolves against the per-event `ctx.cwd`. Caveats: (a) the LATCH idiom `when: { not: { missing: { event } } }` depends on an observer recording that event — if the watch surface can't resolve (or a command fails to parse), the latch goes inert / raw-only (fail-open); observers written for the raw token, by contrast, still fire when the raw OUTER command carries the literal token (see `internal/watch-matcher.ts`).

`observerCtx.appendEntry` auto-tags writes with `_agentLoopIndex`. Don't inject that tag yourself. Use `ctx.findEntries<Payload>(type)` to read prior entries back.

### `writes` declarations

Both `Rule.writes` and `Observer.writes` are optional string-literal arrays naming the custom session-entry event types the handler may `appendEntry`. They have **zero runtime cost** — the engine never reads them at dispatch time. Their sole purpose is compile-time cross-referencing inside {@link defineConfig}:

```ts
// observer ships the event
const syncObserver = {
  name: "ws-sync-tracker",
  writes: ["ws-sync-done"],
  watch: { toolName: "bash", inputMatches: { command: /^sync\b/ }, exitCode: "success" },
  onResult: (_event, ctx) => ctx.appendEntry("ws-sync-done", {}),
} as const satisfies Observer;

export default defineConfig({
  observers: [syncObserver],
  rules: [{
    name: "cr-needs-sync",
    tool: "bash",
    command: "cr",
    // `event` is type-narrowed to the union of all declared `writes`
    // across plugins + user observers. A typo like "ws-sync-don" is
    // rejected by the compiler.
    when: { missing: { event: "ws-sync-done", in: "agent_loop" } },
    reason: "Run sync first.",
  }],
});
```

When you skip declaring `writes`, the observer's produced events stay out of the `AllWrites` union and `when.missing.event` references to them are rejected as typos. The failure mode biases toward catching real typos (a plugin typo producing a non-firing rule turns into a compile error) at the cost of requiring each producer to enumerate its events once.

### Temporal ordering with `missing.since`

Sometimes "X occurred" isn't enough — a later event should invalidate it. `missing.since` adds an optional invalidation sentinel:

```ts
{
  name: "cr-needs-fresh-sync",
  tool: "bash",
  command: "cr",
  when: {
    missing: {
      event: "ws-sync-done",
      in: "agent_loop",
      since: "upstream-failed",
    },
  },
  reason: "Upstream failed after your last sync. Re-sync before cr.",
}
```

Semantics: the event counts as present only if its most-recent entry in scope is strictly newer than the most-recent `since` entry. If `since` has never been written in scope, the clause degrades to the simple presence check — so adding `since` is safe even when the invalidator isn't in play yet.

Contrast with a hand-rolled `condition:` handler doing the same comparison: `since` is declarative, cross-checked at compile time (both `event` and `since` are constrained to the `Writes` union), and shared across rules without duplicating helper code. Reach for `condition` only when the comparison isn't "my event after their event" — e.g. counting, content matching, or quorum across multiple invalidators.

### `&&`-chain speculative allow

Agents frequently chain related commands in one tool_call:

```bash
sync && cr --description notes.md
```

The naive evaluation path blocks this chain: the evaluator runs BEFORE execution, so when it sees `cr`, the observer hasn't written `ws-sync-done` yet. Rule fires, block, retry, same block — an infinite loop.

pi-steering resolves this via a walker-level **speculative-entry synthesis pass**. For every ref in an unconditionally-`&&`-reachable segment, every observer declaring `writes: [event]` and matching the ref (via the shared `watch` filter) contributes a synthetic entry into the next ref's `walkerState.events[event]`. The built-in `when.missing` then merges these synthetic entries with real session entries by timestamp — so a speculative `ws-sync-done` entry satisfies the rule exactly as a real one would, and the chain is allowed.

`&&` short-circuits on the prior's failure, so the speculative decision is safe: either the prior succeeds (and writes the event, retroactively justifying the allow), or it fails and the current ref never runs. Synthetic entries carry `speculative: true` so plugin predicates wanting pure historical semantics can filter them out; the built-in `missing` treats real and speculative entries identically.

**Which joiners qualify:**

| Joiner | Speculative allow? | Reason |
|---|---|---|
| `A && B` | ✅ | B runs only if A succeeded |
| `A ; B`  | ❌ | B runs regardless of A |
| `A \| B` | ❌ | pipeline, no ordering |
| `A \|\| B` | ❌ | B runs only if A FAILED |

**Authoring requirement.** Observers participating in the speculative allow must declare `watch.inputMatches.command`. An observer matching every bash event isn't a strong enough signal to grant the allow.

Worked example:

```ts
const syncObserver = {
  name: "ws-sync-tracker",
  writes: ["ws-sync-done"],
  watch: { toolName: "bash", inputMatches: { command: /^sync\b/ }, exitCode: "success" },
  onResult: (_e, ctx) => ctx.appendEntry("ws-sync-done", {}),
} as const satisfies Observer;

const crNeedsSync = {
  name: "cr-needs-sync",
  tool: "bash",
  command: "cr",
  when: { missing: { event: "ws-sync-done", in: "agent_loop" } },
  reason: "Run `sync` first.",
} as const satisfies Rule;

// Given the pair above:
// bash `sync && cr ...` → allowed (cr has prior-&& ref matching the sync observer)
// bash `cr ...`         → blocked (no prior && ref, observer hasn't fired yet)
// bash `sync ; cr ...`  → blocked (semicolon doesn't short-circuit)
```

### Compile-time safety via `defineConfig`

```ts
import { defineConfig } from "@cad0p/pi-steering";

export default defineConfig({
  plugins: [gitPlugin, myPlugin],
  rules: [
    {
      name: "must-read-docs",
      tool: "bash",
      command: "npm",
      when: { subcommand: "publish" },
      observer: "description-read",               // ← typo-checked against plugin + inline observers
      when: { missing: { event: "doc-read", in: "agent_loop" } },  // ← event literal checked against writes
      reason: "Read the release notes before publishing.",
    },
  ],
  disabledRules: ["no-main-commit"],                // ← typo-checked against rule names
  disabledPlugins: ["git"],                         // ← typo-checked against plugin names
});
```

**Plugin-shipped exemption targets are checked too.** A plugin's `exemptions` carve out rules by name — possibly rules shipped by another plugin. Those targets are cross-checked against the same rule-name universe as user-written `exemptions` / `disabledRules` (listed plugins' rules + inline rules): a plugin whose carve-outs target rules shipped by a plugin you didn't list fails to compile, pointing at the offending plugin element (the message names the missing rule(s) and hints to install the shipping plugin). Two by-design gaps: a `: Plugin` annotation widens `exemptions[].rule` to `string` and silently skips the check (the runtime `exemption-orphan` backstop still covers those authors — plugin-shipped orphans are error-class at merge, so the session always throws regardless of `failOnWarnings` and the CLI exits 1), and cross-layer config splits (plugin in global, its target's shipping plugin in a project layer) can false-positive because the check is per-file while the runtime merges universes — keep the plugin and its target's shipping plugin in the same layer.

**Authoring gotcha.** For cross-reference checking to work, TypeScript must preserve literal types. Use `as const satisfies` on reusable constants:

```ts
// ✅ works
const myRule = { name: "x", writes: ["thing"], ... } as const satisfies Rule;

// ❌ widens to `name: string` + `writes: readonly string[]` — breaks inference
const myRule: Rule = { name: "x", writes: ["thing"], ... };
```

See [`src/v2/schema.ts`](./src/v2/schema.ts) `Rule.writes` JSDoc for the full footgun explanation.

## Writing plugins

A plugin is a named bundle of predicates / rules / observers / trackers / tracker extensions. Users opt in via `plugins: [...]`.

### Shape

```ts
interface Plugin {
  name: string;
  predicates?: Record<string, PredicateHandler>;
  rules?: Rule[];
  observers?: Observer[];
  trackers?: Record<string, Tracker<unknown>>;           // new state dimensions
  trackerExtensions?: Record<string, Record<string, Modifier<unknown> | readonly Modifier<unknown>[]>>;
}
```

### Canonical file layout (ADR §13)

```
src/
├── index.ts                              # default export: Plugin; re-exports
├── index.test.ts                         # plugin-level integration
├── predicates/
│   ├── <predicate>.ts
│   └── <predicate>.test.ts
├── observers/
│   ├── <observer>.ts                     # exports TYPE constant + mark helper + observer
│   └── <observer>.test.ts
└── rules/
    ├── <rule-or-group>.ts
    └── <rule-or-group>.test.ts
```

### Observer encapsulation convention (ADR §14)

Every observer file exports three things:

1. A `<EVENT>_EVENT` constant — the session-entry event literal.
2. A `mark<Event>(ctx)` helper — encapsulates the shape of what gets written.
3. The observer itself, using the helper.

Rules that consume the event import the EVENT constant, never the raw string. When no observer corresponds (self-marking rule only), the constant + helper live in the rule file instead.

See [`examples/work-item-plugin/src/observers/npm-test-tracker.ts`](./examples/work-item-plugin/src/observers/npm-test-tracker.ts) for a complete file following this pattern.

### Typed predicate handlers

```ts
import { definePredicate } from "@cad0p/pi-steering";

interface BranchArgs {
  pattern: RegExp;
  onUnknown?: "allow" | "block";
}

export const branch = definePredicate<BranchArgs>(async (args, ctx) => {
  // args is narrowed to BranchArgs here.
  return args.pattern.test(await resolveBranch(ctx));
});
```

`definePredicate<T>` is a zero-cost type helper — pure pass-through at runtime. Use it so plugin authors can declare typed arg shapes without having to cast at the plugin registration site.

### The canonical reference

[`examples/work-item-plugin/`](./examples/work-item-plugin/) is a compact, domain-generic plugin that demonstrates every v0.1.0 authoring pattern in one place. Read it top-to-bottom — the structure is meant to be copied.

Production plugins in this repo:

- [`src/plugins/git`](./src/plugins/git) — the canonical plugin reference for trackers + tracker extensions. Ships `branch` / `upstream` / `commitsAhead` predicates, a `branchTracker`, a `--git-dir` / `--work-tree` cwd extension, and the `no-force-push` / `no-hard-reset` / `no-main-commit` + `no-main-commit-github` rules.
- [`pi-steering-flags`](https://github.com/cad0p/pi-steering-flags) — first official external plugin, establishing the precedent for community plugins. Own repo + package since the monorepo split (2026-08-10). Ships `requiresFlag` / `allowlistedFlagsOnly` policy predicates; the flag MECHANISM lives in core as the context-provided `ctx.command` view (`hasFlag` / `getFlagValue` / `getAllFlagValues` / `hasEnvAssignment` / `isInfoOnly`, #101) — no import needed inside predicates, conditions, or reason functions:

```ts
// In a predicate / condition / reason fn with ctx:
import { GIT_CLI_DESCRIPTOR } from "@cad0p/pi-steering/plugins/git";

const { flags: git } = GIT_CLI_DESCRIPTOR;
ctx.command.hasFlag(git.noPager);
ctx.command.getAllFlagValues(git.config); // ["a=b", "c=d"], argv order
ctx.command.positionals(); // ["push", "origin", ":branch"], subcommand INCLUDED
```

Out-of-handler / test use goes through the factory (imported from the package root):

```ts
import { commandFromInput } from "@cad0p/pi-steering";
```

Bound arity is table-bound with no per-call opts (#110): the engine binds each ref's `arityOf(basename, descriptors, cache)` into `ctx.command`, so `getFlagValue` / `getAllFlagValues` / `positionals()` share one consumption source and cannot diverge. Unlisted flags never consume (strict always); attached `--flag=value` forms always apply; glued `-X<rest>` applies iff X derives from the table. `positionals()` is `--`-aware (everything after a bare `--` surfaces verbatim) while `when.flag` still scans post-`--` tokens as present (walker limitation, unchanged). No descriptor for the ref's basename → `MissingDescriptorError` block (loud); obscure binaries with no owning plugin declare via an inline plugin literal `plugins: [{ name: "my-facts", cliDescriptors: { mycli: { flags: { repo: { aliases: ["-R"], takesValue: true } } } } }]` — or `{ mycli: {} }` for explicit strict.

- [`pi-steering-commit-format`](https://github.com/cad0p/pi-steering-commit-format) — commit-message format predicates. Own repo + package since the monorepo split (2026-08-10). Ships the `commitFormat` predicate plus a `commitFormatFactory` for composing custom format checkers; bundled formats include Conventional Commits 1.0.0 (Angular preset type allowlist) and bracketed JIRA-style references.

### Ecosystem discovery

Tag your plugin's `package.json` `keywords` with:

```jsonc
{
  "keywords": [
    "pi-package",            // surfaces on pi.dev alongside every pi extension
    "pi-steering-package"    // surfaces specifically for pi-steering plugins
    // ...plus any domain tags (cli, git, test-runner, ...)
  ]
}
```

- `pi-package` is pi's ecosystem-wide convention.
- `pi-steering-package` is the pi-steering plugin-specific tag. Community plugins using it will be surfaced in pi-steering's plugin directory (once one exists) without needing a manual registry.

Publishing conventions:

- **Package name**: `pi-steering-<domain>` (unscoped). Mirrors `@cad0p/pi-steering` core and `pi-steering-flags`. Scoped names (`@org/pi-steering-<x>`) are fine for internal packages.
- **Peer range**: pin to a major once `@cad0p/pi-steering` is v1+ (`"pi-steering": "^1"`). During the v0.x window, match the release train closely (`"pi-steering": "^0.1.0"`).
- **Pre-1.0 breaking policy (expires at v1.0)**: during the v0.x window, breaking changes ship without deprecation shims — no compat re-exports, no dual surfaces, no semver base releases (CalVer prereleases only). Every shim is a stability promise that narrows future design, and pre-1.0 pins are owner-controlled or train-pinned. Precedents: #72 (zero default rails, no alias), #76 P3 (no compat re-export), #101 (bare helpers deleted a week after shipping), #110 (legacy `valueConsumingFlags` guard removed outright rather than diagnosed). No stale-shape detection either: a deleted schema key is ignored, never diagnosed — pin your `@cad0p/pi-steering` dep, read the changelog, and let `tsc` surface staleness (stale string queries / removed imports are compile errors). Treat every minor as potentially breaking. At v1.0 this flips to semver-stable with deprecation periods.
- **License**: MIT by default, matching the core. Amazon-internal / proprietary plugins use their own license; the core has no opinion on this.

### Dependency rule

Do NOT take a direct dependency on `@cad0p/unbash-walker` from a plugin — import the walker helpers you need from the `@cad0p/pi-steering` package root instead. One version, one policy table, one scan loop: a skewed local copy is a guardrail-correctness bug, not a hygiene nit. If the helper you need isn't re-exported yet, file a re-export issue (see #87 / #91 for the template) rather than vendoring it. The re-export surface stays deliberately minimal — every re-export is a stability promise.

The same rule applies to flag reads — use the context-provided command view, not the flags plugin:

```ts
// In a predicate / condition with ctx:
import { GIT_CLI_DESCRIPTOR } from "@cad0p/pi-steering/plugins/git";

ctx.command.hasFlag(GIT_CLI_DESCRIPTOR.flags.noPager); // bound to the already-parsed args
```

Entries always come from the owning plugin's table — never hand-build literals in rules. A typo'd `"--delet"` string was a silent fail-open skip; a typo'd `flags.delet` property is a compile error.

(`hasFlag` / `getFlagValue` / `getAllFlagValues` / `positionals` / `hasEnvAssignment` / `isInfoOnly` live on `ctx.command` since #101, which replaced the P3 (#99) bare-helper root exports; entry-only since #110 (`CLIFlag` on the root, `FlagLookupOptions` deleted). Out-of-handler use goes through the root-exported `commandFromInput` factory + `SteeringCommand` type. The flags plugin keeps only the POLICY predicates `requiresFlag` / `allowlistedFlagsOnly`.)

### Overriding a built-in rule

Plugin-shipped rules are individually exported from their plugins (see `pi-steering/plugins/git`'s named exports). To tighten a rule's reason message — e.g. pointing your agents at an internal skill or team runbook — disable the original and re-register under a new name:

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin, { noMainCommit } from "@cad0p/pi-steering/plugins/git";
import type { Rule } from "@cad0p/pi-steering";

// Reuse everything about the original, just swap the reason.
const myNoMainCommit = {
  ...noMainCommit,
  name: "myorg-no-main-commit",
  reason: async (ctx) => {
    const original =
      typeof noMainCommit.reason === "function"
        ? await noMainCommit.reason(ctx)
        : noMainCommit.reason;
    return `${original}\n\nFor our workflow, see skill \`git-discipline@myorg\` or run \`pi-help git-flow\`.`;
  },
} as const satisfies Rule;

export default defineConfig({
  plugins: [gitPlugin],
  disabledRules: ["no-main-commit"],  // original off
  rules: [myNoMainCommit],            // replacement on
});
```

`as const satisfies Rule` preserves literal types so `defineConfig`'s cross-reference checks (on `missing.event`, `observer`, etc.) still run on the replacement. No need to restate `command` / `when` / `observer` / `onFire` — the spread carries them through.

Changing more than the reason (tightening the match, scoping by cwd, swapping the observer) works the same way: spread the original, then override the fields you want to change.

> **Always use a fresh `name` for the replacement.** Reusing the plugin rule's name has two failure modes — same name + no `disabledRules` keeps both rules (your customization silently fails to apply) and same name + `disabledRules` filters out both (silent fail-OPEN, the worst outcome for a safety rule). The git plugin's [Customization](./src/plugins/git/README.md#customization) section walks through worked examples (soften the reason text; cwd-based exemption with the array-form `cwd:` predicate's `onUnknown: "allow"` pin to keep `not:` carve-outs fail-closed under walker-unknown cwd).

### Exemptions (the registry)

**Exemptions narrow a guard rule without copying or replacing it.** An `Exemption` is a name-keyed carve-out: when its `when` clause matches a candidate, the target rule does NOT fire — evaluation continues to the next rule exactly as if the rule had missed.

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  exemptions: [
    {
      rule: "no-main-commit",
      when: { cwd: /\/Goldmine\// },
    },
  ],
});
```

**Accumulation, not replacement.** Exemptions attach by target name to whichever rule wins that name after `disabledRules` filtering — the winning rule's body doesn't matter, only its name. Config-layer exemptions UNION across layers (project + global both apply, no inner-wins), and plugin-shipped exemptions (`Plugin.exemptions`) stack on top. Multiple exemptions for the same rule are OR-ed: ANY matching clause exempts. Duplicates are idempotent; there is no collision concept.

Inside `defineConfig`, `exemptions[].rule` is typo-checked against the same rule-name union as `disabledRules`, and `when.missing.event` narrows against the config's `writes` union. Plugin-shipped exemption targets get the same universe, cross-checked from the `plugins` tuple: a plugin whose carve-outs target a rule shipped by a plugin you didn't list fails to compile with a per-plugin `__steeringExemption` error (the runtime `exemption-orphan` backstop still covers plugins annotated `: Plugin`, whose widened `rule: string` silently skips the check — plugin-shipped orphans are error-class, so the session always throws regardless of `failOnWarnings` and the CLI exits 1; `satisfies` / JSON / JS config-written orphans stay warning-class and remain fail-soft).

**Fail-closed is STRICT — no escape hatch.** Exemption clauses evaluate with an "allow"-default projection — the OPPOSITE default from rule `when:` clauses. A predicate that can't resolve (walker-unknown cwd, a throwing handler, an unregistered predicate key) counts as "does not match", so the guard still fires. Exemptions are always fail-closed: an unknown walker value never exempts; the target rule's own `onUnknown` policy decides. `onUnknown` cannot be written inside an exemption (compile error; rejected at load if smuggled via `as any` / plain JS). A carve-out — even one shipped by a third-party plugin — can never weaken the guard's fail-closed posture.

**Interplay with disables.** An exemption targeting a rule that exists but is disabled (via `disabledRules` or a disabled plugin) is inert and silent — by-design disable, no diagnostic. An exemption targeting a rule name that doesn't exist anywhere in the merged config surfaces an `exemption-orphan` diagnostic: error-class when shipped by a plugin (a broken plugin/config contract — the session always throws regardless of `failOnWarnings`, the CLI exits 1), warning-class when written in config (strict mode throws, else `console.warn` — so config typos fail loudly instead of silently shipping a dead carve-out).

**`unless` disambiguation.** `Rule.unless` is a per-rule, same-rule-scope optional exemption field. The registry is the cross-plugin ACCUMULATION mechanism: plugin A can exempt rule B (shipped by another plugin) by name, and multiple authors' carve-outs stack. `unless` cannot do that — it only lives on the rule it exempts.

`pi-steering list` renders the merged Exemptions section (only when non-empty) and the JSON output carries an additive `exemptions` key; see the [CLI](#cli) section.

## Walker extensibility

Plugin authors who need a new walker state dimension (something beyond `cwd` / `env` / `branch`) register a `Tracker<T>` under `Plugin.trackers`. The engine composes trackers at config load and feeds the merged map into unbash-walker's `walk()`.

Tracker authoring is a larger topic — see the [unbash-walker README](https://github.com/cad0p/unbash-walker) for the full `Tracker<T>` / `Modifier<T>` API. Plugins extend an existing tracker (e.g. layering a `--git-dir=…` parser on the core cwd tracker) via `Plugin.trackerExtensions`. Name collisions on `Plugin.trackers` are a hard error; modifier collisions log a WARN and keep the first-registered.

Most users never need this — plugin-registered predicates alone cover 90% of use cases.

### Shell-var expansion (`envTracker` + `resolveWord`)

The engine ships an `envTracker` alongside the built-in `cwdTracker`. It captures statically-resolvable env mutations from the same bash chain:

- Bare assignments: `WS_DIR=/ws; cd "$WS_DIR/pkg"` → `walkerState.env.get("WS_DIR") === "/ws"` at the `cd`, `walkerState.cwd === "/ws/pkg"` at the following commands.
- `export NAME=VALUE` and `unset NAME`.
- Subshell isolation: `(FOO=/s; cd "$FOO"); cmd` — outer `cmd` sees neither `FOO` nor the subshell's `cd`.
- Seeded from `process.env.{HOME, USER, PWD}` at tracker initialization, so `~` / `$HOME` / `$USER` / `$PWD` expand out of the box.

Out of scope for v0.1.0: `readonly`, `local`, `declare`, `typeset`, `source` / `.`, function-body walking. The envTracker's module-level JSDoc (`src/trackers/env.ts` in the [unbash-walker repo](https://github.com/cad0p/unbash-walker)) lists the full deferred-scope inventory and graduation criteria.

**`resolveWord(word, env)`** — re-exported from the package root — is the shared helper the built-in `cd` modifier uses to resolve a dynamic word (`$VAR`, `${VAR}`, `~`) through an env map. Plugin predicates that want the same semantics on user-supplied args should reuse it:

```ts
import { resolveWord, type PredicateHandler } from "@cad0p/pi-steering";

export const matchesHome: PredicateHandler = (args, ctx) => {
  const word = /* one of ctx.input.args */ args as Word;
  const resolved = resolveWord(word, ctx.walkerState!.env);
  return resolved !== undefined && resolved.startsWith("/home/");
};
```

Returning `undefined` means the word is statically intractable (unknown var, command substitution, arithmetic, parameter-expansion with modifiers). Handle it via an `onUnknown`-style policy on your predicate's option shape.

**Prefix assignments are one-shot — words resolve against the chain snapshot (bash §3.7.1).** The shell expands a command's WORDS against the PRE-command environment; a prefix assignment (`NAME=value cmd …`) binds only for the DIRECT CHILD's environment, not for the same command's word expansions. So `BODY=x echo "$BODY"` in bash prints the OLD value of `BODY`, and pi keeps the word RAW here — fail-closed — rather than resolving it against the prefix and letting predicates match a fiction:

```bash
# pi resolves words against the walker chain env snapshot only:
BODY=x echo "$BODY"      # word stays raw ("$BODY") — prefix is one-shot
BODY=x && echo "$BODY"   # chain form — resolves to `x` (canonical shape)
```

A predicate that genuinely needs the child-env view (prefix applied to the direct child only) can fold the assignments sequentially itself: `new Map([...ctx.walkerState.env, ...resolveEach(envAssignments)])` where `resolveEach` resolves each `KEY=VALUE` RHS against the running map — bash's RHS is sequential (`A=1 B=$A cmd` → `B=1`).

## Testing rules

The package exports a `@cad0p/pi-steering/testing` subpath with primitives that exercise the full pipeline without booting pi:

```ts
import { loadHarness, expectBlocks, expectAllows, testPredicate, testObserver }
  from "@cad0p/@cad0p/pi-steering/testing";
```

### Harness-level

```ts
const harness = loadHarness({
  config: { plugins: [myPlugin], rules: [...] },
});

await expectBlocks(
  harness,
  { command: "git push --force" },
  { rule: "no-force-push" },
);

await expectAllows(harness, { command: "git push" });
```

`loadHarness` runs the same `resolvePlugins` + `buildEvaluator` + `buildObserverDispatcher` path as production. `expectBlocks` / `expectAllows` accept bash/write/edit shorthand plus full `ToolCallEvent` shapes. Optional `rule` / `reason` fields on `expectBlocks` narrow the assertion.

### Unit-level

```ts
// Predicate in isolation:
const fires = await testPredicate(branch, /^main$/, {
  walkerState: { branch: "main" },
});

// Observer in isolation:
const { entries, watchMatched } = await testObserver(
  myObserver,
  { toolName: "bash", input: { command: "npm test" }, output: {}, exitCode: 0 },
);
```

`testPredicate` builds a `PredicateContext` (see `MockContextOptions` for knobs — `exec` stub, `entries`, walker state, etc.) and calls the handler. `testObserver` does the same for observers, returning the `appendEntry` captures and whether the `watch` filter accepted the event.

### Adversarial matrices

For bug-pinning tables:

```ts
import { runMatrix, formatMatrix } from "@cad0p/@cad0p/pi-steering/testing";

const result = await runMatrix(harness, [
  { name: "raw",           event: { command: "git push --force" },           expect: "block" },
  { name: "subshell",      event: { command: "sh -c 'git push --force'" },   expect: "block" },
  { name: "sudo",          event: { command: "sudo git push --force" },      expect: "block" },
  { name: "quoted-arg",    event: { command: "git push '--force'" },         expect: "block" },
  { name: "false-friend",  event: { command: "echo 'git push --force'" },    expect: "allow" },
]);
console.log(formatMatrix(result));
```

The `examples/work-item-plugin` tests use exactly this pattern.

### Contributor test conventions: no redundant pins

Tests for a module live in that module's test file. Before adding
pins, grep the existing suite for the behavior — helpers, matrix rows,
and `rawOnly`-style fixtures often already cover it. Extend in place;
a new test file needs a one-line justification in the PR body stating
what the existing suite doesn't cover. Frozen characterization suites
stay byte-frozen: new behavior pins go in the same file unless the
surface is genuinely separate. Reviewers check overlap the same way
(the redundancy lens): a new file duplicating pinned behavior gets
folded or cut, however green it is.

## CLI

### `pi-steering list`

Load the project layer (`<cwd>/.pi/steering/`) and the global layer (`~/.pi/agent/steering/`), merge them project-first, and print the resolved state:

```bash
$ pi-steering list
Resolved config: 1 plugin, 2 rules, 0 observers.

git  [pi-steering/plugins/git]
  no-main-commit            bash  when: branch

User (project + global):
  no-force-push             bash

Disabled: (none)
```

JSON output for machine consumers:

```bash
pi-steering list --format=json
```

No config → "No steering config found." and exit 0.

### `pi-steering import-json`

One-shot conversion from a v1 JSON config to a v0.1.0 TypeScript config:

```bash
pi-steering import-json .pi/steering.json -o .pi/steering/index.ts
```

Emits a `defineConfig({...})` module using JSON-literal rendering. Write/edit rule patterns come across verbatim; `requires` / `unless` / override semantics are preserved. Bash rules do NOT round-trip (`pattern:` was removed — rewrite as `command:` + `when:` leaves in TypeScript). Plugins, observers, and function-valued predicates are rejected — those features only exist in the TypeScript shape and must be authored directly.

## Override comments

For overridable rules (`noOverride: false`), the agent can annotate a tool call with an inline comment to bypass the block:

```bash
npm run deploy # steering-override: advisory-no-deploy
```

Here `advisory-no-deploy` is a user-authored rule that opted into overridability (`noOverride: false`). The shipped git-plugin protected-branch guards (`no-main-commit` / `no-main-commit-github`) do **not** accept overrides — they are strict since issue #79.

The engine parses the comment before AST extraction (so the override persists across wrappers). Overrides are recorded as `steering-override` session entries for audit.

**Default is `noOverride: true` (fail-closed).** Rules must explicitly opt INTO overridability. Set `defaultNoOverride: false` at config top-level to flip the default if your guardrails are mostly advisory.

## Security and trust boundaries

pi-steering is a guardrail layer, not a sandbox. Several parts of the system execute arbitrary code your config authors control, and a few state surfaces are trusted by convention rather than enforced. Understand these boundaries before running pi under an untrusted config tree.

### Config execution

`.pi/steering/index.ts` (and the `.pi/steering.ts` shorthand) is **arbitrary TypeScript executed at the first `session_start` with your full user privileges** (the bridge builds the steering runtime lazily, anchored on the session's `ctx.cwd`). The loader reads exactly two layers — the project layer at `<session-cwd>/.pi/steering/` and the global layer at `<agentDir>/steering/` — and merges them project-first (the project layer wins on name collisions).

One-shot CLI contexts (`pi config`, `pi list`) never fire `session_start`, so they **never execute steering configs** — a trust improvement: running `pi config` in an untrusted directory no longer runs that directory's config code, and a strict-mode config can't pollute the CLI's output (see "Strict mode + load failures" below).

Implication: running pi inside a directory hierarchy whose steering configs you don't trust is equivalent to running `node -e '…'` with that same file. Symlinked config directories are followed — a symlinked `.pi/steering/` landing in an unexpected directory executes as if it had been placed there directly.

Only run pi in directory hierarchies whose steering configs you trust.

### Project trust gate

The project layer loads **only when the project is trusted** — pi-steering adopts pi's RESOLVED project-trust decision rather than asking its own question. Trusted means: the directory has no trust-requiring pi resources, or pi's trust store (`<agentDir>/trust.json`, `~/.pi/agent/trust.json`) holds a `true` entry for it (or an ancestor) — resolved via pi's startup trust prompt, `pi --project-trust-override`, or the trust store. Untrusted projects skip the project layer with an info-class breadcrumb (`[pi-steering] [info] …project layer skipped`); the **global layer always loads**, so global steering keeps working in untrusted trees. Steering-only projects (no `.pi/settings.json`, `.pi/extensions`, …) are **never gated** — pi auto-trusts them, so the gate is inert there. The approval path is pi's own trust flow (prompt / store / override); pi-steering never prompts, never writes trust.json, and never resolves trust itself. `pi-steering list` mirrors the same non-UI formula and reports `projectLayerTrusted` in its JSON output; the mirror is cross-checked against pi's real trust machinery by a live-oracle fidelity test on every CI run, plus a scheduled weekly workflow that bumps pi and files a `[drift]` issue on any mismatch.

### Plugin trust

Plugins register predicates (`when.<key>` handlers), observers, and `onFire` hooks — all of which **run arbitrary code during the evaluator's hot path**. A malicious or buggy plugin can:

- Shell out via `ctx.exec` (with the same privileges as pi).
- Forge session entries via `ctx.appendEntry`, which later rules consult via `when.missing`.
- Throw in unexpected places — predicate-runtime throws fail open (the rule never fires). Session-start load failures throw with strict mode; see "Strict mode + load failures" below for the opt-out.

A malicious plugin can trivially defeat any guardrail ship with your config. Review plugin source before adding it to `plugins: [...]` the same way you'd review any third-party dependency.

### Session JSONL trust

`when.missing` reads entries tagged via `appendEntry`. The write path (`createAppendEntry`) is engine-controlled — every write gets the current `_agentLoopIndex` stamped on it automatically, and names go through name validation.

The **read path (`findEntries`) treats every tagged entry in the session JSONL as authentic**. Entries written OUTSIDE the engine (direct JSONL writes by another pi extension, hand-edited session files, a `pi.appendEntry` call from non-steering code) can forge type tags and trick `when.missing` into thinking an event occurred when it didn't — bypassing rules that gate on that event.

This is the out-of-band trust boundary. Within the steering engine, the invariant holds; cross-extension and external writes are outside the engine's reach.

### Strict mode + load failures

Strict mode = `failOnWarnings: true`, the default. Opt out per-config-layer with `failOnWarnings: false`.

If your steering config fails to load (a plugin throws during import, a syntax error in `index.ts`, `pnpm` fails to resolve a dependency), the failure surfaces at the **first `session_start`** of each session: the bridge catches strict-mode aggregate diagnostics and writes the **full aggregated body** to `console.error` **and** shows it as an in-chat error notification (toast). The session runs **unsteered** (fail-closed — the same as an extension that failed to load). A broken config is **no longer fatal at boot**: pi opens normally, the toast tells you exactly what's wrong, and you can fix it.

Default behavior: any warning-class loader/merger diagnostic (cross-layer plugin name collision, within-layer rule/observer collision, predicate-key collision, etc.) escalates to the same aggregate throw at session start. Error-class diagnostics (tracker-name collision, reserved-name violations) ALWAYS throw. The aggregated message lists every diagnostic with errors first, one bullet per issue. Non-diagnostic engine errors are rethrown and render as a regular `Extension "..." error:` line — they are never mislabeled as config issues.

Opt out of warning-class escalation by setting `failOnWarnings: false` on any layer of your config:

```ts
import { defineConfig } from "@cad0p/pi-steering";
export default defineConfig({
  failOnWarnings: false,   // legacy fail-soft semantics for warnings
  plugins: [/* ... */],
});
```

With `failOnWarnings: false`, warning-class diagnostics fall through to `console.warn` (single-line `[pi-steering] [warning] <message>` shape on stderr) and the bridge keeps running with the merged config. Error-class diagnostics still throw — the engine cannot operate safely with two plugins claiming the same state dimension.

**Recovery loop: fix the config and `/reload`.** Every reload — and every `/new`, `/resume`, `/fork` — binds a fresh extension instance whose first `session_start` re-runs the build, so re-validation is automatic (`session_start` carries `reason: "reload"`). For an in-TUI look at what the bridge would load, run `pi-steering list` (prints the merged config) instead of relying on `console.warn`/`console.error`, which pi's interactive TUI clobbers.

### Cross-project resume

When you `pi --resume` a session originally created in another project (Tab → "All" scope in the picker), steering rules are built from the **session's** cwd (`ctx.cwd`), not from wherever you launched pi. Only the project layer's anchor moves: rules load from `<session-cwd>/.pi/steering/` plus the unchanged global `<agentDir>/steering/` layer (which matches pi's own resource cwd). There is no launch-vs-session mismatch, and no warning to go with it.

Downside (accepted): resuming a foreign session from a directory with strict rules silently drops the launch directory's project layer — the ruleset switch is silent and guardrails may be weaker in the "supervise a foreign session" workflow. To keep the current directory's guardrails while adopting a foreign conversation, **fork the session instead**: `pi --fork <session>` copies it into the current directory (the `--session <foreign-id>` path from a different project prompts "Fork this session into current directory?" — accept to fork), and the forked session's cwd is the launch directory, so it builds from the launch-dir project layer. If you want the session's own rules, resume it and launch pi from the session's directory — the launch directory no longer decides.

### Block-reason tag trust

The `[steering:<name>@<source>]` tag prepended to every block reason is only as trustworthy as your plugin authors. Name validation (regex-constrained rule / plugin / observer names) prevents tag SPOOFING — a name like `phony] ALL CLEAR [real` would have forged the tag; now it throws at load time. (The engine's fixed not-executed preamble precedes the tag on every block reason — issue #85.)

Beyond the tag shape, the contents are plugin-authored. A plugin shipping a rule with `reason: "[steering:other-rule@other-plugin] …"` can make its block look like it came from another plugin. The guardrail here is plugin trust (see above), not the tag machinery.

## Performance notes

### `when.missing` scaling

The built-in `when.missing` predicate filters session entries by `customType` via `ctx.findEntries`. Cost is **O(N_session_entries) per unique `customType` per tool_call** — entries are scanned on first read per customType and cached for the rest of the phase (the shared session-entry cache invalidates on writes, see the ADR).

Example: a 5000-entry session with 6 distinct `when.missing` rules costs roughly 600 µs per tool_call on findEntries alone. Typical sessions (< 500 entries) are fine; long-running multi-day sessions may notice the overhead as the JSONL grows.

Future versions will add a session-manager-side index keyed by `customType`, moving the cost from O(N) to O(entries-of-that-type). For now, if you hit the scaling edge, consider:

- Consolidating `when.missing` rules that share a `type`.
- Rotating / truncating the session JSONL between work sessions.

## Further reading

- [`CHANGELOG.md`](./CHANGELOG.md) — per-package changelog (Keep-a-Changelog format). Tracks breaking changes and visibility-only behavior shifts.
- [`examples/`](./examples/) — rule-pack examples (`force-push-strict`, `no-amend`, `draft-prs-only`, `combined-git-discipline`) — copy-paste starting points.
- [`examples/work-item-plugin/`](./examples/work-item-plugin/) — canonical plugin reference.
- [`src/plugins/git/`](./src/plugins/git) — production plugin with trackers and tracker extensions.
- [`unbash-walker`](https://github.com/cad0p/unbash-walker) — the AST walker (own repo since the monorepo split).
- Design decisions behind every field, flag, and semantic covered above are recorded in the repo's ADR log (napkin vault).

## Relationship to related packages

- **[`unbash-walker`](https://github.com/cad0p/unbash-walker)** — the AST + tracker utility this package is built on. Own repo + package since the monorepo split (2026-08-10); consumed here via `github:cad0p/unbash-walker` until the first npm publish.
- **[`samfoy/pi-steering-hooks`](https://github.com/samfoy/pi-steering-hooks)** — inspired schema DNA, override-comment syntax, and the default-rule set. Diverged: AST-backed evaluation instead of raw-string; plugin system; observer + turn-state machinery; TypeScript-only config; walker-threaded trackers.

## License

MIT. See `LICENSE`.
