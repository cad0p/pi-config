# pi-config

Personal configuration for the [pi coding agent](https://github.com/earendil-works/pi) — dotfiles-style: your live `~/.pi/` directory IS this checkout.

## What this is

This repo is the actual config directory pi reads on my machines. There are no symlinks and no install step that copies files around — `git clone` this repo to `~/.pi` and pi picks everything up on the next start. Everything here is what I actually run, so expect it to change as my setup evolves.

## What's inside

- `agent/settings.json` — the pi extension manifest: npm packages, enabled skills, providers, models, TUI options
- `agent/steering/` — global [pi-steering](https://github.com/cad0p/pi-steering) config (TypeScript entry + integration tests + pnpm workspace)
- `agent/prompts/` — prompt templates (`gm`, `impl`, `orchestrate`, `prr`, `rwd`, `forksync`)
- `agent/npm/` — the extension fleet manifest: exact pinned versions of every `@cad0p/*` extension package, installed with pnpm
- `agent/agents/general-purpose.md`, `agent/models.json`, `agent/mcp.json`, `agent/subagents.json`, `agent/vision.json` — agent, model, MCP, subagent and vision settings

## Requirements

- pi `0.84.x` (settings reference `lastChangelogVersion: 0.84.2`; the steering workspace peers on `@earendil-works/pi-coding-agent@0.84.1`)
- [pnpm](https://pnpm.io) — the fleet and steering workspaces are pnpm-managed
- Node `>=22.19.0` (the floor pi itself requires)

## Usage on a new machine

```bash
git clone https://github.com/cad0p/pi-config.git ~/.pi
cd ~/.pi/agent/npm && pnpm install
cd ~/.pi/agent/steering && pnpm install
```

Then start pi. Extension packages resolve from `agent/npm/node_modules` per `settings.json`; the steering hooks load from `agent/steering/`.

## Security

Secrets are never committed: `agent/auth.json` (provider OAuth), `agent/models-store.json`, `agent/umans-concurrency.json`, `agent/mcp-cache.json`, `agent/mcp-onboarding.json`, `agent/vision-audit.log`, `agent/sessions/` (private conversations), `agent/bin/` and `agent/git/` are all gitignored. `.gitignore` is the contract — if you fork this, keep that list.

## License

MIT — see [LICENSE](LICENSE).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
