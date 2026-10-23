# Local pi source patches

Patch files here are re-applied to every installed pi release. They exist because pi installs
each version into `~/.pi/agent/install/releases/<version>/`, so anything we change under
`node_modules/@earendil-works/pi-coding-agent/dist/` is gone on upgrade.

## Layout

- `apply.sh` — the runner. `apply.sh` reconciles, `--status` reports, `--dry-run` previews, `-q` is for startup, `--all` widens the scope (see below).
- `lib.sh` — helpers the runner and patch files share (state probe, backup, syntax check).
- `NNNN-<name>.patch.sh` — one patch per file, with the upstream link and a removal condition.
- `local-patches/` — a local pi package whose extension runs `apply.sh -q` at `session_start`
  and registers `/patches`.

## Scope

By default the runner only touches the **active release** — the one `install/current-version` points at, i.e. the code pi will actually run. Old releases left on disk are not modified: patching them would only change code that cannot execute, and if you ever roll back by editing `current-version`, that release becomes active and the next session patches it then.

`--all` reconciles every installed release. Use it to audit, or to pre-patch a rollback target before switching to it.

## How it works

Each patch declares:

| variable | meaning |
|---|---|
| `PATCH_FILES` | globs relative to the pi-coding-agent package root (chunk names change per release, so target directories) |
| `UNPATCHED_RE` / `PATCHED_RE` | how to tell the upstream form from the patched form (idempotency) |
| `PATCH_PERL` | the `perl -0 -p` substitution program |
| `PATCH_UPSTREAM` / `PATCH_REMOVE_WHEN` | which upstream issue this works around, and when to delete the file |

The runner backs up each file it touches to `<file>.orig`, syntax-checks with `node --check`,
and restores the backup if the check fails. A patch whose target code is absent (upstream fixed
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
| `0001-cache-warming-identity` | [earendil-works/pi#10956](https://github.com/earendil-works/pi/issues/10956) | upstream compares re-projected messages by entry id or role+timestamp (main still uses `===` in 1.4.0) |

## Adding a patch

1. Copy an existing `.patch.sh` and give it the next number.
2. Fill in the metadata; keep `PATCHED_RE` narrow enough to be unique in the target files.
3. `./apply.sh --dry-run`, then `./apply.sh`, then run it twice to prove idempotency.
4. Verify the effect in a fresh pi session, not just the syntax check.
5. Delete the file once upstream ships the fix — the runner is a no-op for absent targets, so
   leaving a stale patch is only noise, but it is noise.

Note: `agent/bin`, `agent/install` and `agent/npm` are gitignored in this repo, so the
patched code itself is never committed — only these scripts are.
