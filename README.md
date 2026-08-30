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
  - [pi-fallback-provider](https://github.com/cad0p/pi-fallback-provider) — automatic fallback to another model in `/scoped-models` when the agent stops working because of provider issues
- `agent/agents/` — my subagent types
- `agent/subagents.json` — my subagent extension [pi-subagents-tintinweb](https://github.com/cad0p/pi-subagents-tintinweb) settings
- `agent/models.json` — the custom models I imported
- `agent/mcp.json` — my MCP extensions (parallel search)
- `agent/vision.json` — my model vision handoff settings

## Requirements

- [mise](https://mise.jdx.dev/) for tooling version management
- [Node](https://nodejs.org/) `>=22.19.0` (the floor pi itself requires): `mise use -g node@lts`
- [pnpm](https://pnpm.io) — pi and steering workspaces are pnpm-managed: `mise use -g pnpm@11`
- [pi](https://pi.dev): `pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent`)

## Usage on a new machine

Assuming all prerequisites are installed:

```bash
mkdir ~/.pi # if you've never used pi
cp -r ~/.pi ~/.pi.bak # backup your pi config
git clone https://github.com/cad0p/pi-config.git ~/.pi # replace your pi config
pi update --all # install PierPi config
```

Run pi to log in with your model provider

```bash
pi 
/login # authenticate to a model provider
```

Current recommendation: 
- Provider: [OpenCode Go](https://opencode.ai/go?ref=BMABGJ1Q7N) (10$/month)
- Model: deepseek-v4-flash
- Thinking: max


```bash
cd ~/.pi && pi "let's explore what my pi config can do, and what I can set up"
```

## Folder structure recommendation

Choose a name for your napkin vault `<vault>`, then make a folder at `~/personal/github/<vault>` and `napkin init` there.
Make sure to upload it as private repository. You can use Obsidian to open it and start using it as a note-taking app.

Then, continue using `~/personal/github/<repo>` for private repositories and `~/open-source/github/<repo>` for public ones.
The vault will have the same structure internally: `~/personal/github/<vault>/open-source/github/<repo>` for example.

## Terminal choice recommendation

- macOS/Linux: [Ghostty](https://ghostty.org/)
- Windows: Windows Subsystem for Linux + [GhostInTheWSL](https://github.com/Codavo/ghostinthewsl)
- iOS: [VVTerm](https://github.com/cad0p/vvterm)

## Web UI recommendation

- [@cad0p/pi-web-agegr](https://github.com/cad0p/pi-web-agegr): `pnpm -g install @cad0p/pi-web-agegr`, then `pi-web`

## Security

Secrets are never committed: `agent/auth.json` (provider OAuth), `agent/models-store.json`, `agent/umans-concurrency.json`, `agent/mcp-cache.json`, `agent/mcp-onboarding.json`, `agent/vision-audit.log`, `agent/sessions/` (private conversations), `agent/bin/` and `agent/git/` are all gitignored. `.gitignore` is the contract — if you fork this, keep that list.

## License

MIT — see [LICENSE](LICENSE).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
