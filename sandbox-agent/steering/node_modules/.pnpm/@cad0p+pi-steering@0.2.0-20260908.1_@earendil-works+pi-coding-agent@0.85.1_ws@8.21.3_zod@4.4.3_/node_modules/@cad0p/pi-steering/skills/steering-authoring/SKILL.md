---
name: steering-authoring
description: Author declarative steering rules for pi-steering. Use when the user asks to block or allow agent tool calls, write guardrails for bash/write/edit, author pi steering rules, add rule plugins, or convert a JSON steering config to the TypeScript config.
---

# pi-steering

You have `@cad0p/pi-steering` installed. It blocks and allows agent tool calls (bash, write, edit) via declarative rules authored in TypeScript.

## Where things live

- Rules: `.pi/steering/index.ts` (directory form) or `.pi/steering.ts` (single-file form).
- Local plugins: `.pi/steering/plugins/*.ts`, imported into `index.ts`.
- Tests: `.pi/steering/*.test.ts` using `@cad0p/pi-steering/testing`.

The loader walks up from `cwd` to the nearest `.pi/` dir, falling back to `~/.pi/`. See the README for the full precedence order.

## Common operations

| User says | You do |
|---|---|
| "block X" | Add a `Rule` with `tool`, `field`, and `pattern` to the `rules` array. |
| "block X only in dir Y" | Add `when: { cwd: /Y/ }` to the rule. The walker resolves `cd "$WS/pkg"`-style dynamic targets through `envTracker`; intractable targets (unknown `$VAR`, command substitution) surface as `"unknown"` and fire `onUnknown: "block"` by default. |
| "block X unless on branch Z" | `when: { not: { branch: /Z/ } }` — requires the git plugin. |
| "block X unless `--flag`" | `unless: /--flag\b/`. |
| "require Y before X" | Observer that `appendEntry`s a marker, plus a rule whose `when.missing` gates on it (`{ event, in: "agent_loop" }`). Prefer this to hand-rolled `findEntries` + `agentLoopIndex` comparisons — same semantics, less code. Observer `watch.inputMatches.command` resolves the same walk registry (incl. plugin `env` trackers) as rules — match what the command resolves to, not the raw `$VAR`. |
| "require Y in a **prior** tool_call, not same-chain" | `when: { missing: { event, in: "agent_loop", notIn: "tool_call" } }`. `notIn` is scope subtraction — it removes the narrower scope from the broader one, so `&&`-chain bypass is blocked. Distinct from clause-level `not` (boolean negation). |
| "invalidate Y when Z happens" | `when: { missing: { event: Y_EVENT, in: "agent_loop", since: Z_EVENT } }`. Y only counts if its latest entry is newer than Z's latest entry in scope. If Z never occurred, the clause degrades to a simple presence check. |
| "put runtime state in the block message" | `reason: (ctx) => \`blocked at \${ctx.walkerState?.cwd}\`` — `Rule.reason` accepts a sync or async function. The engine awaits it and prefixes with `[steering:name@source]` like a string reason (after the fixed preamble `This tool call was not executed; blocked by a steering rule:` that leads every block message). If it throws, a fail-safe fallback text fires and the error is logged to `console.warn`; the block still fires. |
| "add a custom check" | Write a plugin in `.pi/steering/plugins/`, import it into `index.ts`, register it in `plugins: [...]`. |
| "add a one-off check to a single rule" | Name it with `definePredicate`, register it on an inline plugin literal (`declare global` augmentation + `predicates: { mySignal }`, consumed as `when: { mySignal: true }`) — never inline `condition:`, never wire through `requires:` (`condition:` is forbidden in examples and function-valued `requires:`/`unless:` are CI-pinned; the fn slots are one-off escape hatches only). See `examples/force-push-strict/steering.ts`. |
| "change the reason on a built-in rule" | Import the original rule from its plugin, spread it with `{ ...original, name: "new-name", reason: "..." }`, and use `disabledRules: ["original-name"]` + add the replacement. Preserves command / when / observer. |
| "test this rule" | Create `steering.test.ts` using `expectBlocks` / `expectAllows` / `loadHarness`. |
| "convert my JSON config to TypeScript" | Run `pi-steering import-json .pi/steering.json -o .pi/steering.ts`. Plugins, observers, and function predicates don't round-trip — author those directly in TS. |
| "publish a pi-steering plugin" | Package as `pi-steering-<domain>` (unscoped) with `keywords: ["pi-package", "pi-steering-package"]` in package.json. peerDep on `@cad0p/pi-steering`. No direct dep on `@cad0p/unbash-walker` — reuse the package-root walker re-exports (see README "Writing plugins › Dependency rule"). |

## Minimal config

```ts
import { defineConfig } from "@cad0p/pi-steering";

export default defineConfig({
  plugins: [{ name: "facts", cliDescriptors: { "dangerous-command": {} } }],
  rules: [
    {
      name: "no-dangerous-command",
      tool: "bash",
      command: "dangerous-command",
      reason: "don't run this",
    },
  ],
});
```

There are NO engine-shipped default rules (issue #72): every rail lives in an opt-in domain plugin — declare `plugins: [gitPlugin, rmPlugin]` to get `no-force-push` / `no-hard-reset` and `no-rm-rf-slash`. Declaring a plugin is also what feeds its rule / plugin names into `defineConfig`'s type unions (typo-checking on `disabledRules` / `disabledPlugins`), keeping the types in sync with what's actually loaded. Disable individual rules via `disabledRules: ["name"]`; simply don't declare a plugin you don't want.

## Git plugin (branch / upstream / commits-ahead predicates)

```ts
import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  rules: [
    {
      name: "no-main-push",
      tool: "bash",
      command: "git",
      when: { subcommand: "push", branch: /^(main|master|mainline|trunk)$/ },
      reason: "don't push from main",
    },
  ],
});
```

## Testing

```ts
// .pi/steering/steering.test.ts
import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

describe("my steering config", () => {
  // The old defaults-injection harness flag is gone (#72): declare
  // plugins in the config itself when you want their rails under test.
  const harness = loadHarness({ config });

  it("blocks dangerous-command", async () => {
    await expectBlocks(harness, { command: "dangerous-command run" });
  });

  it("allows safe commands", async () => {
    await expectAllows(harness, { command: "ls" });
  });
});
```

Run with `node --test '.pi/steering/**/*.test.ts'`.

## Details

Read [the package README](../../README.md) for the full schema, plugin authoring, observer / turn-state patterns, override semantics, and the JSON-to-TS conversion surface.
