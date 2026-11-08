#!/bin/sh
# @buyong/pi-devin rejects a whole response when Devin streams an argument delta without a
# tool id after more than one call has started: "Cannot attach a delta without a tool ID to
# a specific call." (src/core/inference/accumulator.ts acceptToolDeltas). Devin sends the id
# only on the first delta of each call and streams the calls one after another, so any
# response with two or more parallel tool calls fails. Reproduced 2026-11-08 on devin
# claude-haiku-5-5 (two Agent calls in one message, and two bash calls in one message).
#
# Fix: an id-less single delta continues the call that most recently had an id, as it already
# does when there is only one call. A batch of several id-less deltas still fails.
PATCH_ID="0006-pi-devin-parallel-tool-calls"
PATCH_TITLE="pi-devin: accept id-less argument deltas for parallel tool calls"
PATCH_UPSTREAM="buYoung/pi-packages (not filed; present in @buyong/pi-devin 0.1.14)"
PATCH_REMOVE_WHEN="upstream accumulator attaches id-less deltas to the current call with several calls open; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/core/inference/accumulator.ts"

UNPATCHED_RE='if \(deltas\.length !== 1 \|\| !self\.currentCall \|\| self\.calls\.size > 1\) \{'
PATCHED_RE='local patch 0006'

PATCH_PERL='
s#if \(deltas\.length !== 1 \|\| !self\.currentCall \|\| self\.calls\.size > 1\) \{#// local patch 0006: Devin sends the id only on the first delta of each call, and the calls stream one after another.
          if (deltas.length !== 1 || !self.currentCall) {#;
'
