---
description: Autonomous implementation workflow
argument-hint: "[#issue-or-plan.md]"
---

work autonomously on issue/plan $@
in isolated worktree (other agents on this machine)

gather all context and write the plan in kb and review subagent.
when plan good rewind to `context-gathered` and start impl subagent and review subagent, push to draft PR as you go and monitor ci, and perform the verification checklist in repo docs (blocker: stop and ask to create if not found). repeat until good.
when done, rewind and update PR description

do not monitor subagents, they notify on completion/failure
