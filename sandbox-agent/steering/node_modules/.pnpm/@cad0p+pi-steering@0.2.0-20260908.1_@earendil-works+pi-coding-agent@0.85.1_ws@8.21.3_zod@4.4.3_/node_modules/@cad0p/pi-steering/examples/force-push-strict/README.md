# force-push-strict

A rule pack that blocks **every** form of `git push --force`, including `--force-with-lease`.

> **Redundant since issue [#65](https://github.com/cad0p/pi-steering/issues/65).** The git plugin's `no-force-push` rule is *sealed*: it blocks every remote-history-rewrite form — `--force`, `--force-with-lease`, `--force-if-includes`, bundled short flags (`-uf`, `-fu`, `-nfv`), leading-`+` refspecs (`git push origin +main`), and `--mirror`. The shipped rule covers everything this pack does, and more. The pack is kept as a **reference for the disable-and-replace idiom**: dropping a shipped rule via `disabledRules` and installing your own rule under a new name (declare the shipping plugin first — since issue #72 nothing is engine-injected).

## What it enforces

- `git push --force` → blocked
- `git push -f` → blocked
- `git push --force-with-lease` → **blocked**
- `git push origin +main` (leading-`+` refspec) → blocked
- `git push --mirror` → blocked
- `git push origin main` → allowed

The pattern also handles git pre-subcommand flags (`git -C /other push --force`, `git -c key=val push -f`) and wrapper bypasses (`sh -c 'git push --force'`, `sudo xargs git push --force`, …) — all transparently, via the AST backend.

## How it relates to the shipped rule

Historically, the built-in `no-force-push` rule permitted `--force-with-lease` (the documented "safe" way to update a branch after a rebase), and this pack existed to close that carve-out for strict-history teams. Issue #65 sealed the shipped rule instead: every history-rewrite form now blocks out of the box (once the git plugin is declared), with a dedicated reason message.

What remains interesting here is the **mechanism**, not the policy:

1. `plugins: [gitPlugin]` declares the shipping plugin (required post-#72 — no implicit rails).
2. `disabledRules: ["no-force-push"]` turns the shipped rule off.
3. A custom rule (`no-force-push-strict`) takes its place with its own pattern and reason message.

That's the idiom to reach for whenever you want a *different* policy or block message than a shipped rule provides — including loosening one (e.g. re-allowing lease pushes behind your own narrower rule).

## When to use

- You want a custom force-push reason message or a tweaked pattern on top of the sealed semantics
- As a template for disable-and-replace overrides of any other shipped rule
- Strict-history environments that pin an explicit in-repo policy file rather than relying on shipped plugin rules

## Install

Two equivalent forms. Pick whichever matches your setup.

### TypeScript form (canonical)

Copy [`steering.ts`](./steering.ts) to `~/.pi/agent/steering.ts` (or
`<project-root>/.pi/steering.ts`) for a repo-scoped policy. The
TypeScript form participates in compile-time checking via
`defineConfig`. The loader accepts TypeScript only.

### JSON form (for migration)

The loader does **not** load `.pi/steering.json` files directly. The
[`steering.json`](./steering.json) below is provided as a reference
shape for `pi-steering import-json` migration — convert it with
`pi-steering import-json steering.json -o .pi/steering/index.ts` (or
programmatically via `fromJSON` from `compat.ts`).

JSON is a deliberate subset of the TypeScript shape: pattern-string
rules, `requires` / `unless`, `when.cwd` (string pattern only), and
override flags. Plugins, observers, function-valued rule fields,
plugin-registered predicate keys (`when.<customKey>`), `when.not`,
and `when.condition` are TypeScript-only — equivalently, any `when`
clause member other than `when.cwd` is rejected.

The JSON `disable` entry is the v1-era spelling of
`disabledRules`; it migrates to `disabledRules: ["no-force-push"]`
and turns off the git plugin's shipped rule — the new
`no-force-push-strict` rule takes its place:

```json
{
  "disable": ["no-force-push"],
  "rules": [
    {
      "name": "no-force-push-strict",
      "tool": "bash",
      "field": "command",
      "pattern": "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-[A-Za-z]*f[A-Za-z]*(?:\\s|$)|\\s\\+[^\\s:]+(?::\\S*)?(?:\\s|$)|--mirror\\b)",
      "reason": "No force pushes of any kind, including --force-with-lease. Create a new commit, or reset + re-commit via a non-force path."
    }
  ]
}
```

See [examples/README.md#json](../README.md#json) for the full migration
workflow and the v0 fallback option.
