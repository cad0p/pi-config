---
description: Read Goldmine plan + pi-shipit methodology in full, build architecture context, then run the orchestrator role per methodology
argument-hint: "[goldmine-project-subdir]"
---

read all the plan in goldmine, the pishipit methodology in full, the current commit status,
build full context of architecture, then start the orchestration following methodology
meticulously.

## Resolved locations (do not re-discover — read these directly)

- **Goldmine vault root:** `<workspace>/personal/github/cad0p/Goldmine`
- **pi-shipit methodology (read in FULL, every section):** `<vault>/open-source/github/pi-shipit/methodology.md`
- **pi-shipit decisions:** `<vault>/open-source/github/pi-shipit/decisions/`

## Project plan/status dir in Goldmine

The current repo's Goldmine plan dir mirrors the repo. If an argument was passed (`$1`), use it
as the project subdir. Otherwise locate it by matching the current repo name under the vault —
check, in order:

1. `<vault>/personal/github/cad0p/<repo-name>/`
2. `<vault>/open-source/github/<owner>/<repo-name>/`

Read **all** plan/status docs found there, including but not limited to:
`design.md`, `deferred.md`, `status.md`, any `research/*.md`, `reviews/**/*.md`,
`daily/*.md`, and every `prs/<pr-dir>/{design,deferred,status}.md` plus its review rounds.
Read the most recent first, then sweep the rest. Do not skip deferred.md.

## Current commit status

From the repo working directory, capture: `git status`, `git log --oneline -20`,
current branch, and `git log -1 --format='%H %s'` for each scope item the methodology
expects one commit per. Note any uncommitted/unpushed state before orchestrating.

## Architecture context

Read the repo's README, invariants, package.json/manifest, entrypoint, and the modules touched by the current plan's scope items.
Build a mental model of: data flow, public surface, test layout, and where the next scope item lands. Cross-reference with the plan's `design.md`.

## Then: start the orchestration

Open the methodology and assume the **"Orchestrator role"** (and "Feature-implementation
kickoff (step 1 prep)" when starting a new scope item). Follow the three phases and the
five-step loop **meticulously and in order** — do not skip the pre-spawn leak-check, the
severity ladder, the never-deferrable categories, or the triage (fix-now / defer / decline)
rules. Re-read any methodology section before deviating from it.

If context is compacted mid-run: re-read the Goldmine plan/status docs and the full methodology again before resuming.
