#!/bin/sh
# @buyong/pi-devin registers one "devin" provider per extension instance, and each instance's
# lifecycle (run state, step index, client) belongs to the one pi session it attached to.
# pi-subagents runs child sessions in the same process and shares the parent's model runtime
# (createAgentSession modelRuntime), so every child that loads pi-devin re-registers "devin"
# and the runtime keeps only the last one (nativeExtensionProviders.set). From then on the
# lead's requests run on a child's instance; once that child ends, its instance is shut down
# and every lead request fails at once with Cancelled "The Devin provider shut down."
# (interactive mode persists it as "Operation aborted"). Reproduced 2026-11-08 with
# pi -p --no-extensions -e pi-devin -e pi-subagents: lead on devin Haiku, one general-purpose
# child, the lead's next request aborted with that message.
#
# Fix: the registered provider routes each request by options.sessionId (pi passes the
# session id on agent turns, compaction and cache warms) to the instance attached to that
# session, through a process-wide map on globalThis. Calls without a session id (models,
# OAuth, catalog) go to this instance until its session shuts down, else to the newest live one.
# An instance that attaches with an empty catalog restores it offline from the newest refresh
# inputs, because pi refreshes only the newest registration and only after an async load. The duplicate
# registration check accepts any pi-devin router instead of only this instance's object.
PATCH_ID="0005-pi-devin-session-router"
PATCH_TITLE="pi-devin: route requests to the instance of their session (in-process subagents)"
PATCH_UPSTREAM="buYoung/pi-packages (not filed; present in @buyong/pi-devin 0.1.14)"
PATCH_REMOVE_WHEN="upstream keeps one provider per process or routes by session, or pi scopes native providers per session; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/adapters/pi/registration.ts"

UNPATCHED_RE='const provider = makeDevinProvider\(runtime\);'
PATCHED_RE='local patch 0005'

PATCH_PERL='
s#const provider = makeDevinProvider\(runtime\);#// local patch 0005: in-process child sessions (pi-subagents) re-register "devin" on the shared model runtime and only the last one stays.
  // The registered provider therefore routes each request to the pi-devin instance attached to its session.
  const own = makeDevinProvider(runtime);
  const ROUTER = Symbol.for("pi-devin.router");
  const routes: Map<string, any> = ((globalThis as any)[Symbol.for("pi-devin.routes")] ??= new Map());
  const shared: { context?: any } = ((globalThis as any)[Symbol.for("pi-devin.shared")] ??= {});
  let ownSessionId: string | undefined;
  // Closed only after session_shutdown: before session_start this instance must still serve its own catalog refresh.
  let ownClosed = false;
  const live = (options?: any): any => (options?.sessionId && routes.get(options.sessionId)) || (!ownClosed ? own : [...routes.values()].at(-1) ?? own);
  const forget = () => { if (ownSessionId !== undefined && routes.get(ownSessionId) === own) routes.delete(ownSessionId); };
  const provider: any = {
    ...own, [ROUTER]: true,
    auth: { ...own.auth, oauth: new Proxy(own.auth.oauth, { get: (_target, key) => Reflect.get(live().auth.oauth, key) }) },
    // A child instance publishes its catalog only after its first refresh, which can land after the first request of the child.
    // Every instance serves the same account, so an empty list falls back to the catalog of another live instance.
    getModels: () => {
      const models = live().getModels();
      if (models.length > 0) return models;
      for (const other of [...routes.values()].reverse()) { const fallback = other.getModels(); if (fallback.length > 0) return fallback; }
      return models;
    },
    filterModels: (models: any, credential: any) => live().filterModels(models, credential),
    // Remembers the newest refresh inputs, so an instance that attaches later can restore the catalog offline (see session_start).
    refreshModels: (context: any) => {
      shared.context = { credential: context.credential, stored: context.stored, baseUrl: context.baseUrl };
      return live().refreshModels({ ...context, publish: async (publication: any) => {
        const accepted = await context.publish(publication);
        if (accepted && publication.persist) shared.context = { ...shared.context, stored: publication.persist };
        return accepted;
      } });
    },
    stream: (model: any, context: any, options: any) => live(options).stream(model, context, options),
    streamSimple: (model: any, context: any, options: any) => live(options).streamSimple(model, context, options),
  };#;
s#if \(context\.modelRegistry\.getRegisteredNativeProvider\("devin"\) !== provider\) \{#if (!(context.modelRegistry.getRegisteredNativeProvider("devin") as any)?.[ROUTER]) {#;
s#(\n(\s*)if \(isLead\) run\(sidekicks\.sessionStarted\()#\n\2forget(); ownSessionId = context.sessionManager.getSessionId(); routes.set(ownSessionId, own); ownClosed = false;
\2// pi refreshes only the newest registration, and only after an async config load, so a child instance can get its first request with an empty catalog.
\2if (own.getModels().length === 0 && shared.context) own.refreshModels({ ...shared.context, allowNetwork: false, signal: new AbortController().signal, publish: async (publication: any) => { publication.update?.(); return true; } }).catch(() => undefined);\1#;
s#(\n(\s*)if \(isLead\) run\(sidekicks\.reset\);)#\n\2ownClosed = true; forget();\1#;
'
