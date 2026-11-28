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
