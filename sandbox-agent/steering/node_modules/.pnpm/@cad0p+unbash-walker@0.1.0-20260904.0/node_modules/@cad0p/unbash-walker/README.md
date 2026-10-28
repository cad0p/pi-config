# @cad0p/unbash-walker

Utility for walking [unbash](https://github.com/webpro-nl/unbash) ASTs — command extraction, wrapper expansion, and an extensible per-command state tracker (cwd, branch, and more).

## Install

```sh
pnpm add @cad0p/unbash-walker unbash
# or
npm install @cad0p/unbash-walker unbash
```

`unbash` is a peer concern: you'll need it to produce the `Script` that `@cad0p/unbash-walker` consumes. `@cad0p/unbash-walker` also re-exports `parse` and the core types for convenience.

## Quick look

```ts
import {
  parse,
  extractAllCommandsFromAST,
  expandWrapperCommands,
  walk,
  cwdTracker,
  getBasename,
  getCommandArgs,
} from "@cad0p/unbash-walker";

const raw = "cd /home/me/repo && sudo sh -c 'git push --force'";
const script = parse(raw);

const refs = extractAllCommandsFromAST(script, raw);
const { commands } = expandWrapperCommands(refs);
const state = walk(script, { cwd: "/tmp" }, { cwd: cwdTracker }, commands);

for (const cmd of commands) {
  const name = getBasename(cmd);
  const args = getCommandArgs(cmd);
  const cwd = state.get(cmd)?.cwd ?? "/tmp";
  console.log(`${cwd} :: ${name} ${args.join(" ")}`);
}
```

## API

| Export | Kind | What it does |
| --- | --- | --- |
| `parse` | re-export from `unbash` | Parse a bash string into a `Script` AST. |
| `extractAllCommandsFromAST(script, source)` | fn | Flatten a `Script` into the list of `CommandRef`s that actually run — walks `AndOr`, `Pipeline`, `Subshell`, `BraceGroup`, control flow, and recurses into `$(...)` / `<(...)` / `` `...` ``. |
| `expandWrapperCommands(commands)` | fn | Given extracted `CommandRef`s, recursively reveal sub-commands of `sh -c`, `bash -c`, `zsh -c`, `sudo`, `env`, `xargs`, `nice`, `nohup`, `strace`, `find -exec`, `fd -x` / `--exec`. Originals are kept alongside expansions so rules can match either level. |
| `WRAPPER_COMMANDS` | const | The wrapper registry `expandWrapperCommands` consults — exposed so callers can extend it. |
| `walk(script, initialState, trackers, refs?)` | fn | Thread a registry of named state trackers through the AST and return a `Map<CommandRef, Snapshot>` where each snapshot carries every tracker's value AT THAT COMMAND. Handles subshell isolation, brace-group propagation, pipeline per-peer isolation, conservative control-flow branch merging, and bare-assignment dispatch (`FOO=bar` routed as basename `""`). Pass `refs` (from your own `extractAllCommandsFromAST` call) to get the Map keyed by your refs; omit for fresh refs. |
| `cwdTracker` | const | Built-in tracker for command cwd. Models `cd ABS`, `cd REL`, `cd ~`, `cd ~/x`, `cd` (no args), `cd -` (no-op), per-command cwd overrides for `git -C DIR`, `make -C DIR`, `env -C DIR`, and env-aware expansion of dynamic targets (`cd "$WS/pkg"` via `envTracker`). See "Known limitations" below. |
| `envTracker` | const | Built-in tracker for shell env. Captures bare assignments (`FOO=bar`), `export NAME=value`, and `unset NAME` from the same chain, seeded from `process.env.{HOME, USER, PWD}` at module load. Subshell-isolated. Assignment RHS tilde expansion matches bash (`VAULT=~/x` expands via HOME; quoted `"~/x"` stays literal; `~user` unsupported like `resolveWord`). Scope limits (readonly / local / declare / typeset / source / function-body) documented in `trackers/env.ts`. |
| `EnvState` | type | `ReadonlyMap<string, string>` — the shape `envTracker` produces per ref. |
| `resolveWord(word, env)` | fn | Statically resolve an unbash `Word` to its string value, expanding `$NAME` / `${NAME}` / `~` via the supplied env map. Returns `undefined` when any part is intractable (command substitution, arithmetic, parameter-expansion with modifiers, unknown var). Shared by `cdTracker`'s modifier and reusable by plugin predicates. |
| `getSubcommandWords(ref, options?)` | fn | Extract the subcommand token run of a multi-command binary (`gh -R x/y pr merge` → `["pr"]`; depth=2 → `["pr","merge"]`). Linear argv-structured scan over `ref.node.suffix` — skips flag tokens and caller-declared value-consuming flags by position, so a flag value is never mistaken for the subcommand. Quote-aware (`.value`). Returns up to `depth` positional words, or `null` when no positional remains. See "Subcommand extraction" below. |
| `bundleContains(word, letter)` | fn | Does one short-option-shaped word contain `letter` in its bundle? `-uf` / f → true; `-f=x` / f → true (body cut at first `=`); `--force` → false. Over-match on glued values documented — see "Subcommand extraction" below. |
| `DEFAULT_POSITION_POLICIES` | const | Per-binary default `positionPolicy` table (basename-keyed) consulted by `getSubcommandWords`; caller override wins. Survey-backed; see policy table below. |
| `PositionPolicy` / `SubcommandOptions` | types | Policy enum (`globals-anywhere \| globals-before-only \| globals-after-only`) and the option bag (`positionPolicy?`, `depth?`, `valueConsumingFlags?`) for `getSubcommandWords`. |
| `SubcommandRun` / `locateSubcommandRun(words, opts)` / `getSubcommandRun(ref, opts?)` | type, fn | Boundary metadata for the same run: `{indices, words, start}` (`start === indices[0]`). Bare-words core requires `positionPolicy`; the ref twin does the basename table lookup. See "Boundary metadata" below. Defined in `src/subcommand.ts`, not re-exported from the package root. |
| `Tracker<T>` / `Modifier<T, TAll>` / `isStaticallyResolvable(word)` | types, fn | Author your own tracker dimensions — register modifiers keyed by command basename with `scope: "sequential" \| "per-command"`. Modifier.apply receives `(args, current, allState)` — `allState` is a read-only snapshot of every registered tracker's pre-ref state, enabling cross-tracker reads (e.g. `cwdTracker`'s `cd` modifier reads `allState.env`). Narrow the `TAll` type parameter to declare what you need. Return `undefined` from `apply` to signal "can't resolve statically"; the walker substitutes the tracker's `unknown` sentinel. |
| `getCommandName` / `getCommandArgs` / `getBasename` / `isBareAssignment` | fn | Read the parts of a `CommandRef`. `getBasename` strips any leading path (`/usr/bin/git` → `git`). |
| `formatCommand(cmd, options?)` | fn | Re-serialize a `CommandRef` as a single-line display string with length-aware shrinking and path-aware elision. |
| `CommandRef` | type | `{ node: Command; source: string; group: number; joiner?: "\|" \| "&&" \| "\|\|" \| ";" }` |

