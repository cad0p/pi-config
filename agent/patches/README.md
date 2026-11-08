# Local pi source patches

Patch files here are re-applied to every installed pi release, and to installed npm extensions that need a local fix. They exist because pi installs
each version into `~/.pi/agent/install/releases/<version>/`, so anything we change under
`node_modules/@earendil-works/pi-coding-agent/dist/` is gone on upgrade. Unpinned extensions under `~/.pi/agent/npm/node_modules/` are reinstalled the same way.

## Layout

- `apply.sh` — the runner. `apply.sh` reconciles, `--status` reports, `--dry-run` previews, `-q` is for startup, `--all` widens the scope (see below).
- `lib.sh` — helpers the runner and patch files share (state probe, backup, syntax check).
- `NNNN-<name>.patch.sh` — one patch per file, with the upstream link and a removal condition.
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

| id | upstream | remove when |
|---|---|---|
| `0001-cache-warming-identity` | [earendil-works/pi#10956](https://github.com/earendil-works/pi/issues/10956) | upstream compares re-projected messages by entry id (main still uses `===` in 1.5.0; v2 compares `_entryIdsByMessage`, since role+timestamp misses one-request turns started by a custom message) |
| `0004-pi-devin-orphan-tool-calls` | buYoung/pi-packages (not filed) | `@buyong/pi-devin` `toDevinTranscript()` closes tool calls that have no result (after a tree rewind) with a synthetic error result, like pi-ai `transformMessages()`. Without it Devin answers `invalid_argument` for the rest of the session |
| `0003-pi-devin-cache-warming` | buYoung/pi-packages (not filed) | `@buyong/pi-devin` stops returning `{ action: "stop" }` from `cache_warming_decision` for every devin model. Opt-in per model lives in `models.json` (`promptCache` + `cost` under `providers.devin.modelOverrides`) |
| `0002-pi-devin-cache-breakpoint` | buYoung/pi-packages (to file) | `@buyong/pi-devin` `wireMessages()` sets `promptCacheOptions` on one message only (0.1.14 marks every user/tool message, freezing the cached prefix after ~3 turns) |

## Adding a patch

1. Copy an existing `.patch.sh` and give it the next number.
2. Fill in the metadata; keep `PATCHED_RE` narrow enough to be unique in the target files.
3. `./apply.sh --dry-run`, then `./apply.sh`, then run it twice to prove idempotency.
4. Verify the effect in a fresh pi session, not just the syntax check.
5. Delete the file once upstream ships the fix — the runner is a no-op for absent targets, so
   leaving a stale patch is only noise, but it is noise.

Note: `agent/bin`, `agent/install` and `agent/npm` are gitignored in this repo, so the
patched code itself is never committed — only these scripts are.
