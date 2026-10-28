# combined-git-discipline

A batteries-included rule pack that stacks PR/git-hygiene rules on top of the declared domain plugins (git / rm). Drop-in starting point for teams that want disciplined PR workflows.

> **TypeScript form (canonical):** see [`steering.ts`](./steering.ts) — drop in at `~/.pi/agent/steering.ts` or `<project-root>/.pi/steering.ts`. The loader accepts TypeScript only. The [`steering.json`](./steering.json) form is provided for reference + `pi-steering import-json` migration; the loader does NOT pick up JSON files. See [examples/README.md#json](../README.md#json) for migration steps.

## What it enforces

From this pack:

| Rule | What it blocks |
|---|---|
| `no-amend` | `git commit --amend` — preserves review-diff continuity. See [`../no-amend`](../no-amend). |
| `pr-create-must-be-draft` | `gh pr create` without `--draft`. See [`../draft-prs-only`](../draft-prs-only). |

Force pushes are covered by the git plugin — no extra rule needed. Since issue [#65](https://github.com/cad0p/pi-steering/issues/65) its shipped `no-force-push` rule is **sealed**: it blocks every remote-history-rewrite form (`--force`, `--force-with-lease`, `--force-if-includes`, bundled shorts like `-uf`, leading-`+` refspecs like `git push origin +main`, and `--mirror`). Older copies of this pack disabled that rule and re-added a stricter variant; that step is now redundant — and dropping it actually *strengthens* coverage, since the sealed rule catches more than the old strict one did.

From the declared plugins (git + rm, per issue #72 there are no engine-injected rails):

| Rule | What it blocks |
|---|---|
| `no-force-push` | Every history-rewrite push form (see above). Sealed by [#65](https://github.com/cad0p/pi-steering/issues/65). |
| `no-hard-reset` | `git reset --hard` — prevents silent loss of uncommitted work. |
| `no-rm-rf-slash` | `rm -rf /` with any flag combination or wrapper. `noOverride: true`. |

## Precedence: why there's no `disable` anymore

Earlier revisions of this pack used the disable-and-replace idiom: `"disable": ["no-force-push"]` plus a stricter `no-force-push-strict` replacement, because the shipped rule then deliberately permitted `--force-with-lease`. With the rule sealed, that dance is gone: the pack now ships only its two additive rules and lets the hardened shipped rule handle force pushes. If you ever want to *loosen* it (e.g. re-allow lease pushes), that's when disable-and-replace comes back — see [`../force-push-strict`](../force-push-strict) for the idiom.

The loader applies `disable[]` as a union across all config layers and looks up rules by `name`, so layer order never matters — keep that in mind if you add your own overrides on top of this pack.

## Why these together

Each rule on its own is reasonable. Stacking them encodes a specific team discipline:

- History is append-only (`no-force-push` + `no-hard-reset` from the git plugin, plus this pack's `no-amend`).
- Code review is gated by the human (`pr-create-must-be-draft`).
- The agent can't shoot everyone in the foot (`no-rm-rf-slash`).

Use this as a starting point and carve out exceptions with inline override comments (`# steering-override: <rule-name> — <reason>`) for the edge cases that genuinely need them.

## When to use

- Teams that want a disciplined PR workflow without per-agent coaching
- Shared repositories where agent autonomy is useful but history integrity matters
- Starting point for building your own house rules — copy this file, tune the reasons, add more rules

## Install

Copy [`steering.ts`](./steering.ts) to `~/.pi/agent/steering.ts` (global) or to `<project-root>/.pi/steering.ts` (project layer). For tighter scoping, add `when.cwd` to individual rules — see [`../no-amend`](../no-amend) for an example. The loader accepts TypeScript only; see [examples/README.md#json](../README.md#json) if you're migrating from a `steering.json`.
