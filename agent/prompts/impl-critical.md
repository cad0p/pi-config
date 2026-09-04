---
description: Autonomous implementation workflow
argument-hint: "[#issue-or-plan.md]"
---

work autonomously on issue/plan $@, multiple parallel reviewer lenses
in isolated worktree (other agents on this machine)

gather all context, when gathered anchor (context-gathered) and write the plan in goldmine and review subagent until good.
when plan good rewind to `context-gathered` and start impl subagent and review subagent until good, list anchors and rewind after every milestone or rabbit hole / dead end, push to draft PR as you go and monitor ci
when done, rewind and update PR description

do not monitor subagents, they notify on completion/failure
