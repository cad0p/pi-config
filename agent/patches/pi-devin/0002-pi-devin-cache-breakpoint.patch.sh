#!/bin/sh
# @buyong/pi-devin marks EVERY user/tool message with promptCacheOptions EPHEMERAL in
# wireMessages(). Anthropic honours at most 4 breakpoints and the Devin backend keeps the
# earliest ones, so the cached prefix freezes after ~3 turns and every later turn pays the
# whole tail as uncached input (live session: cacheRead stuck at 24K while input grew
# 159K -> 181K, ~$0.70 of quota per Opus turn instead of ~$0.04).
#
# Fix: compute the index of the last user/tool message and set the breakpoint only there,
# so each request reads the previous prefix and writes one new tail.
# Verified (fresh session, 7 bash turns): uncached input stays at 2 tokens while cacheRead
# grows 1.7K -> 37K (Opus 5.5 low, Haiku 5.5 xhigh).
PATCH_ID="0002-pi-devin-cache-breakpoint"
PATCH_TITLE="pi-devin: one prompt-cache breakpoint on the newest user/tool message"
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/70"
PATCH_REMOVE_WHEN="upstream wireMessages() sets promptCacheOptions on one message only; then delete this file"

# Not a pi release: target the installed npm extension. The package is unpinned, so every
# update reinstalls the upstream file and the session_start hook re-applies this.
PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/core/inference/messages.ts"

UNPATCHED_RE='if \(message\.source === "CHAT_MESSAGE_SOURCE_USER" \|\| message\.source === "CHAT_MESSAGE_SOURCE_TOOL"\) \{'
PATCHED_RE='index === lastInput'

# One substitution covering both the map() header and the condition, so a partial match
# can never leave the file half-patched. "#" delimiters: the replacement has unbalanced braces.
PATCH_PERL='
s#(\n[ \t]*)const wire = messages\.map\(\(message\) => \{(\n[\s\S]*?\n[ \t]*)if \(message\.source === "CHAT_MESSAGE_SOURCE_USER" \|\| message\.source === "CHAT_MESSAGE_SOURCE_TOOL"\) \{#$1// local patch 0002: a single cache breakpoint, on the newest user/tool message.$1const lastInput = messages.findLastIndex((message) => message.source === "CHAT_MESSAGE_SOURCE_USER" || message.source === "CHAT_MESSAGE_SOURCE_TOOL");$1const wire = messages.map((message, index) => {$2if (index === lastInput) {#;
'
