#!/bin/sh
# @buyong/pi-devin rejects a whole response when Devin streams an argument delta without a
# tool id after more than one call has started: "Cannot attach a delta without a tool ID to
# a specific call." (src/core/inference/accumulator.ts acceptToolDeltas). Devin sends the id
# only on the first delta of each call and streams the calls one after another, so any
# response with two or more parallel tool calls fails. Reproduced 2026-11-08 on devin
# claude-haiku-5-5 (two Agent calls in one message, and two bash calls in one message).
#
# Wire shape (captured 2026-11-08, Haiku, two parallel bash calls): every frame carries one
# delta; the id and name come alone, then id-less argument deltas for that call, then the next
# id. Fix: an id-less single delta continues the current call unless the frame that started it
# introduced several calls at once (still ambiguous, as tests/protocol.test.ts expects).
PATCH_ID="0006-pi-devin-parallel-tool-calls"
PATCH_TITLE="pi-devin: accept id-less argument deltas for parallel tool calls"
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/72"
PATCH_REMOVE_WHEN="upstream accumulator attaches id-less deltas to the current call with several calls open; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/core/inference/accumulator.ts"

UNPATCHED_RE='if \(deltas\.length !== 1 \|\| !self\.currentCall \|\| self\.calls\.size > 1\) \{'
PATCHED_RE='local patch 0006'

PATCH_PERL='
s#(\n(\s*)private currentCall\?: ToolCall;)#$1\n$2/** local patch 0006: the frame that started the current call started several calls, so an id-less delta is ambiguous. */\n$2private currentCallShared = false;#;
s#(\n(\s*)self\.currentCall = call;)#$1\n$2self.currentCallShared = deltas.length > 1;#;
s#if \(deltas\.length !== 1 \|\| !self\.currentCall \|\| self\.calls\.size > 1\) \{#if (deltas.length !== 1 || !self.currentCall || self.currentCallShared) {#;
'
