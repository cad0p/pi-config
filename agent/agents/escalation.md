---
display_name: Escalation Agent
description: "Very smart and expensive — do not pick first. Use after general-purpose has demonstrated poor performance on the task, verified by facts. Only exception: design work and orchestration."
tools: "*"
prompt_mode: append
extensions: true
skills: true
# Nested delegation, opt-in per agent. Only this agent gets it: a worker that
# decides to orchestrate is the failure every other agent file exists to avoid.
allowed_subagents: all
# model: opencode-go-2/deepseek-v4.1-flash # account 2: opencode-go quota exhausted 2026-09-17
# thinking: xhigh
---
