# Local pi source patches

Patch files here are re-applied to every installed pi release, and to installed npm extensions that need a local fix. They exist because pi installs
each version into `~/.pi/agent/install/releases/<version>/`, so anything we change under
`node_modules/@earendil-works/pi-coding-agent/dist/` is gone on upgrade. Unpinned extensions under `~/.pi/agent/npm/node_modules/` are reinstalled the same way.

## Layout

- `apply.sh` — the runner. `apply.sh` reconciles, `--status` reports, `--dry-run` previews, `-q` is for startup, `--all` widens the scope (see below).
- `lib.sh` — helpers the runner and patch files share (state probe, backup, syntax check).
- `pi/NNNN-<name>.patch.sh` — patches to pi itself (the active release under `install/releases/`).
- `<extension>/NNNN-<name>.patch.sh` — patches to one installed npm extension, one folder per extension (`pi-devin/` = `@buyong/pi-devin`). Each sets `PATCH_ROOTS`.
- One patch per file, with the upstream link and a removal condition. Numbers are global and never reused: the number is also the `local patch NNNN` marker written into the patched code, which is how the runner knows a file is already patched, and the upstream issues and notes cite it.
- `local-patches/` — a local pi package whose extension runs `apply.sh -q` at `session_start`
  and registers `/patches`.

## Scope

By default the runner only touches the **active release** — the one `install/current-version` points at, i.e. the code pi will actually run. Old releases left on disk are not modified: patching them would only change code that cannot execute, and if you ever roll back by editing `current-version`, that release becomes active and the next session patches it then.

`--all` reconciles every installed release. Use it to audit, or to pre-patch a rollback target before switching to it.

A patch that sets `PATCH_ROOTS` ignores the release scope and targets those package roots instead (e.g. `${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin`). Its output is labelled with the package name and version, and any change asks for a restart, because the extension is already loaded.

## How it works

Each patch declares:

