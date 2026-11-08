#!/bin/sh
# @buyong/pi-devin sends tool calls that have no tool result to Devin, which rejects the
# whole request with "invalid_argument: There is an issue with this request, please try a
# different model." pi's built-in providers never send these, because pi-ai's
# transformMessages() adds a synthetic "No result provided" error result for each
# orphaned call. pi-devin builds its own transcript (toDevinTranscript) and skips that step.
#
# When it happens: a navigate_tree rewind (or any /tree branch summary) whose anchor is an
# assistant tool-call message. The call's result stays on the abandoned branch, so every
# later request in the session carries the orphan. Bisected 2026-11-08 on the pc-tenant
# session: good up to line 399, bad from the branch_summary at line 400 (parent = an
# assistant toolUse whose toolResult is on the other branch).
#
# Fix: before returning the transcript, close each assistant's unanswered tool calls with a
# synthetic error tool result, like pi-ai does.
PATCH_ID="0004-pi-devin-orphan-tool-calls"
PATCH_TITLE="pi-devin: synthetic error results for orphaned tool calls (rewound sessions)"
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/73"
PATCH_REMOVE_WHEN="upstream toDevinTranscript closes orphaned tool calls; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/adapters/pi/transcript.ts"

UNPATCHED_RE='return \{ messages, tools, systemPrompt: getCurrentSystemPrompt\(context\.messages\) \};'
PATCHED_RE='local patch 0004'

PATCH_PERL='
s#return \{ messages, tools, systemPrompt: getCurrentSystemPrompt\(context\.messages\) \};#// local patch 0004: close tool calls that have no result (e.g. after a tree rewind), like pi-ai transformMessages().
    const closed: ChatMessage[] = [];
    let open: string[] = [];
    const closeOpen = () => {
      for (const id of open) closed.push({ messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_TOOL", prompt: "No result provided", toolCallId: id, toolResultIsError: true });
      open = [];
    };
    for (const message of messages) {
      if (message.source === "CHAT_MESSAGE_SOURCE_TOOL" && message.toolCallId !== undefined) open = open.filter((id) => id !== message.toolCallId);
      else closeOpen();
      closed.push(message);
      if (message.source === "CHAT_MESSAGE_SOURCE_SYSTEM") open = (message.toolCalls ?? []).map((call) => call.id);
    }
    closeOpen();
    return { messages: closed, tools, systemPrompt: getCurrentSystemPrompt(context.messages) };#;
'
