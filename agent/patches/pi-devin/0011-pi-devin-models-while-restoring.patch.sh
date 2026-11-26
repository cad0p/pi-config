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
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/94 (PR #95; present in @buyong/pi-devin 0.1.16)"
PATCH_REMOVE_WHEN="upstream's routing provider never reports an empty list while another attached instance has one, and every attached instance gets its first refresh; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/adapters/pi/session-routing.ts"

UNPATCHED_RE='getModels: \(\) => owner\(\)\.provider\.getModels\(\),'
PATCHED_RE='local patch 0011 v3'

PATCH_PERL=$(cat <<'ROUTING_PERL_EOF'
s#\ninterface RouteTable \{\n  readonly routes: Set<WeakRef<Route>>;\n  attaches: number;\n\}#
type RefreshContext = Parameters<DevinProvider["refreshModels"]>[0];

interface RouteTable {
  readonly routes: Set<WeakRef<Route>>;
  attaches: number;
  /** local patch 0011 v3: the newest refresh inputs Pi gave any instance, with the newest stored list, for the instances it never refreshed. */
  latestRefresh?: Pick<RefreshContext, "credential" | "stored" | "baseUrl">;
}#;
s#(  const oauth = own\.auth\.oauth!;\n)#  // local patch 0011 v2: Pi refreshes only the provider registered last, after an await, so an instance another one replaced
  // before that refresh never gets its first one, and its requests wait for it forever. Such an instance restores its list
  // offline, for itself only, from the newest refresh inputs Pi gave any instance.
  const restoreIfNeverRefreshed = (route: Route) => {
    const latest = table.latestRefresh;
    if (!latest?.stored?.models.length || route.provider.getModels().length > 0) return;
    void route.provider.refreshModels({ ...latest, allowNetwork: false, force: false, signal: new AbortController().signal,
      publish: async (publication) => { publication.update?.(); return true; } }).catch(() => {});
  };
$1#;
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
s#    refreshModels: \(context\) => owner\(\)\.provider\.refreshModels\(context\),\n#    refreshModels: async (context) => {
      // The stored entry is the list before this refresh; a list this refresh persists replaces it.
      const stored = context.stored?.models.length ? context.stored : table.latestRefresh?.stored;
      table.latestRefresh = { credential: context.credential, stored, baseUrl: context.baseUrl };
      const publish: RefreshContext["publish"] = async (publication) => {
        const accepted = await context.publish(publication);
        if (accepted && publication.persist?.models.length) table.latestRefresh = { ...table.latestRefresh, stored: publication.persist };
        return accepted;
      };
      try { await owner().provider.refreshModels({ ...context, publish }); }
      finally { for (const route of sharingRoutes(table, provider)) if (route !== owner()) restoreIfNeverRefreshed(route); }
    },
#;
s#(      Object\.assign\(self, \{ sessionId, registry, isShutDown: false, attachOrder: \+\+table\.attaches \}\);\n)#$1      restoreIfNeverRefreshed(self);
#;
ROUTING_PERL_EOF
)
