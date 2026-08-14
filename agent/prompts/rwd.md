---
description: Rewind workflow
argument-hint: "[follow-up-tasks]"
---

ok nice, look at the recent anchors, then propose an anchor to rewind to free up context and collapse the current thread into a summary.

current context is listed at the at the top of the list call: `[list] · Z labels · ctx X% of Y`. Prefer rewinding to less than 20%.

give any context that can help, such as tricks you have learned in this session or anything that you struggled with

after rewinding, rebuild context by reading the code and docs changed in this thread and additional instructions if provided: ${1:-follow up tasks} ${@:2}