## Subcommand extraction

Guardrails need to know *which subcommand* an invocation targets without re-deriving leading-flag grammar per rule (the "flag grammar tax": regex-based skip patterns die on bundled shorts, and flag values get mistaken for the subcommand — the exact bug class behind `git -c KEY=VAL push` misreads and `gh --hostname h pr merge` routing nowhere). `getSubcommandWords` answers structurally over the AST's word list:

```ts
import { getSubcommandWords } from "@cad0p/unbash-walker";

// gh -R x/y pr merge  →  ["pr"]        (depth=1, default)
//                     →  ["pr","merge"] (depth=2)
const words = getSubcommandWords(ref, {
  depth: 2,
  valueConsumingFlags: ["-R"], // caller declares -R consumes its next token
});
```

### Position policy — a per-binary property

Position semantics differ across CLI families (cobra accepts globals anywhere; gitcli(7) fatals on after-subcommand globals; mitchellh/cli errors on pre-sub flags). They ship as overridable in-package defaults because they're tiny, stable, and survey-backed — unlike flag inventories, which are open-ended and version-volatile:

| policy | binaries (defaults) |
| --- | --- |
| `globals-anywhere` | gh, kubectl, docker, aws, gcloud, az, npm, pnpm, yarn, cargo, uv, pip |
| `globals-before-only` | git |
| `globals-after-only` | terraform, go |

Unknown binaries fall back to `globals-anywhere`. Only `globals-after-only` binaries reject leading-global-flag shapes (`go -v build` → `null`; such invocations are invalid by definition). For `globals-before-only` binaries, post-subcommand flags are simply subcommand-owned args — `git push -C x` still extracts `["push"]`.

### `valueConsumingFlags` — caller-owned flag arity

