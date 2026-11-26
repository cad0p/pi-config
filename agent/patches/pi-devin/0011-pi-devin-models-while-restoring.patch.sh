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
PATCH_ID="0011-pi-devin-models-while-restoring"
PATCH_TITLE="pi-devin: a new instance answers with an attached instance's model list until its own is restored"
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/94 (PR #95; present in @buyong/pi-devin 0.1.16)"
PATCH_REMOVE_WHEN="upstream's routing provider never reports an empty list while another attached instance has one; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/adapters/pi/session-routing.ts"

UNPATCHED_RE='getModels: \(\) => owner\(\)\.provider\.getModels\(\),'
PATCHED_RE='local patch 0011'

PATCH_PERL='
s#    getModels: \(\) => owner\(\)\.provider\.getModels\(\),\n#    // local patch 0011: a new instance has no list until Pi restores it, and Pi checks this list before every call of the
    // model runtime, so the list of another attached instance stands in until then.
    getModels: () => {
      const own = owner().provider.getModels();
      if (own.length > 0) return own;
      for (const route of sharingRoutes(table, provider)) {
        const models = route.provider.getModels();
        if (models.length > 0) return models;
      }
      return own;
    },
#;
'
