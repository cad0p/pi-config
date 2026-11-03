#!/bin/sh
# pi cache warming stops at the first turn_end / agent_before_settle boundary because
# cacheContextIsCurrent() compares messages by object identity, while
# _refreshFinalizedContext() re-projects custom_message / branch_summary / compaction
# entries into fresh objects every time. Effect: with cacheWarming "idle", warming dies
# before the first refresh, so every pause >5 min re-writes the whole prompt prefix.
#
# Fix: compare by session entry id. AgentSession already maps both the original in-memory
# message (at message_end) and every re-projected copy (in _refreshFinalizedContext) to the
# source entry id in _entryIdsByMessage, so identity-or-same-entry is exact for every
# message type. Unpersisted messages have no id and fall back to identity.
#
# v1 of this patch matched role+timestamp (ianks's fallback). That misses custom messages
# that trigger a turn: sendCustomMessage stamps the in-memory message with Date.now(), and
# appendCustomMessageEntry stamps the entry with a second, later clock read, so the
# re-projected copy has a different timestamp. Any timer/notification turn that ends after
# one request killed idle warming (23 misses, ~$22.65 from 2026-10-24 to 2026-11-03).
# UNPATCHED_RE matches the v1 form too, so v1 installs are upgraded in place.
PATCH_ID="0001-cache-warming-identity"
PATCH_TITLE="Cache warming: match re-projected messages by session entry id"
PATCH_UPSTREAM="earendil-works/pi#10956 (open; still present in 1.5.0)"
PATCH_REMOVE_WHEN="upstream cacheContextIsCurrent compares by entry id or keeps projected objects stable; then delete this file"

# Targets (glob relative to the pi-coding-agent package root). The bundle chunk name
# changes between releases, so match by directory rather than by filename.
PATCH_FILES="dist/core/sdk.js dist/bundle/chunks/*.js"

UNPATCHED_RE='currentMessages\[index\] === message\)|currentMessages\[[a-z0-9]+\]===message\)|current\.timestamp === message\.timestamp|current\.timestamp===message\.timestamp'
PATCHED_RE='_entryIdsByMessage\?\.get\(message\)'

PATCH_PERL='
s{messages\.every\(\(message, index\) => (?:currentMessages\[index\] === message|\{ const current = currentMessages\[index\]; return current === message \|\| \(current\.role === message\.role && current\.timestamp === message\.timestamp\); \})\)}{messages.every((message, index) => { const current = currentMessages[index]; if (current === message) return true; const entryId = session._entryIdsByMessage?.get(message); return entryId !== undefined && entryId === session._entryIdsByMessage.get(current); })};
s{messages\.every\(\(message,(\w+)\)=>(?:currentMessages\[\1\]===message|\{let current=currentMessages\[\1\];return current===message\|\|current\.role===message\.role&&current\.timestamp===message\.timestamp\})\)}{messages.every((message,$1)=>{let current=currentMessages[$1];if(current===message)return!0;let entryId=session._entryIdsByMessage?.get(message);return entryId!==void 0&&entryId===session._entryIdsByMessage.get(current)})};
'