The walker owns the consumption *algorithm* but NOT the facts: there is deliberately **no in-package flag-arity inventory**. Which flags consume the following token (`git -C DIR`, `-c KEY=VAL`) is binary-specific, version-volatile knowledge that lives with whoever has grounding — usually you, at the call site. Exact-token match only (`--flag=value` attached forms are consumed automatically as single tokens).

This contract is garbage-in/garbage-out, pinned honestly by tests: declare `-R` consuming and `gh -R pr merge` extracts `["merge"]` (the value never leaks); leave it undeclared and the same shape extracts `["pr"]`. Same for `gh --hostname h pr merge` — undeclared, `"h"` comes out as the "subcommand". If your declaration set is wrong, extraction follows it faithfully.

### Boundary metadata (`SubcommandRun`)

Consumers needing positional information — e.g. reasoning about args after the subcommand without identity-matching returned words against the suffix array (fragile under duplicate-valued tokens: `git -C push push` with `-C` declared would value-match the skipped index 1, not the subcommand at 2) — use the boundary-metadata twins `locateSubcommandRun(words, opts)` (bare-words core; `positionPolicy` is required because bare words carry no binary identity, so there is no table to consult — a missing or invalid policy throws a `TypeError`) and `getSubcommandRun(ref, opts?)` (thin wrapper doing the basename table lookup, mirroring `getSubcommandWords`). Both project the same shared scan loop and return `{indices, words, start}` (`start === indices[0]`, agreeing with `locateSubcommandStart`); `words` holds the shared `Word` refs and `indices` is a fresh array per call. The run is generally non-contiguous when consuming-flag values interleave (`aws s3 --profile x ls` with `--profile` declared → indices `[0,3]`), so reconstruct it via the indices map, never via a contiguous slice. There is deliberately no `end`/tail helper: the `[first, last+1)` hull includes the skipped gap, and a depth-truncated run would promote consumed values and deferred words to args-after — a tail is valid only if the run is contiguous (`indices[i] === indices[0] + i`) AND unsaturated (the scan stopped for end-of-words, not for depth). Like the other surfaces, `null` conflates all-flags / trailing consuming flag / after-only-invalid shapes and steering consumers treat all `null` as unknown/block, never allow.

### Honest limits (documented, pinned by tests)

- **Null conflates two failure modes**: zero positionals (all-flag invocation like bare `git -C`) and after-only invalid shape (`go -v build`) both return `null` — for fail-closed consumers they mean the same thing: no extraction possible.
- **`$VAR` values are not expanded** — the scan is structural only; `mytool $VAR sub` extracts `["$VAR"]` literally.
- **Negative-number-looking tokens** (`-1`) classify as flag-shaped and are skipped.
- **`--` is skipped but post-`--` positional semantics are not modeled** — future refinement.
- **No alias identity**: `-R` vs `--repo` equivalence is caller policy; no alias knowledge ships in-package.
- **No multi-word matching beyond `depth` positional tokens.**

`bundleContains(word, letter)` expands short-flag bundles lexically and is honest about the limit: `-uf` (a bundle) and `-fx` (flag + glued value) are shape-identical without per-flag arity knowledge, so glued values over-match — `-fx` reports BOTH `f` and `x` as contained letters. Bodies cut at the first `=` (`-f=x` scans only `f`; anything post-`=` is a value). Long options (`--force`) never match.

The built-in `cwdTracker`'s git modifier uses the same primitive internally (`locateSubcommandStart`), so the subcommand boundary has exactly one implementation.

## What this is not

- **Not a parser.** `unbash` handles parsing; this package operates on its output.
- **Not a pi extension, hook, or rule engine.** It's general-purpose AST infrastructure. Guardrail and permission packages (pi-guard, samfoy/pi-steering-hooks, [cad0p/pi-steering](https://github.com/cad0p/pi-steering)) build their logic on top of it.
- **Not a shell.** It doesn't execute commands or model every bash semantic. It models enough structure to power guardrails and auditing tools. `pushd`/`popd`, `eval`, `source`, and `git --git-dir=/path` are out of scope today; see `src/trackers/cwd.ts` for the current coverage list.

## `cwdTracker` — known limitations

Static analysis; some bash constructs are deliberately under- or over-approximated so callers can make safe policy decisions:

