# AGENTS.md

## Repo layout

- `agent/settings.json` — pi extension manifest: npm packages, skills, providers, models
- `agent/steering/` — global pi-steering config (`index.ts`, `integration.test.ts`, pnpm workspace, tsconfig)
- `agent/prompts/` — prompt templates (`gm`, `impl`, `orchestrate`, `prr`, `rwd`, `forksync`)
- `agent/npm/` — fleet manifest: pinned `@cad0p/*` extension package versions (pnpm workspace)
- `agent/agents/general-purpose.md`, `agent/models.json`, `agent/mcp.json`, `agent/subagents.json`, `agent/vision.json` — remaining pi settings
- `README.md`, `LICENSE`, `AGENTS.md` — repo docs

## Live-dir convention

This repo IS the user's real `~/.pi/` — there is no build, no copy, no symlink. Every change here is live config. Do not restructure paths that pi reads at runtime, and keep `agent/settings.json` consistent with the actual installed fleet.

## Secrets rule

`.gitignore` is a contract: never `git add` anything matching it. `agent/auth.json`, `agent/models-store.json`, `agent/umans-concurrency.json`, `agent/mcp-cache.json`, `agent/mcp-onboarding.json`, `agent/vision-audit.log`, `agent/sessions/`, `agent/bin/`, `agent/git/`, and all `node_modules/` are private and must never be committed.
