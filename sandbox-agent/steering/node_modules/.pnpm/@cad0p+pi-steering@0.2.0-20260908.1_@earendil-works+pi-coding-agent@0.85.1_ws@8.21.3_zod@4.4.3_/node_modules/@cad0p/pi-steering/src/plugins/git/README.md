# pi-steering/plugins/git

Git plugin for [pi-steering](../../../README.md) — branch
awareness, upstream checks, and git-specific cwd tracking on top of
the core steering engine.

> **Opt-in.** This plugin is NOT registered automatically — nothing is
> since issue #72 (there are no engine-injected default rules or
> plugins). Declare it via `plugins: [gitPlugin]` (import from
> `@cad0p/pi-steering/plugins/git`) to get the predicates, rules,
> tracker, and cwd extensions — see [Usage](#usage) below.

## What it ships

| Surface | Names | Purpose |
|---|---|---|
| Predicates | `branch`, `upstream`, `commitsAhead`, `hasStagedChanges`, `isClean`, `remote` | New `when.<key>` slots for rules |
| Rules | `no-main-commit`, `no-main-commit-github`, `no-force-push`, `no-hard-reset` | Block direct commits to protected branches (`-github` variant emits PR-flow guidance); block force pushes (sealed, #65) and hard resets |
| Trackers | `branch` | Walker-threaded branch state (`git checkout X` advances) |
| Tracker extensions | `cwd.git` | `--git-dir=` / `--work-tree=` flag parsing on top of the built-in cwd tracker |

## Usage

```ts
// .pi/steering.ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  // The plugin is opt-in: declaring it registers it at runtime AND
  // feeds its rule / predicate names into defineConfig's type unions
  // (typo-checking on disabledRules / disabledPlugins).
  plugins: [gitPlugin],
  rules: [
    // Custom rule layered on top of the plugin's predicates:
    {
      name: "no-push-when-dirty",
      tool: "bash",
      command: "git",
      when: { subcommand: "push", isClean: false },
      reason: "Stash or commit your working changes before pushing.",
    },
  ],
});
```

Explicit import still works (e.g. in tests constructing configs
directly):

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  rules: [...],
});
```

### Disabling

Disabling snippets declare `plugins: [gitPlugin]` first — that's what
feeds the rule / plugin names into `defineConfig`'s generics for
typo-checking. (There is no default registration to lean on, so
disabling an undeclared plugin is a compile error.)

Keep the predicates + tracker, drop the shipped rule:

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  disabledRules: ["no-main-commit"],
});
```

