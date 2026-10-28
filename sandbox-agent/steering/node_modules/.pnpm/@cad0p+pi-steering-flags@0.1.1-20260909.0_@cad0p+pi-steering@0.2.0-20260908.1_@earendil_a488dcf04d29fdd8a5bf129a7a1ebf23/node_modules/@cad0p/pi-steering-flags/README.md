# pi-steering-flags

Declarative flag-presence and flag-allowlist predicates for [pi-steering](https://github.com/cad0p/pi-steering) rules.

First official external plugin for the pi-steering ecosystem. Establishes the precedent pattern for every community plugin that follows.

## Install

```bash
pnpm add pi-steering-flags
```

`pi-steering-flags` declares `@cad0p/pi-steering` as a `peerDependency`; install both together.

## Usage

```ts
// .pi/steering/index.ts
import { defineConfig } from "@cad0p/pi-steering";
import flagsPlugin from "pi-steering-flags";

export default defineConfig({
  plugins: [
    flagsPlugin,
    // Argv facts for the gated basenames (core #117: registry-only
    // arity — absent descriptors block loud). `cr` is explicit-strict
    // empty; `aws --profile` takes a value (separate `--profile dev`
    // must consume).
    {
      name: "gate-facts",
      cliDescriptors: {
        aws: {
          flags: { profile: { aliases: ["--profile"], takesValue: true } },
        },
        cr: {},
      },
    },
  ],
  rules: [
    // Block `aws` invocations without --profile or AWS_PROFILE env.
    {
      name: "aws-requires-profile",
      tool: "bash",
      command: "aws",
      unless: /^aws\s+(sts\s+get-caller-identity|configure)\b/,
      when: {
        requiresFlag: { flag: "--profile", env: "AWS_PROFILE" },
      },
      reason: "Always specify --profile (or AWS_PROFILE=) — never rely on the default profile.",
    },
    // Default-deny flag gating for `cr`.
    {
      name: "cr-allowlisted-flags-only",
      tool: "bash",
      command: "cr",
      when: {
        not: { infoOnly: true },
        allowlistedFlagsOnly: {
          allow: ["--all", "--description", "--reviewers"],
        },
      },
      reason:
        "Only --all, --description, --reviewers are allowed with `cr`. " +
        "Everything else should be inferred from the commit message.",
    },
  ],
});
```

## Predicates

### `when.requiresFlag`

Rule fires (command is BLOCKED) when none of the listed flag / env equivalents appear in the evaluated command.

**Shorthand**: `requiresFlag: "--profile"` is equivalent to `requiresFlag: { flag: "--profile" }`.

**Object form**:

```ts
requiresFlag: {
  flag?: string;              // one required flag
  flags?: readonly string[];  // any one of several (OR)
  env?: string;               // env-var alternative (VAR=value shell prefix)
  envs?: readonly string[];   // any one of several envs (OR)
}
```

At least one of `flag` / `flags` / `env` / `envs` must be specified. A malformed arg (empty object) does not fire — fail-open for the rule author's benefit (better than silent always-block).

**Examples**:

```ts
when: { requiresFlag: "--profile" }

when: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } }

when: { requiresFlag: { flags: ["-n", "--namespace"] } }

when: {
  requiresFlag: {
    flag: "--region",
    envs: ["AWS_REGION", "AWS_DEFAULT_REGION"],
  },
}
```

### `when.requiresFlagValue`

Rule fires (command is BLOCKED) when the LAST-wins value of any of the listed flag aliases is absent, valueless, or does not satisfy `matches`. Last-wins matches how gh / cobra / pflag parse repeated flags — `gh pr merge -t "see #13" --subject "closes #12"` merges with the subject "closes #12", so that's the value a guardrail must evaluate.

```ts
requiresFlagValue: {
  flags: readonly string[];  // aliases of ONE logical flag (OR'd)
  matches: RegExp;           // pattern the effective value must satisfy
}
```

Spread-only (no bare shorthand: it needs both fields), like `allowlistedFlagsOnly`.

**Absence is fail-closed**: a flag that isn't there at all counts as unmet — a rule requiring a matching value must block when it can't verify one. A trailing valueless flag (`gh pr merge -t foo --subject`) also fires, with no fallback to the overridden `-t foo`. Malformed args (missing / empty / non-string `flags`, non-RegExp `matches`) are the exception: they fail open, same precedent as `requiresFlag`'s empty-object behavior.

**Worked example** — `gh pr merge` must reference the issue it closes in its subject — a closing keyword or any bare `#N` reference (help invocations still pass via the info-only carve-out):

```ts
// Enclosing config must declare gh's argv facts:
// `cliDescriptors: { gh: { flags: { subject: { aliases: ["--subject", "-t"], takesValue: true } } } }`
// (value-taking flags need table rows for the separated `--subject x` form).
{
  name: "pr-merge-needs-closing-keyword",
  tool: "bash",
  command: "gh",
  when: {
    subcommand: ["pr", "merge"],
    not: { infoOnly: { extraFlags: ["-h"] } },
    requiresFlagValue: {
      flags: ["--subject", "-t"],
      matches: /\b(closes?|fixe?s?|resolves?)\s+#\d+\b|(^|\s)#\d+/i,
    },
  },
  reason:
    "gh pr merge should reference the issue it closes — pass --subject (or -t) with a closing keyword.",
}
```

One parsing asymmetry to know: an attached-empty flag (`--subject=`) yields the real value `""` (which won't match, so the rule fires), while a separated-empty one (`--subject ""`) reads as valueless (`null`) and fires too.

Like the underlying helper, the separated form takes the next token blindly as the value: `--subject --force` reads the value as `"--force"` (which won't match, so the rule fires). Callers who need stricter parsing should post-check inside a `when.condition`.

### `when.allowlistedFlagsOnly`

Rule fires when any `-`-prefixed token is present that isn't in the allowlist.

```ts
allowlistedFlagsOnly: {
  allow: readonly string[];
  allowPrefixes?: readonly string[];
}
```

- Flags in `allow` that start with `--` automatically match their `--flag=value` attached-value form.
- Short flags (`-n`, `-h`) don't get auto-prefix — use `allowPrefixes` if you need to allow an attached-value short form (e.g. `-ofoo` via `allowPrefixes: ["-o"]`).
- Positional args (tokens not starting with `-`) are ignored.

**Example**:

```ts
when: {
  allowlistedFlagsOnly: {
    allow: ["--all", "--description", "--reviewers"],
    // Implicitly matches: --description=... and --reviewers=...
  },
}
```

### `when.infoOnly`

Rule fires when the command IS an info-only invocation — `--help` / `--version` by default. Token-level and quote-aware: a help token inside a quoted VALUE (`gh pr merge --subject "see --help"`) does NOT count, so guardrails still apply to real operations that merely mention help text. This is the replacement for the removed `INFO_ONLY` regex, which matched on the normalized string and wrongly exempted such commands.

**Shorthand**: `infoOnly: true` checks the default set. `infoOnly: false` never fires.

**Object form** (additive-only):

```ts
infoOnly: {
  extraFlags?: readonly string[];  // additional flags, checked in ADDITION to the default set
}
```

Nothing can remove the safe core. `-h` and `-v` are deliberately NOT in the default set — they are real operations in adversarial commands (`docker run -v /data:/data`, `curl -v`, `kubectl -v 8`, `psql -h host`). A plugin author who wants `-h` for their own CLI adds it via `extraFlags` and owns that security tradeoff.

**Carve-out idiom**: the `when` clause is an AND — a naive `when: { infoOnly: true }` would BLOCK on help (it requires the command to BE info-only). To ALLOW info-only invocations while everything else still evaluates, negate with `not:`:

```ts
when: { not: { infoOnly: true } }

when: { not: { infoOnly: { extraFlags: ["-h"] } } }
```

## Helpers (escape-hatch)

When the built-in predicates aren't enough, reach for the bound `ctx.command` facade inside `when.condition` (core #101/#110, entry-only; requires core >=0.2.0-20260908.1 — the P3 bare-helper root exports are deleted, `FlagLookupOptions` included):

```ts
import type { CLIFlag } from "@cad0p/pi-steering";

const description: CLIFlag = { aliases: ["--description"], takesValue: true };

when: {
  condition: async (ctx) => {
    if (ctx.input.tool !== "bash") return false;
    const path = ctx.command.getFlagValue(description);
    if (path === null) return false;
    const result = await ctx.exec("test", ["-f", path], { cwd: ctx.cwd });
    return result.exitCode !== 0;
  },
}
```

Entries always come from the owning plugin's table — never hand-build literals in rules (a typo'd `"--delet"` string is a silent fail-open skip; a typo'd `flags.delet` property is a compile error). The generic one-off above is the exception: entries are constructed inline because the flag is local to the rule. Value-taking flags need table rows for the separated `--flag value` form (`cliDescriptors: { mycli: { flags: { description: { aliases: ["--description"], takesValue: true } } } }`); without the row only the attached `--flag=value` form resolves.

- `ctx.command.hasFlag(entry | entry[])` — presence: bare token, attached `--flag=value`, declared consuming-flag values skipped by position, short bundles (table-derived glue).
- `ctx.command.getFlagValue(entry | entry[])` — LAST-flag-wins value lookup (right-to-left, so `gh pr merge -t "see #13" --subject "closes #12"` yields `"closes #12"`). Fail-closed on a trailing valueless flag (`-t foo --subject` → `null`, no fallback).
- `ctx.command.getAllFlagValues(entry | entry[])` — every occurrence in argv order.
- `ctx.command.hasEnvAssignment(name)` — literal env-var name match on the shell prefix.
- `ctx.command.isInfoOnly(extraFlags?)` — token-level, quote-aware (`--help` inside a quoted value does NOT match; `--help=x` DOES).
- `INFO_FLAGS` — still exported from the core root (data constant: `["--help", "--version"]`).

All facade reads are quote-aware (`.value` before `.text`). Out-of-handler / test use goes through the root-exported `commandFromInput` factory.

## Design

### Why a plugin, not engine core?

Flag-presence and allowlist checks are opinionated policy:
- Which flags count as equivalent (short + long + env)?
- How aggressive should default-deny be?
- What counts as a "flag" (every `-`-prefixed token, or just `--long`)?

Reasonable plugins can disagree. Keeping this logic in a plugin lets it iterate on its own release cadence without committing the engine to decisions about every CLI's conventions.

The `hasFlag` / `getFlagValue` / `hasEnvAssignment` (+ `isInfoOnly` / `INFO_FLAGS`) primitives used to live here; they were promoted into pi-steering core (P3) and then superseded by the bound `ctx.command` facade (entry-only, table-bound; requires core >=0.2.0-20260908.1). This package keeps only the policy predicates above.

### Why `Rule.when`, not `Rule.unless`?

Both are valid slots. `Rule.when` is the canonical home for plugin-registered predicates (it's the named-lookup slot); `Rule.unless` is a regex / function slot. Predicates should live where the engine expects them.

Use `Rule.unless` for simple pattern carve-outs that shouldn't trigger predicate evaluation in the first place. For info-only carve-outs, use the `not: { infoOnly: true }` idiom instead (see `when.infoOnly`) — token-level detection beats a regex over the normalized string, which wrongly matches help text inside quoted values.

### Why two predicates instead of one?

`requiresFlag` (must-have) and `allowlistedFlagsOnly` (must-not-have-outside-list) encode opposite intents. One predicate with both modes would be denser but harder to read at the call site — the rule's intent is clearer when the predicate name matches it.

## Ecosystem discovery

Tagged with:

- `"pi-package"` — surfaces alongside every pi extension.
- `"pi-steering-package"` — surfaces specifically in pi-steering plugin listings (once a discovery page exists).

Use the same keywords in your own plugin's `package.json` for discoverability.

## License

MIT
