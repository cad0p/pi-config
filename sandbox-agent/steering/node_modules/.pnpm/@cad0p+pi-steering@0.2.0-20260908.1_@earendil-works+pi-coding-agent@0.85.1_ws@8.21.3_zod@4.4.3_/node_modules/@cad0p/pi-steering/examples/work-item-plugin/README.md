# work-item-plugin — example plugin for pi-steering

> **Note**: this is a READABLE REFERENCE, not a plugin for production use. The rules and patterns are domain-generic on purpose — copy the structure, swap the specifics.

A compact plugin that demonstrates every authoring pattern the v0.1.0 release ships. Reading the source top-to-bottom is the fastest way to understand how to build one of these.

## What's in the box

```
examples/work-item-plugin/
├── package.json                # peerDep on pi-steering
├── tsconfig.json               # extends repo base
├── README.md                   # (this file)
└── src/
    ├── index.ts                # default export: Plugin
    ├── index.test.ts           # end-to-end plugin tests
    ├── predicates/
    │   ├── work-item-format.ts       # workItemFormat + [PROJ-N] regex
    │   └── work-item-format.test.ts
    ├── observers/
    │   ├── npm-test-tracker.ts        # TEST_PASSED_EVENT + observer
    │   ├── npm-test-tracker.test.ts
    │   ├── retest-required-tracker.ts # RETEST_REQUIRED_EVENT + observer
    │   └── retest-required-tracker.test.ts
    └── rules/
        ├── commit-requires-work-item.ts
        ├── commit-requires-work-item.test.ts
        ├── push-requires-tests.ts
        ├── push-requires-tests.test.ts
        ├── commit-description-check.ts
        └── commit-description-check.test.ts
```

## What each piece demonstrates

| File | Concept |
| --- | --- |
| `predicates/work-item-format.ts` | `definePredicate<T>` for typed arg shapes. Quote-aware `input.args` access (ADR §9). |
| `observers/npm-test-tracker.ts` | Observer encapsulation convention (ADR §14): export `<EVENT>_EVENT` + `mark<Event>(ctx)` helper + the observer. |
| `observers/retest-required-tracker.ts` | Invalidation-sentinel observer for the `missing.since` pattern. Writes `RETEST_REQUIRED_EVENT` on every successful `git pull`. |
| `rules/commit-requires-work-item.ts` | Plugin predicate consumed from `when.<key>`. `not:` inversion. |
| `rules/push-requires-tests.ts` | Observer → rule coupling via shared event constants. `when.missing: { in: "agent_loop", since: ... }` with temporal invalidation. Also demonstrates `&&`-chain speculative allow for `npm test && git push`. |
| `rules/commit-description-check.ts` | Self-marking rule with `Rule.onFire` (ADR §6). Constant + helper co-located with the rule when no observer corresponds (ADR §14). |
| `index.ts` | `as const satisfies Plugin` to preserve literal types for `defineConfig`'s compile-time cross-reference checking (ADR §7). |

## ADR references

The canonical references for every pattern this plugin demonstrates live in the repo's ADR log (napkin vault):

- §6 — `Rule.onFire` side-effect hook (self-marking pattern)
- §7 — `Observer.writes` and `Rule.writes` declarations (compile-time type constraints)
- §9 — `PredicateToolInput.args` + `basename` (quote-aware structured access)
- §10 — `definePredicate<T>` helper (typed variance cast)
- §14 — Observer encapsulation convention (type + helper + consumer pattern)
- §15 — This example plugin's goals

## Running the tests

```sh
# From the repo root:
pnpm install
pnpm --filter @examples/work-item-plugin test
```

The `pretest` script builds `@cad0p/pi-steering` first, so the example resolves
the package through its emitted `dist/` exports. On a fresh clone this
adds a few seconds on the first run; subsequent runs skip the rebuild if
nothing changed.

Or `pnpm -r test` runs all packages' suites including this one.

## Consuming this plugin from your own config

```ts
// .pi/steering/index.ts
import { defineConfig } from "@cad0p/pi-steering";
import workItemPlugin from "@examples/work-item-plugin";

export default defineConfig({
  plugins: [workItemPlugin],
});
```

In a real project, you'd replace `@examples/work-item-plugin` with your own published plugin that follows this same layout.

## The rules, in one paragraph each

**`commit-requires-work-item`** — intercepts `git commit -m "..."` and blocks unless the message carries a `[PROJ-N]` token. Uses the `workItemFormat` predicate under `when.not` (the predicate returns "work-item is present" as TRUE; we invert it to mean "fire when missing").

**`push-requires-tests`** — intercepts `git push`. Blocks unless `npm test` has succeeded in the current agent loop AND no subsequent `git pull` has stale-d that success. Combines three features in one rule:

  - `npm-test-tracker` writes `TEST_PASSED_EVENT` on every successful `npm test`.
  - `retest-required-tracker` writes `RETEST_REQUIRED_EVENT` on every successful `git pull`.
  - The rule gates via `when.missing: { event: TEST_PASSED_EVENT, in: "agent_loop", since: RETEST_REQUIRED_EVENT }` — fires when tests haven't passed at all in this loop, OR the latest test entry is older than the latest pull entry.
  - Chain-aware: `npm test && git push` is speculatively allowed pre-execution. `&&` short-circuits on test failure, so the push is guarded without forcing a round-trip through the observer.

**`commit-description-check`** — self-marking reminder. First `git commit` per agent loop blocks with a "re-read your description" message and self-marks via `onFire`. Second `git commit` in the same loop passes (the self-mark satisfies `when.missing`). A new agent loop resets the reminder.

## What's intentionally missing

- **A `Tracker`** — the git plugin (`src/plugins/git/`) is the canonical reference for tracker + trackerExtension authoring. This plugin keeps the surface minimal.
- **Production-grade regexes** — the `[PROJ-N]` pattern is a placeholder. Real adopters replace with their project's actual ticket format (e.g. `JIRA-\d+`, `AWF-\d+`).
- **Override customization** — each rule inherits the plugin-level `defaultNoOverride` policy (fail-closed unless the plugin opts out). See the main README's "Authoring rules" section for how overrides work.