Drop the whole git plugin (no `branch` / `upstream` / ... predicates,
no tracker, no cwd extensions, no rule):

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  disabledPlugins: ["git"],
});
```

Don't want this plugin at all? Don't declare it — there is no
engine-level kill switch (and no `rm` / `async` rails either unless
you declare those plugins).

## Predicate reference

### `branch`

Match the current git branch.

```ts
when: { branch: /^main$/ }
when: { branch: "^feat-" }                             // string = regex source
when: { branch: { pattern: /^main$/, onUnknown: "allow" } }
```

Resolution is a three-way discrimination on what the branch tracker
knows about the current `tool_call` chain:

1. **value** — the tracker observed an in-chain `git checkout <X>` /
   `git switch <X>` with a statically-resolvable target. Match the
   pattern against `X`. This is what makes
   `git checkout main && git commit` evaluate against `main`, not
   the pre-chain branch.
2. **unknown** — the tracker observed a checkout but couldn't
   resolve the target (e.g. `git checkout $VAR`). Apply `onUnknown`
   policy WITHOUT shelling out: `git branch --show-current` here
   would return the PRE-checkout branch and silently defeat the
   walker — exactly the case the tracker exists to catch.
3. **missing** — no branch-changing command fired in the current
   chain. Shell out via `git branch --show-current` in `ctx.cwd`;
   the shell's current state is the answer the predicate wants.

`onUnknown` defaults to `"block"` (fail-closed) — if the branch
can't be determined (dynamic checkout, exec failure, detached HEAD
in the missing case), the predicate reports "match" so the rule
still fires.

### `upstream`

Match the current branch's configured upstream (`git rev-parse
--abbrev-ref @{upstream}`). Same shape as `branch`, no tracker today.

```ts
when: { upstream: /^origin\/main$/ }
when: { upstream: { pattern: "^origin/", onUnknown: "allow" } }
```

### `commitsAhead`

Match the count of commits ahead of a revision (default
`@{upstream}`).

```ts
when: { commitsAhead: { eq: 1 } }                       // exactly one
when: { commitsAhead: { gt: 0 } }                       // at least one
when: { commitsAhead: { gt: 0, lt: 5 } }                // 1..4
when: { commitsAhead: { wrt: "origin/main", eq: 1 } }
```

At least one of `eq` / `gt` / `lt` must be specified. Returns
`false` (rule skips) on exec failure or non-numeric output — pair
with `upstream` for fail-closed behavior.

### `hasStagedChanges` / `isClean`

Boolean predicates.

```ts
when: { hasStagedChanges: true }   // staged changes exist
when: { hasStagedChanges: false }  // no staged changes
when: { isClean: true }            // working tree clean
when: { isClean: false }           // working tree dirty
```

Returns `false` on exec failure. Layer with `upstream` if you need
fail-closed behavior.

### `remote`

Match the `origin` remote URL. Same shape as `branch`.

```ts
when: { remote: /github\.com:org\// }
when: { remote: { pattern: /production/, onUnknown: "block" } }
```

## Shipped rules

### `no-main-commit`

Blocks direct commits to protected branches (`main`, `master`,
`mainline`, `trunk`).

```ts
{
  name: "no-main-commit",
  tool: "bash",
  command: "git",
  when: { subcommand: "commit", branch: PROTECTED_BRANCH_PATTERN },
  reason: "Don't commit directly to a protected branch...",
  noOverride: true,
}
```

Strict and non-overridable since issue #79: inline
`# steering-override:` comments are ignored. Escape valves live at
the config layer — `disabledRules`, a same-name project-layer
redeclaration, or a cwd-scoped exemption (see the
[Cwd-based exemption](#cwd-based-exemption-advanced) section).
Still catches `git -C /path commit`, `sh -c 'git
commit'`, and — thanks to the branch tracker — `git checkout main
&& git commit`.

The routing is `command: "git"` + `subcommand: "commit"` on both
rules (the old shared `GIT_COMMIT_PATTERN` regex was deleted with
bash `pattern:` in issue #117 — routing is exact basename equality
now, so the two rules can't drift apart by construction).

The protected-branch list is likewise shared via the exported
`PROTECTED_BRANCH_PATTERN` constant (also re-exported from
`pi-steering/plugins/git`). Because it's a `RegExp` (object)
constant rather than a string source, the pinning test uses
shared-reference identity (`when.branch === PROTECTED_BRANCH_PATTERN`),
which also catches future re-inlining of the same bytes — a stricter
guarantee than the byte-equality pin on `pattern`. Adding a
vendor-specific default-branch alias is a one-line edit at the
constant; both rules pick it up.

### `no-main-commit-github`

Specialization of `no-main-commit` for github.com clones. Same
routing + protected-branch list, plus a `remote: /github\.com[/:]/`
clause; the reason text emits PR-flow guidance (`gh pr merge`)
instead of the generic feature-branch reminder, plus a safety
reminder against unsolicited PR merges or ready-for-review flips.

```ts
{
  name: "no-main-commit-github",
  tool: "bash",
  command: "git",
  when: {
    subcommand: "commit",
    branch: PROTECTED_BRANCH_PATTERN, // shared with no-main-commit
    remote: /github\.com[/:]/,
  },
  reason: (ctx) => /* multi-paragraph PR-flow + safety guidance */,
  noOverride: true,
}
```

**First-match-wins ordering is load-bearing.**
`no-main-commit-github` is registered BEFORE `no-main-commit` in
the plugin's rule array. On a github clone + on main, both rules'
`when:` clauses match — first-match-wins routes the
github-flavored guidance to github users. On non-github contexts
(Brazil packages, vault paths, /tmp scratch repos with non-github
remotes) the github rule's `remote:` predicate doesn't match → the
engine falls through to the generic `no-main-commit`. A unit test
pins this position so reordering for stylistic reasons trips the
suite.

Under walker-unknown cwd (`cd "$VAR" && git commit`), the rule
still fires fail-closed — but the reason text switches to the
standard `walkerUnknownCwdReason` message instead of claiming
github-specific context the engine couldn't verify.

## Customization

Three escape valves of increasing scope, ordered most → least
common. None of these are exemption-by-cwd patterns — see the
[Cwd-based exemption](#cwd-based-exemption-advanced) advanced
section below for that case (it has subtle
walker-unknown-cwd interactions you need to handle explicitly).

```ts
// 1. Swap the github rule's PR-flow guidance for the generic
//    feature-branch reminder (keep blocking direct commits to
//    main, just drop the github-specific message). The generic
//    `no-main-commit` is still active and fires on a github clone
//    + main; disabling the github specialization makes the engine
//    emit the generic message instead.
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  disabledRules: ["no-main-commit-github"],
});
```

```ts
// 2. Disable + replace with a freshly-named user rule whose
//    `reason` text points your agents at an internal skill /
//    runbook. Spread the original to inherit `command`, `when:`,
//    `tool`, and `noOverride` — only override the field
//    you actually want to change. No `when:` changes → no
//    walker-unknown-cwd interactions to reason about.
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin, { noMainCommitGithub } from "@cad0p/pi-steering/plugins/git";
import type { Rule } from "@cad0p/pi-steering";

const myNoMainCommitGithub = {
  ...noMainCommitGithub,
  // FRESH name — see warning below; reusing the original name has
  // two failure modes, both bad.
  name: "myorg-no-main-commit-github",
  reason:
    "You're on a github clone's protected branch. " +
    "Open a PR for review (`gh pr create`); land via `gh pr merge` " +
    "after approval. See skill `git-discipline@myorg` for our team's " +
    "PR conventions.\n\n" +
    "Safety: NEVER merge a PR or mark it ready-for-review unless " +
    "the user explicitly asks. Wait for explicit user instruction.",
} as const satisfies Rule;

export default defineConfig({
  plugins: [gitPlugin],                     // typo-checks the disable below
  disabledRules: ["no-main-commit-github"], // drop the default
  rules: [myNoMainCommitGithub],            // replacement on
});
```

```ts
// 3. Disable the entire git plugin (drops all gitPlugin
//    predicates / rules / trackers / extensions):
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  disabledPlugins: ["git"],
});
```

### ⚠️ Always use a fresh name when extending or replacing a plugin rule

pi-steering composes user rules and plugin rules as
`[...userRules, ...pluginRules]` with **no name dedup at the
user/plugin layer.** Reusing the plugin rule's name in your config
has two failure modes, **both bad**, depending on whether you also
use `disabledRules`:

1. **Same name + NO `disabledRules`** → BOTH rules are kept. The
   plugin rule fires alongside your customized version, so paths
   you intended to exempt still get the original message. The
   customization silently fails to apply.

2. **Same name + `disabledRules: ["original-name"]`** → the
   `disabledRules` filter applies to ALL rules with that name
   across both the user-config and plugin-rule sources. NEITHER
   rule fires. Silent fail-OPEN — the worst outcome for a safety
   rule, since the agent now has no guardrail at all.

Use a fresh name (e.g., `myorg-no-main-commit-github`). Pair it
with `disabledRules: ["no-main-commit-github"]` so the original is
dropped and your fresh-named replacement survives the disable
filter.

### CLI descriptors — keep the plugin declared for git argv knowledge

Bare `subcommand: "push"` matches `git -C /x push` because this plugin declares the `git`
basename's argv facts (`-C` / `-c` consume the next token; globals
come before the subcommand) via its `cliDescriptors` slot
(`./descriptors.ts`, re-exported as `GIT_CLI_DESCRIPTOR`). Arity is
registry-only since #107 (no leaf-inline channel), and absent
descriptors are loud: without this plugin, any `git` rule blocks with
`MissingDescriptorError`. Core seeds nothing — every binary's
descriptor is plugin-owned.

Preferred opt-out: to author git rules without the shipped rails,
import the plugin and drop rails via `disabledRules` — descriptors,
trackers, and predicates stay wired:

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  disabledRules: ["no-main-commit", "no-force-push"],
  rules: [
    // Your git rules here: bare `subcommand: "push"` still resolves
    // `git -C /x push` via the plugin's declared descriptor.
  ],
});
```

Rolling your own `{ git: … }` descriptor is supported but
discouraged (drift risk if the plugin's facts evolve — and a
basename overlap with this plugin's entry warns via
`descriptor-collision`). Omitting the plugin entirely is a silent
strict default: bare `subcommand: "push"` on `git -C /x …` misses
(fail-open skip, no WARN), because there are no `git` facts to
resolve.

### Cwd-based exemption (advanced)

A common request: "don't block commits to main inside my vault
directory" (vault flows like napkin-distill commit to a `main`
branch by design). Cwd-based exemptions need care because:

**The generic `no-main-commit` still fires on vault paths.**
Disabling only the github specialization isn't enough — the
generic rule's `when:` is just `{ branch: ... }` (no `remote:`
gate), so it fires on any github clone or any other repo whose
branch is one of the protected names. To actually exempt a path
you need to disable BOTH shipped rules and register a
user-authored rule.

Worked example:

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin, { noMainCommit } from "@cad0p/pi-steering/plugins/git";
import type { Pattern, Rule } from "@cad0p/pi-steering";

const VAULT_DIRS: Pattern[] = [
  /\/Goldmine\//,
  /\/\.cache\/napkin-distill\//,
];

const noMainCommitExceptVault = {
  ...noMainCommit,
  name: "myorg-no-main-commit-except-vault",
  when: {
    ...noMainCommit.when,
    // Bare `not: { cwd: VAULT_DIRS }` is fail-CLOSED under
    // walker-unknown cwd via the not-block's default block-level
    // `onUnknown: "block"` modifier (see Walker-unknown cwd
    // below). The inner `cwd:` predicate produces an `"unknown"`
    // verdict, the not-block projects it to `false`, the outer
    // rule fires — a `cd "$VAR" && git commit` is blocked rather
    // than slipping past.
    not: { cwd: VAULT_DIRS },
  },
} as const satisfies Rule;

export default defineConfig({
  plugins: [gitPlugin],                     // typo-checks the disables below
  // BOTH shipped rules disabled; otherwise the generic
  // `no-main-commit` fires on vault paths and the carve-out
  // doesn't deliver on its name.
  disabledRules: ["no-main-commit-github", "no-main-commit"],
  rules: [noMainCommitExceptVault],
});
```

### Walker-unknown cwd

When the walker can't statically resolve cwd (e.g.
`cd "$VAR" && git commit`), the inner `cwd:` predicate returns
`"unknown"` and the not-block applies its block-level
`onUnknown:` modifier (default `"block"`) to project the verdict.
Default `"block"` means the not-block evaluates to `false`, the
outer rule's `not:` flips to `true`, and the rule fires —
fail-CLOSED. Authors who want walker-unknown vault paths to skip
the rule (fail-OPEN exemption) opt in with the block-level
modifier:

```ts
not: { cwd: VAULT_DIRS, onUnknown: "allow" }
```

The full truth table for `not: { cwd: ... }` under walker-known
vs walker-unknown cwd lives in the
[`dynamic-reason-runtime-cwd` example README][cwd-truth-table].

[cwd-truth-table]: ../../../examples/dynamic-reason-runtime-cwd/README.md

The `Pattern[]` annotation on `VAULT_DIRS` lets you mix string
patterns and RegExp without TS narrowing the array's element type
to `RegExp[]`. Annotation is optional for all-RegExp arrays (TS
infers `RegExp[]`, a subtype of `Pattern[]`); explicit `Pattern[]`
becomes load-bearing only when mixing strings and RegExp.

## Authoring new plugins

This directory is the canonical reference for plugin authors. The
file layout separates concerns — one file per rule / tracker /
predicate / helper, mirroring `examples/work-item-plugin`:

```
src/plugins/git/
├── index.ts                  # public surface + plugin assembly
│                             # (predicates record + rules roster inline)
├── index.test.ts             # rules-roster order pin (first-match-wins)
├── integration.test.ts       # end-to-end wiring through the evaluator
├── trackers/
│   ├── branch-tracker.ts     # walker state modifier (one file per tracker)
│   └── cwd-extensions.ts     # modifiers layering onto existing trackers
├── helpers/
│   ├── git-ops.ts            # raw git query helpers (getBranch, ...)
│   ├── pattern-args.ts       # shared pattern-arg unwrapping helpers
│   ├── boolean-args.ts       # shared boolean-leaf arg unwrapping
│   └── patterns.ts           # PROTECTED_BRANCH_PATTERN
├── predicates/               # one handler per `when.<key>` slot (+ tests)
│   ├── branch.ts
│   ├── upstream.ts
│   ├── commits-ahead.ts
│   ├── has-staged-changes.ts
│   ├── is-clean.ts
│   └── remote.ts
└── rules/                    # one file per rule (+ tests)
    ├── no-force-push.ts
    ├── no-hard-reset.ts
    ├── no-main-commit.ts
    └── no-main-commit-github.ts
```

Each file has its own test suite (co-located `<item>.test.ts`);
`integration.test.ts` pins end-to-end wiring through `resolvePlugins`
and `buildEvaluator`. Copy-adapt this layout for your own plugin.

### Composable building blocks

Several pieces are re-exported from `pi-steering/plugins/git` so
downstream plugins can reuse the engine's walker conventions
without reimplementing them:

- `walkerString(ctx, key, initialSentinel)` / `WalkerStringResult` —
  narrows the walker-tracker value read off `ctx.walkerState[key]`
  into one of `{ kind: "value"; value }` | `{ kind: "unknown" }` |
  `{ kind: "missing" }`. The three-way discrimination is what the
  `branch` predicate uses to dispatch on tracker state without
  string-comparison sentinel checks.
- `NO_CHECKOUT_IN_CHAIN` — the branch tracker's fall-through
  sentinel for chains where no in-chain `git checkout` /
  `git switch` fired. Plugin authors who consume tracker state
  directly can match this sentinel to know they need to fall back
  to a shell-out (vs. `"unknown"`, where the tracker observed an
  unresolvable checkout).
- `PROTECTED_BRANCH_PATTERN` — the shared protected-branch
  regex (`main` / `master` / `mainline` / `trunk`). Reuse in plugin
  rules that want to share applicability with the shipped
  commit-on-main rules (routing itself is `command: "git"` +
  `subcommand: "commit"` — no regex needed).

Example import:

```ts
import {
  walkerString,
  NO_CHECKOUT_IN_CHAIN,
  PROTECTED_BRANCH_PATTERN,
} from "@cad0p/pi-steering/plugins/git";
```
