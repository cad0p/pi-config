#!/bin/sh
# pi cache warming stops at the first turn_end / agent_before_settle boundary because
# cacheContextIsCurrent() compares messages by object identity, while
# _refreshFinalizedContext() re-projects custom_message / branch_summary / compaction
# entries into fresh objects every time. Effect: with cacheWarming "idle", warming dies
# before the first refresh, so every pause >5 min re-writes the whole prompt prefix.
PATCH_ID="0001-cache-warming-identity"
PATCH_TITLE="Cache warming: match re-projected messages by role+timestamp"
PATCH_UPSTREAM="earendil-works/pi#10956 (open; still present in 1.4.0; PR #11047 auto-closed)"
PATCH_REMOVE_WHEN="upstream main compares by entry id or role+timestamp; then delete this file"

# Targets (glob relative to the pi-coding-agent package root). The bundle chunk name
# changes between releases, so match by directory rather than by filename.
PATCH_FILES="dist/core/sdk.js dist/bundle/chunks/*.js"

UNPATCHED_RE='currentMessages\[index\] === message|currentMessages\[index3\]===message'
PATCHED_RE='current\.timestamp === message\.timestamp|current\.timestamp===message\.timestamp'

PATCH_PERL='
s{messages\.every\(\(message, index\) => currentMessages\[index\] === message\)}{messages.every((message, index) => { const current = currentMessages[index]; return current === message || (current.role === message.role && current.timestamp === message.timestamp); })};
s{messages\.every\(\(message,index3\)=>currentMessages\[index3\]===message\)}{messages.every((message,index3)=>{let current=currentMessages[index3];return current===message||current.role===message.role&&current.timestamp===message.timestamp})};
'
