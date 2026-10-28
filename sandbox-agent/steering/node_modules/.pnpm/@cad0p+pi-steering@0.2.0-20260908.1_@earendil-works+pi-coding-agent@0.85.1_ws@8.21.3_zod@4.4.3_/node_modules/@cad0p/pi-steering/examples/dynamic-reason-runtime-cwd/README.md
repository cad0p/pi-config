# Example: dynamic-reason + walker-unknown-cwd

Worked example tying together two pi-steering primitives:

- Runtime-cwd predicate trinary surfacing (gitPlugin's `isClean` /
  `hasStagedChanges` / `remote` / `upstream` / `commitsAhead` all inline a
  walker-unknown-cwd guard at the top of the handler and surface trinary
  `"unknown"` when the walker can't statically resolve cwd). The engine's
  leaf-level (or block-level inside `not:`) `onUnknown:` policy then
  projects to a definite verdict — default `"block"` (fail-CLOSED, rule
  fires).
- `walkerUnknownCwdReason` (from `@cad0p/pi-steering`) — the agent-facing reason
  text helper for the walker-unknown-cwd fail-CLOSED branch.

Together these give external plugin authors the ergonomics story for
runtime-cwd predicates: every gitPlugin runtime-cwd predicate gets the
engine's fail-CLOSED `onUnknown: "block"` semantics for free, and the
`walkerUnknownCwdReason` helper produces a useful agent-facing message
that distinguishes "the predicate fired because the state is genuinely
bad" from "the predicate fired because the walker couldn't tell".

## Pattern

The rule's `reason` is a `ReasonFn` (not a static string). It branches on
`ctx.walkerState?.cwd === "unknown"`:

```ts
reason: (ctx) => {
  if (ctx.walkerState?.cwd === "unknown") {
    // Walker couldn't statically resolve cwd. The predicate's inline
    // guard surfaced trinary "unknown"; the engine's default
    // onUnknown: "block" projected it to true so the rule fired
    // fail-CLOSED. Produce a generic explanation via the helper, then
    // append retry guidance.
    return (
      walkerUnknownCwdReason(ctx, "working tree status") +
      " Run from inside the package directory with a literal path."
    );
  }
  // Walker statically resolved cwd; the predicate genuinely fired
  // (working tree is dirty). Domain-specific reason.
  return "Working tree has uncommitted changes. Commit or stash before deploying.";
},
```

The agent gets a useful next-step in both cases instead of a
generic "rule blocked" message.

The rule is gated by `when: { isClean: false }`. The next subsection
explains why this canonical positive form is preferred over
`when: { not: { isClean: true } }` even though both shapes now produce
the same fail-CLOSED behavior under walker-unknown cwd by default.

## Why `isClean: false` over `not: { isClean: true }`

Both shapes describe "the working tree is NOT clean". Under the trinary
engine introduced in v0.1.0, both are fail-CLOSED by default on the
walker-unknown-cwd branch, so polarity-of-default is no longer the
deciding factor. The recommendation is now about readability, smaller
composition surface, and an end-to-end behavior gap on the
walker-known + git-fails row.

| state                       | `isClean` returns | `when: { isClean: false }`      | `when: { not: { isClean: true } }` |
|-----------------------------|-------------------|----------------------------------|--------------------------------------|
| walker-unknown cwd          | `"unknown"`       | fires ✅ (leaf default block)    | fires ✅ (block-level default block) |
| walker-known + clean        | `true`            | does NOT fire ✅                 | does NOT fire ✅                      |
| walker-known + dirty        | `false`           | fires ✅                         | fires ✅                              |
| walker-known + git fails    | `false`           | does NOT fire ❌ (fail-OPEN)     | fires ⚠️ (Kleene-AND-false absorbs)  |

The two shapes agree on every row except `walker-known + git fails`,
where they diverge:

- `isClean: false`: the handler returns boolean `false` on git failure
  (`getWorkingTreeClean` returns `null` → handler short-circuits to
  `false`, NOT `"unknown"`).  Leaf verdict is `false` → rule skips.
- `not: { isClean: true }`: the handler again returns `false` on git
  failure.  Inner verdict is `false`, Kleene AND of a single false leaf
  is `false`, the not-flip yields `true` → rule fires.

The asymmetry is real: `isClean: false` reads as "fire when the
handler positively asserts dirty"; `not: { isClean: true }` reads as
"fire when the handler does NOT positively assert clean", and a
failed git call is a non-clean-assertion under that wording.  Pair
`isClean` with an `upstream` check to cover the git-fails branch
uniformly under either shape (handler returns `false` on git failure;
the `upstream:` leaf surfaces trinary `"unknown"` and the engine's
`onUnknown:` policy projects).

Why prefer `{ isClean: false }`:

- **Reads forward.** "Block when isClean is false" matches how a human
  describes the rule out loud.
- **Smaller composition surface.** A bare leaf takes per-leaf
  modifiers (`isClean: { value: false, onUnknown: "allow" }`) at the
  leaf level. A `not:` block takes block-level modifiers and forbids
  per-leaf modifiers inside; if you ever need a different `onUnknown:`
  policy on this single leaf, the bare form is the simpler edit.
- **Idiomatic.** gitPlugin's predicate registry JSDoc (`declare global`
  block in `src/plugins/git/index.ts`) documents both
  polarities of every boolean predicate (`isClean: true` /
  `isClean: false`, `hasStagedChanges: true` / `hasStagedChanges: false`)
  exactly so authors can avoid `not:` for negation when a documented
  inverted shape exists.

### Pair with `upstream:` to cover the git-fails branch

Neither bare-form nor `not:`-form covers the `walker-known + git fails`
row uniformly.  Put a fail-CLOSED `upstream:` check first in the same
`when:` to convert the gitfailure into a definite verdict (the
`upstream:` handler surfaces `"unknown"` instead of returning a
boolean, so the engine's `onUnknown:` policy projects to fail-CLOSED
and the rule fires regardless of which `isClean:` shape you used):

```ts
when: { upstream: /./, isClean: false }
```

`{ not: { isClean: true } }` is correct under the new engine for the
walker-unknown row — pick whichever reads cleaner at the call site,
and pair it with `upstream:` either way.

Rule of thumb for any future plugin author copying this example:
prefer the predicate's documented inverted shape (e.g., `isClean: false`,
`hasStagedChanges: false`) when one exists. Reach for `not:` when
combining multiple leaves under a single negation
(`not: { branch: "main", remote: /github/ }`) or when no inverted
shape is available (regex predicates, etc.).

## When to use this pattern

When your rule consumes any runtime-cwd predicate from a plugin
(gitPlugin's `isClean` / `hasStagedChanges` / `remote` / `upstream` /
`commitsAhead`, or any external plugin's runtime-cwd predicate that
inlines a `cwdIsWalkerUnknown` guard).

Without the two-branch ReasonFn, a rule with a static `reason: "..."`
would print the same message in both cases — uninformative when the
trigger was a dynamic-cwd target the walker bailed on.

## Cross-references

- `walkerUnknownCwdReason` JSDoc — `src/helpers/walker-unknown-cwd-reason.ts`. Read for the helper's signature, the `verifying` arg contract, and a worked rule snippet.
- gitPlugin runtime-cwd predicates —
  `src/plugins/git/predicates/{upstream,remote,is-clean,has-staged-changes,commits-ahead}.ts`. Each has a `@see {@link walkerUnknownCwdReason}` cross-link in its JSDoc, surfacing the helper at the predicate's hover location.

## Run the tests

```bash
pnpm --filter @examples/dynamic-reason-runtime-cwd test
```