| variable | meaning |
|---|---|
| `PATCH_FILES` | globs relative to the package root (chunk names change per release, so target directories) |
| `PATCH_ROOTS` | optional package root globs; default is the pi-coding-agent package of the releases in scope |
| `UNPATCHED_RE` / `PATCHED_RE` | how to tell the upstream form from the patched form (idempotency) |
| `UPSTREAM_FIXED_RE` | optional: matches the code that shows the fix landed upstream. Then the patch reports `upstream fixed this — delete the patch file` and touches nothing, even when `UNPATCHED_RE` still matches an anchor line that survived the upstream rewrite (2026-11-11: pi-devin 0.1.15 fixed #73/#74 while the old anchor line stayed, so the shape alone said "unpatched") |
| `PATCH_PERL` | the `perl -0 -p` substitution program |
| `PATCH_UPSTREAM` / `PATCH_REMOVE_WHEN` | which upstream issue this works around, and when to delete the file |

The runner backs up each file it touches to `<file>.orig`. It restores the backup if perl fails, if the result does not match `PATCHED_RE`, or if the syntax check fails. The syntax check is `node --check`; `.ts` files are type-stripped with `node:module`'s `stripTypeScriptTypes` first.

pnpm installs (the npm extensions) hardlink package files into the content-addressed store. `perl -i` writes a new inode, so patching never touches the store copy. Do not "fix" a target with an in-place write such as `cp` over it or an editor that preserves the inode. A patch whose target code is absent (upstream refactored it) reports as "not applicable" and does nothing.

**When a patch may lie, write `UPSTREAM_FIXED_RE`.** A patch decides "unpatched" from the shape of the line it rewrites, so a release that keeps that line while adding the fix elsewhere (or next to it) reads as "needs patch" and applying would duplicate or contradict the upstream code. Declare the upstream fix's own code instead: the runner then reports the patch as obsolete and skips it. Two examples are wired today: `0007` matches `auto_retry_decision` (the hook pi#11932 asks for), so it retires itself the day pi grows that event.

## Why the auto-apply runs at session_start

The patch only takes effect on the **next** launch: the running process has already imported the
modules. So the extension patches the installed release as soon as a session starts, and warns
when it did — after an upgrade you get one session with unpatched warming and a visible notice,
instead of a silent regression. Check state any time with:

```sh
~/.pi/agent/patches/apply.sh --status        # active release
~/.pi/agent/patches/apply.sh --status --all  # every installed release
```

## Active patches

Status as of 2026-11-11, after `@buyong/pi-devin` 0.1.16. Five of the six pi-devin patches are gone: 0.1.15 shipped fixes for #70, #71, #72, #73 and #74 (changelog: newest-only cache mark, parallel tool calls, orphaned tool call results, output limit fit to the context, shared-runtime routing), each with a regression test. Only `0003` remains on the extension side. `0001` and `0007` are still needed on pi 1.5.2.

### `pi/` — pi itself (`@earendil-works/pi-coding-agent` 1.5.2)

| id | what it fixes | upstream | remove when |
|---|---|---|---|
| `0001-cache-warming-identity` | idle cache warming dies at the first turn that re-projects a custom/compaction message (identity compare in `cacheContextIsCurrent`) | [earendil-works/pi#10956](https://github.com/earendil-works/pi/issues/10956) open; 1.5.2 still compares with `===` | upstream compares re-projected messages by entry id |
| `0007-agent-retry-server-hint` | agent-level retry ignores the server's wait ("reset in 16 seconds"), so rate-limited turns burn their 3 retries inside the window; a hint past `retry.maxAgentDelayMs` (e.g. "~3 hours") is no longer retried, so fallback moves on at once | [earendil-works/pi/issues/11932](https://github.com/earendil-works/pi/issues/11932) proposes an `auto_retry_decision` hook instead of text parsing; still pure backoff in 1.5.2 | upstream fires a retry decision event an extension can answer, and this repo uses it |

### `pi-devin/` — `@buyong/pi-devin` 0.1.16

| id | what it fixes | upstream | remove when |
|---|---|---|---|
| `0003-pi-devin-cache-warming` | extension forces `{ action: "stop" }` on cache warming for every devin model; with it removed pi decides, opt-in per model in `models.json` (`promptCache` + `cost`, today only `claude-opus-5-5`) | local only: 0.1.16 still stops warming on purpose (server TTL unverified) | **critical, keep.** Without it every pause longer than the cache TTL re-sends the lead's whole Opus prefix uncached against the Devin quota. Remove only if upstream lets pi decide warming for devin models |

### Removed after 0.1.16

| id | was | fixed upstream by |
|---|---|---|
| `0002-pi-devin-cache-breakpoint` | every user/tool message marked EPHEMERAL | #70: `request.ts` keeps only the newest mark (test `pi-provider.test.ts` L290) |
| `0004-pi-devin-orphan-tool-calls` | `invalid_argument` after a tree rewind | #73: `toDevinTranscript()` answers unanswered calls with Pi's "No result provided" |
| `0005-pi-devin-session-router` | in-process subagent took the lead's provider ("Operation aborted") | #71: `routing` routes each call to its session's instance (`pi-shared-runtime.test.ts`) |
| `0006-pi-devin-parallel-tool-calls` | "Cannot attach a delta without a tool ID…" with parallel calls | #72: the accumulator attaches id-less deltas to the last named call |
| `0008-pi-devin-clamp-max-tokens` | output limit never clamped to the context window | #74: `outputLimitForContext()` reserves room for the input |

## Adding a patch

1. Copy an existing `.patch.sh` into the folder of its target (`pi/`, or a folder named after the extension) and give it the next global number.
2. Fill in the metadata; keep `PATCHED_RE` narrow enough to be unique in the target files.
3. `./apply.sh --dry-run`, then `./apply.sh`, then run it twice to prove idempotency.
4. Verify the effect in a fresh pi session, not just the syntax check.
5. Delete the file once upstream ships the fix — the runner is a no-op for absent targets, so
   leaving a stale patch is only noise, but it is noise.

Note: `agent/bin`, `agent/install` and `agent/npm` are gitignored in this repo, so the
patched code itself is never committed — only these scripts are.
