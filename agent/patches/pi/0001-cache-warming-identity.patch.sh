#!/bin/sh
# pi cache warming stops at the first turn_end / agent_before_settle boundary because
# cacheContextIsCurrent() compares messages by object identity, while
# _refreshFinalizedContext() re-projects custom_message / branch_summary / compaction
# entries into fresh objects every time. Effect: with cacheWarming "idle", warming dies
# before the first refresh, so every pause >5 min re-writes the whole prompt prefix.
#
# v3 (current): compare by session entry id when both messages are mapped in
# AgentSession._entryIdsByMessage (filled at message_end and in _refreshFinalizedContext),
# else fall back to role+timestamp.
# - v1 used role+timestamp only. It misses custom messages that trigger a turn: the
#   in-memory message (Date.now()) and its entry (a second, later clock read) differ, so a
#   one-request notification turn killed idle warming (23 misses, ~$22.65, 10-24..11-03).
# - v2 used entry id only. It misses resumed sessions: sdk.ts seeds the agent with
#   buildSessionContext() messages that are unmapped until the first refresh. Those are
#   rebuilt from their entries, so role+timestamp matches them, hence the fallback.
# UNPATCHED_RE matches the upstream, v1 and v2 forms, so older installs are upgraded in place.
PATCH_ID="0001-cache-warming-identity"
PATCH_TITLE="Cache warming: match re-projected messages by entry id, else role+timestamp"
PATCH_UPSTREAM="earendil-works/pi#10956 (open; still present in 1.5.1)"
PATCH_REMOVE_WHEN="upstream cacheContextIsCurrent compares by entry id (with restored messages mapped) or keeps projected objects stable; then delete this file"

# Targets (glob relative to the pi-coding-agent package root). The bundle chunk name
# changes between releases, so match by directory rather than by filename.
PATCH_FILES="dist/core/sdk.js dist/bundle/chunks/*.js"

UNPATCHED_RE='currentMessages\[index\] === message\)|currentMessages\[[a-z0-9]+\]===message\)|current\.timestamp === message\.timestamp; \}\)|current\.timestamp===message\.timestamp\}\)|entryId === session\._entryIdsByMessage\.get\(current\)|entryId===session\._entryIdsByMessage\.get\(current\)'
PATCHED_RE='currentEntryId = ids\?\.get\(current\)|currentEntryId=ids\?\.get\(current\)'

PATCH_PERL='
s{messages\.every\(\(message, index\) => (?:currentMessages\[index\] === message|\{ const current = currentMessages\[index\]; return current === message \|\| \(current\.role === message\.role && current\.timestamp === message\.timestamp\); \}|\{ const current = currentMessages\[index\]; if \(current === message\) return true; const entryId = session\._entryIdsByMessage\?\.get\(message\); return entryId !== undefined && entryId === session\._entryIdsByMessage\.get\(current\); \})\)}{messages.every((message, index) => { const current = currentMessages[index]; if (current === message) return true; const ids = session._entryIdsByMessage, messageEntryId = ids?.get(message), currentEntryId = ids?.get(current); if (messageEntryId !== undefined && currentEntryId !== undefined) return messageEntryId === currentEntryId; return current.role === message.role && current.timestamp === message.timestamp; })};
s{messages\.every\(\(message,(\w+)\)=>(?:currentMessages\[\1\]===message|\{let current=currentMessages\[\1\];return current===message\|\|current\.role===message\.role&&current\.timestamp===message\.timestamp\}|\{let current=currentMessages\[\1\];if\(current===message\)return!0;let entryId=session\._entryIdsByMessage\?\.get\(message\);return entryId!==void 0&&entryId===session\._entryIdsByMessage\.get\(current\)\})\)}{messages.every((message,$1)=>{let current=currentMessages[$1];if(current===message)return!0;let ids=session._entryIdsByMessage,messageEntryId=ids?.get(message),currentEntryId=ids?.get(current);return messageEntryId!==void 0&&currentEntryId!==void 0?messageEntryId===currentEntryId:current.role===message.role&&current.timestamp===message.timestamp})};
'
