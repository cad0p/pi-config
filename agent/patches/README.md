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
| `PATCH_PERL` | the `perl -0 -p` substitution program |
| `PATCH_UPSTREAM` / `PATCH_REMOVE_WHEN` | which upstream issue this works around, and when to delete the file |

The runner backs up each file it touches to `<file>.orig`. It restores the backup if perl fails, if the result does not match `PATCHED_RE`, or if the syntax check fails. The syntax check is `node --check`; `.ts` files are type-stripped with `node:module`'s `stripTypeScriptTypes` first.

pnpm installs (the npm extensions) hardlink package files into the content-addressed store. `perl -i` writes a new inode, so patching never touches the store copy. Do not "fix" a target with an in-place write such as `cp` over it or an editor that preserves the inode. A patch whose target code is absent (upstream fixed
it, or the code was refactored) reports as "not applicable" and does nothing.

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

Status as of 2026-11-10. All eight are applied, still needed (no upstream fix released), and verified to rebuild byte-identically from pristine files.

### `pi/` — pi itself (`@earendil-works/pi-coding-agent` 1.5.1)

| id | what it fixes | upstream | remove when |
|---|---|---|---|
| `0001-cache-warming-identity` | idle cache warming dies at the first turn that re-projects a custom/compaction message (identity compare in `cacheContextIsCurrent`) | [earendil-works/pi#10956](https://github.com/earendil-works/pi/issues/10956) open; 1.5.1 still compares with `===` | upstream compares re-projected messages by entry id |
| `0007-agent-retry-server-hint` | agent-level retry ignores the server's wait ("reset in 16 seconds"), so rate-limited turns burn their 3 retries inside the window; a hint past `retry.maxAgentDelayMs` (e.g. "~3 hours") is no longer retried, so fallback moves on at once | [earendil-works/pi#10601](https://github.com/earendil-works/pi/issues/10601) closed, fix #10600 not merged; 1.5.1 still pure backoff | upstream agent retry honors server-requested delays from the error text |

### `pi-devin/` — `@buyong/pi-devin` 0.1.14 (latest on npm; upstream main unchanged since `7d5a318`)

| id | what it fixes | upstream | remove when |
|---|---|---|---|
| `0002-pi-devin-cache-breakpoint` | every user/tool message marked EPHEMERAL, so the Claude cache prefix freezes after ~3 turns | [buYoung/pi-packages#70](https://github.com/buYoung/pi-packages/issues/70) open | only the newest message carries the mark |
| `0003-pi-devin-cache-warming` | extension forces `{ action: "stop" }` on cache warming for every devin model; with it removed pi decides, opt-in per model in `models.json` (`promptCache` + `cost`, today only `claude-opus-5-5`) | local only: upstream stops warming on purpose (server TTL unverified) | **critical, keep.** Without it every pause longer than the cache TTL re-sends the lead's whole Opus prefix uncached against the Devin quota. Remove only if upstream lets pi decide warming for devin models |
| `0004-pi-devin-orphan-tool-calls` | a tool call without a result (after a tree rewind) makes Devin answer `invalid_argument` for the rest of the session | [buYoung/pi-packages#73](https://github.com/buYoung/pi-packages/issues/73) open | `toDevinTranscript()` closes orphaned calls |
| `0005-pi-devin-session-router` | an in-process subagent re-registers `devin` and takes the lead's provider; when it ends, the lead's requests fail "The Devin provider shut down." (shown as "Operation aborted"); children also started with an empty catalog | [buYoung/pi-packages#71](https://github.com/buYoung/pi-packages/issues/71) open | upstream routes by session, or pi scopes native providers per session |
| `0006-pi-devin-parallel-tool-calls` | Claude responses with two or more parallel tool calls fail "Cannot attach a delta without a tool ID…" (keeps upstream's check for frames that start several calls at once) | [buYoung/pi-packages#72](https://github.com/buYoung/pi-packages/issues/72) open | the accumulator attaches id-less deltas to the current call |
| `0008-pi-devin-clamp-max-tokens` | the output limit is never clamped to the context window (always `maxOutputTokens`, 128k on swe-2), so a full context never ends in a `length` stop; a subagent ran ~20 turns at 264k-279k of a 262k window before navigate_tree caught it at 106.7% (2026-11-09) | [buYoung/pi-packages#74](https://github.com/buYoung/pi-packages/issues/74) open (fix + test on local branch `fix/pi-devin-clamp-max-tokens`, 251/251) | `prepareRequest` calls `clampMaxTokensToContext` |

## Adding a patch

1. Copy an existing `.patch.sh` into the folder of its target (`pi/`, or a folder named after the extension) and give it the next global number.
2. Fill in the metadata; keep `PATCHED_RE` narrow enough to be unique in the target files.
3. `./apply.sh --dry-run`, then `./apply.sh`, then run it twice to prove idempotency.
4. Verify the effect in a fresh pi session, not just the syntax check.
5. Delete the file once upstream ships the fix — the runner is a no-op for absent targets, so
   leaving a stale patch is only noise, but it is noise.

Note: `agent/bin`, `agent/install` and `agent/npm` are gitignored in this repo, so the
patched code itself is never committed — only these scripts are.
