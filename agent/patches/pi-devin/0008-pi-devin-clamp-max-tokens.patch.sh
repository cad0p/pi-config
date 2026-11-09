#!/bin/sh
# @buyong/pi-devin never clamps the output limit to the context window. pi-ai's built-in
# adapters call clampMaxTokensToContext() (contextWindow - estimated input - 4096, at least 1),
# so a full context squeezes the reply into a "length" stop that pi and navigate_tree treat as
# an overflow and recover from. pi-devin sends requestOptions.maxTokens ?? maxOutputTokens
# (128k on swe-2) whatever the context size (src/pi/features/inference/request.ts).
#
# Seen 2026-11-08/09 (pc-tenant subagent "build merge queue Q3", devin/swe-2, 262k window):
# about 20 turns went out with 264k-279k of input, all toolUse replies, so no overflow check
# fired; navigate_tree only caught it at the first plain "stop" reply (106.7%) and withheld 86
# tool results at once.
#
# Fix: clamp the output limit like the built-in adapters, against the pi model's window
# (models.json overrides included).
PATCH_ID="0008-pi-devin-clamp-max-tokens"
PATCH_TITLE="pi-devin: clamp the output limit to the context window like pi-ai's adapters"
PATCH_UPSTREAM="(not filed yet)"
PATCH_REMOVE_WHEN="upstream prepareRequest clamps maxTokens with clampMaxTokensToContext; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/features/inference/request.ts"

UNPATCHED_RE='const maximum = requestOptions\.maxTokens === undefined \? selected\.model\.maxOutputTokens : yield\* tokenCount\(requestOptions\.maxTokens, "maxTokens"\);'
PATCHED_RE='local patch 0008'

# One substitution per site; the import is anchored on the first pi-ai import line.
PATCH_PERL='
s#^(import \{ clampThinkingLevel, [^\n]*\} from "\@earendil-works/pi-ai";)#$1\nimport { clampMaxTokensToContext } from "\@earendil-works/pi-ai/api/simple-options"; // local patch 0008#m;
s#(\n([ \t]*))const maximum = requestOptions\.maxTokens === undefined \? selected\.model\.maxOutputTokens : yield\* tokenCount\(requestOptions\.maxTokens, "maxTokens"\);#$1const requested = requestOptions.maxTokens === undefined ? selected.model.maxOutputTokens : yield* tokenCount(requestOptions.maxTokens, "maxTokens");$1// local patch 0008: leave room for the input, like pi-ai adapters (contextWindow - estimated input - 4096, at least 1).$1const maximum = clampMaxTokensToContext(model, context, requested);#;
'
