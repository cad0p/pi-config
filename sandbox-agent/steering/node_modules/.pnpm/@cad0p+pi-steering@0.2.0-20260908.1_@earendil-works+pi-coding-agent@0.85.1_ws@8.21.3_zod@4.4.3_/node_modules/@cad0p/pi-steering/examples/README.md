# Rule-pack examples

Curated rule-pack examples for common workflows. Each subdirectory
ships both a TypeScript config (`steering.ts`) and a JSON config
(`steering.json`). Each has its own README with rationale.

| Example | What it enforces | Best for |
|---------|------------------|----------|
| [force-push-strict](./force-push-strict) | Reference for the disable-and-replace idiom — the git plugin's `no-force-push` rule is sealed (blocks every rewrite form, incl. `--force-with-lease`) | Teams overriding the shipped rule with a custom force-push policy |
| [no-amend](./no-amend) | No `git commit --amend`. Includes a cwd-scoped variant | Review-driven workflows where commit-SHA stability matters |
| [draft-prs-only](./draft-prs-only) | `gh pr create` requires `--draft` | Teams that require human review before marking ready |
| [combined-git-discipline](./combined-git-discipline) | no-amend + draft-PRs-only on top of the declared git/rm/async plugins (incl. the sealed force-push rule) | Starting point for disciplined PR teams |
| [dynamic-reason-runtime-cwd](./dynamic-reason-runtime-cwd) | Composes a runtime-cwd predicate (`isClean`) with a two-branch `ReasonFn` using `walkerUnknownCwdReason` | Plugin authors writing rules over runtime-cwd predicates that need useful agent reasons on the walker-unknown branch |
| [work-item-plugin](./work-item-plugin) | Canonical example PLUGIN (not a rule-pack). See the plugin's own README. | Authors writing a new plugin |

Each rule-pack directory has smoke tests (`steering.test.ts`) that
verify the config compiles under the current `defineConfig` API and
exposes the expected shape. Behavioural coverage (every pattern,
every wrapper form) lives in the engine's own test suite.

## How to use

### TypeScript (canonical)

1. **Copy** `steering.ts` from an example directory into one of:
   - `~/.pi/agent/steering.ts` (or `~/.pi/agent/steering/index.ts`) — applies globally.
   - `<your-project>/.pi/steering.ts` — applies to this project only (project layer).
2. **Tweak** as needed — the exported default is a plain
   [`SteeringConfig`](../src/schema.ts), so you can add rules,
   merge with other packs by spreading, or import a plugin.
3. **Verify** the rule is active by running `pi` in the target
   directory; the rules load on `session_start`.

**Hover-rich authoring:** factor each rule out into a
`const myRule = { ... } as const satisfies Rule` binding before
passing it to `defineConfig`, as `dynamic-reason-runtime-cwd/steering.ts`
does. Inline rule literals inside `defineConfig({ rules: [{ ... }] })`
get their contextual type narrowed to the `const`-inferred shape and
bypass the homomorphic mapped-type linkage that surfaces source-
declared JSDoc on hover for plugin predicates (`when.isClean`, etc.).
The `as const` modifier on the binding preserves each rule's literal
`name` so `disabledRules` typo detection fires; the alternatives
(`: Rule` or bare `satisfies Rule`) restore hover but widen the
inferred type and collapse typo detection.

### JSON

The loader does **not** load `.pi/steering.json` files directly — only
`.pi/steering.ts` / `.pi/steering/index.ts`. To migrate an existing
JSON config:

1. Convert with the CLI: `pi-steering import-json .pi/steering.json -o .pi/steering/index.ts`
2. Or programmatically: `fromJSON(JSON.parse(text))` from
   [`compat.ts`](../src/compat.ts), if you're wrapping the conversion
   in your own tooling.

Each example ships a `steering.json` for reference / migration
testing — they're authored against the v0 PoC shape so
`pi-steering import-json` round-trips them cleanly. They do **not**
participate in the loader's project-layer discovery; only the `.ts` form does.

JSON is a deliberate **subset** of the TypeScript schema: pattern-string
rules, `requires` / `unless`, `when.cwd` (string pattern only), and
override flags. Plugins, observers, function-valued rule fields,
plugin-registered predicate keys (`when.<customKey>`), `when.not`,
and `when.condition` are TypeScript-only — `pi-steering import-json`
rejects them with `FromJSONError`. Equivalently: any `when` clause
member other than `when.cwd` is rejected.

If you're not ready to migrate, the v0 runtime had its own loader that
did load JSON; staying on v0 is an option until you convert.

## Verifying a rule works

The quickest smoke-check: run the example's blocked command inside a
pi session and confirm the agent surfaces the `This tool call was not
executed; blocked by a steering rule:` preamble followed by the
`[steering:<rule-name>@<source>] …` block message. Each example directory's
`steering.test.ts` pins the config's structural contract; the engine's
own test suite exercises the rules against realistic inputs.

See the [package README](../README.md) for the schema details
(`pattern`, `requires`, `unless`, `when.cwd`, `reason`,
`noOverride`) and the [repo README](../../../README.md) for the
overall architecture.
