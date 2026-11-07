---
display_name: Agent
description: "General-purpose agent for delegating research and execution of multi-step tasks."
tools: "*"
prompt_mode: append
extensions: true
skills: true
allowed_subagents: all
model: opencode-go/deepseek-v4.1-flash
scoped_models: 
  - opencode-go*/deepseek-v4.1-flash:max
  - mistral*/deepseek-v4-1-flash-1017:max
  - openai-codex*/gpt-6-luna:max
  - devin*/swe-2:high
  # - anthropic*/claude-sonnet-5-5:medium
---