- **Dynamic `cd` targets** (`cd $VAR`, `cd "$WS/pkg"`, `cd $(pwd)`) — the walker reads `allState.env` (seeded by `envTracker` + `process.env.{HOME, USER, PWD}` fallback) to expand `$VAR` / `${VAR}` / `~`. When every part resolves, the target is computed and propagates as a static target. When any part is intractable — unknown var, command substitution, arithmetic, parameter-expansion with modifiers — the `cd` modifier returns `undefined` and the walker emits the tracker's `"unknown"` sentinel for subsequent commands. The `cd` itself is still recorded at the pre-cd cwd; engine consumers apply `when.cwd`'s `onUnknown: "allow" | "block"` policy to decide how to treat the sentinel (default `"block"`, fail-closed).
- **`source script.sh` / `. script.sh`, function bodies, `readonly` / `local` / `declare`** — env mutations that happen inside opaque subsystems (sourced files, function calls, attribute-bearing assignments) are not modelled. `envTracker` scope is bare assignment + `export` + `unset` only; the rest is documented in `trackers/env.ts` and scheduled for a future `pi-steering-env` plugin or walker extension.
- **`if` / `case` branches** — exactly one branch runs at runtime; we propagate a cwd forward only if *all* branches agree. Otherwise we fall back to the pre-branch cwd. Commands inside each branch still see that branch's own cwd.
- **`while` / `for` / `select`** — the body may iterate zero times; we never propagate body cwd forward. Commands inside the body are walked (and recorded) from the loop's starting cwd.
- **Background `&`** — treated like `;` (cd effects propagate). In real bash, `cd /x &` runs in a backgrounded subshell and cmd would see the initial cwd. This is a deliberate over-match: a guardrail sees the more conservative cwd and fires `when.cwd` checks.
- **`cd -`** — treated as a no-op (we don't track OLDPWD).
- **Not modelled at all:** function bodies (walked only when defined, not when invoked). The following out-of-scope constructs are pinned by tests so any future change is deliberate:
  - **`pushd` / `popd`** — not treated as cd. `pushd /A && y` leaves `y` at the pre-pushd cwd. Guardrails that want to catch these should write explicit rules against the commands.
  - **`git --git-dir=/path`, `git --work-tree=/path`** — narrower than `-C`; not modelled today. Follow-up.
  - **`eval "..."`** — the string argument is not re-parsed. Only `eval` itself is extracted; commands inside the string are invisible. Match the eval string directly (`^eval\b.*git\s+push`) or block eval outright.
  - **`source script.sh` / `. script.sh`** — external files are never read. `source` is extracted as a normal command; any cd effects the sourced script would perform at runtime are opaque to the walker.
  - **Heredoc bodies** — heredoc content is treated as data (redirect payload on the owning command), so `cd` written inside a heredoc body is never extracted or walked. This is correct behavior, not over-match: heredoc bodies in real bash are stdin, not commands.
  - **Wrapper-expansion interaction for `env -C DIR cmd`** — the outer `env` ref is recorded at DIR, but the surfaced inner `cmd` ref has no entry in the walk result (consumers fall back to the session cwd). Lifting this requires wrapper expansion to consult the cwd tracker when computing inner refs — tracked as a follow-up.

## Acknowledgments

Built on top of [`unbash`](https://github.com/webpro-nl/unbash) by [Lars Kappert](https://github.com/webpro) (also maintainer of [knip](https://github.com/webpro-nl/knip)). `@cad0p/unbash-walker` is strictly a consumer — `unbash` handles every piece of parsing.

The command-extraction and wrapper-expansion logic was originally authored by [Jason Diamond](https://github.com/jdiamond) as part of [pi-guard](https://github.com/jdiamond/pi-guard). This package is a refactor-and-extraction of that work with the addition of a `walk` tracker API, a built-in `cwdTracker`, and a `getBasename` helper. Both the original files and the additions are MIT-licensed. File headers carry dual credit.

## Status

PoC phase. Since the 2026-08-10 monorepo split this is a standalone repo/package (`private: true`, `0.0.0-poc.0`, publish deferred). The first publish waits on two things:

1. The end-to-end PoC (the `pi-steering` steering engine consuming this package) demonstrates the value.
2. The extraction proposal on [jdiamond/pi-guard](https://github.com/jdiamond/pi-guard) has been resolved — either `unbash-walker` is adopted upstream, or we publish it under the `cad0p` scope ourselves (publish runbook: [cad0p/pi-steering PUBLISHING.md](https://github.com/cad0p/pi-steering/blob/main/PUBLISHING.md)).

## License

MIT. See file headers for dual-credit.
