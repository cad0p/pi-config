#!/bin/sh
# Every session loads its own pi-devin instance, and the model runtime keeps the newest registration of "devin" for the
# whole process. The routing provider that instance registers answers getModels() from its own catalog, which is empty
# until Pi's offline refresh restores the stored list (about 0.2-0.7 s later). Pi checks that list before every call when
# models.json configures the provider (provider-composer.js composeModelProvider: supportsBaseApi), so any Devin request
# of any session in that window fails with "No API provider registered for api: devin-connect" and fallback moves on.
# The catalog's own wait for the first refresh (catalog/service.ts) is never reached. Seen on every subagent that falls
# back to Devin, and in the lead when a subagent starts (debugging note 2026-11-26-pi-devin-empty-model-list-window).
#
# Fix: while this instance's list is empty, the routing provider answers with the list of another instance attached to
# the same registration (same process, same account). Requests still go to the session's own instance, which waits for
# its first refresh as before. 0009 adds the stored list as the last fallback for an instance with no attached peer.
#
# v2 (2026-11-26): the routing provider also restores, offline and for itself only, an attached instance Pi never refreshed.
# Pi refreshes the provider registered last, after an await (model-runtime refresh: ModelConfig.load first), so when several
# sessions register close together the earlier instances never get their first refresh, and the catalog's wait for it
# ("A refresh Pi superseded ends aborted; the newer one ends the wait") hangs their requests forever. Seen with subagents
# switching to Devin together. The newest refresh inputs (credential, stored entry, baseUrl) are kept in the route table.
#
# v3 (2026-11-26): the stored entry Pi passes is the list before that refresh, so after a session's first catalog fetch it
# was empty and a restore from it ended the wait with no list ("No Devin model list matches the current account and
# endpoint"; caught by the upstream suite). The route table now keeps the newest non-empty list, including the one a
# refresh persists, and an instance is restored only when there is one. Same code as PR #95's second commit.
PATCH_ID="0011-pi-devin-models-while-restoring"
PATCH_TITLE="pi-devin: a new instance lists an attached instance's models until its own are restored, and restores itself if Pi never refreshes it"
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/94 + https://github.com/buYoung/pi-packages/issues/96 (both fixed by PR #95; present in @buyong/pi-devin 0.1.16)"
PATCH_REMOVE_WHEN="upstream's routing provider never reports an empty list while another attached instance has one, and every attached instance gets its first refresh; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/adapters/pi/session-routing.ts"

UNPATCHED_RE='getModels: \(\) => owner\(\)\.provider\.getModels\(\),'
PATCHED_RE='local patch 0011 v3'

PATCH_PERL=$(patch_asset .pl) || return 1
