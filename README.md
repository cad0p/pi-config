# pi-config

Personal configuration for the PierPi [pi coding agent](https://github.com/earendil-works/pi): my `~/.pi/`.

## What this is

This repo is the actual config directory pi reads on my machines. `git clone` this repo to `~/.pi` and pi picks everything up on the next start. Everything here is what I actually run, so expect it to change as my setup evolves.

## What's inside

- `agent/settings.json` — the pi settings: my extensions, skills, and pi configs
- `agent/steering/` — global [pi-steering](https://github.com/cad0p/pi-steering) TS config with tests
- `agent/prompts/` — prompt templates (slash commands that prefill a parameterized prompt)
- `agent/npm/` — where extensions live and where supply-chain policies on `minReleaseAge` are defined, installed with pnpm. Notable examples:
  - [pi-napkin](https://github.com/cad0p/pi-napkin) — a human/agent shared, always updated Obsidian vault, knowledge base you control and can read
  - [pi-tree-navigator](https://github.com/cad0p/pi-tree-navigator) — giving the agent access to pi's tree session structure, so work gets collapsed in summaries and the context window feels infinite
  - [pi-timestamps](https://github.com/cad0p/pi-timestamps) — see when you and the agent communicated, so the session doesn't feel like time doesn't exist (agent doesn't see them)
  - [pi-steering](https://github.com/cad0p/pi-steering) — instead of polluting your AGENTS.md, deterministic rules on bash tool usage, so the AGENT only sees the steering instruction when it was about to make a mistake
  - [pi-heartbeat](https://github.com/cad0p/pi-heartbeat) — timers for agents, so they can monitor CI or other events for long-running tasks
- `agent/agents/` — my subagent types
- `agent/subagents.json` — my subagent extension [pi-subagents-tintinweb](https://github.com/cad0p/pi-subagents-tintinweb) settings
- `agent/models.json` — the custom models I imported
- `agent/mcp.json` — my MCP extensions (parallel search)
- `agent/vision.json` — my model vision handoff settings

## Requirements

- [pi](https://pi.dev) — `pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent`)
- [pnpm](https://pnpm.io) — pi and steering workspaces are pnpm-managed
- [Node](https://nodejs.org/) `>=22.19.0` (the floor pi itself requires)

## Usage on a new machine

Assuming all prerequisites are installed:

```bash
cp -r ~/.pi ~/.pi.bak # backup your pi config
git clone https://github.com/cad0p/pi-config.git ~/.pi # replace your pi config
pi update --all # install PierPi config
pi /login # authenticate to a model provider
cd ~/.pi && pi "let's explore what my pi config can do, and what I can set up"
```

## Security

Secrets are never committed: `agent/auth.json` (provider OAuth), `agent/models-store.json`, `agent/umans-concurrency.json`, `agent/mcp-cache.json`, `agent/mcp-onboarding.json`, `agent/vision-audit.log`, `agent/sessions/` (private conversations), `agent/bin/` and `agent/git/` are all gitignored. `.gitignore` is the contract — if you fork this, keep that list.

## License

MIT — see [LICENSE](LICENSE).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
