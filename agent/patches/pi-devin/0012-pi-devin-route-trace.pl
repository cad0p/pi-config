# --- session-routing.ts ---
s#\n(const ROUTES_KEY = Symbol\.for\("\@buyong/pi-devin/session-routes/v1"\);)#\nimport { appendFileSync as devinTraceAppend, mkdirSync as devinTraceMkdir } from "node:fs";
import { homedir as devinTraceHome } from "node:os";
// local patch 0012 (trace): one JSON line per routing or cancellation decision, to find the request that lands on another
// session's run. Off with PI_DEVIN_ROUTE_TRACE=0. Writes ~/.pi/agent/pi-devin/route-trace.jsonl; never throws.
const devinTrace = (event: string, data: Record<string, unknown>): void => {
  if (process.env.PI_DEVIN_ROUTE_TRACE === "0") return;
  try {
    const dir = devinTraceHome() + "/.pi/agent/pi-devin";
    devinTraceMkdir(dir, { recursive: true });
    devinTraceAppend(dir + "/route-trace.jsonl", JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + "\\n");
  } catch { /* tracing never breaks a request */ }
};
const devinTraceSid = (read: (() => string) | undefined): string | undefined => { try { return read?.(); } catch { return "<throws>"; } };
$1#;
s#    if \(attached\) return attached;\n    // Pi gives compaction and branch summary requests a new session ID; their session's instance is then in that phase\.\n    const auxiliary = sharing\.filter\(\(route\) => route\.isAuxiliary\(\)\);\n    return auxiliary\.length === 1 \? auxiliary\[0\] : owner\(\);\n#    // Pi gives compaction and branch summary requests a new session ID; their session's instance is then in that phase.
    const auxiliary = attached ? [] : sharing.filter((route) => route.isAuxiliary());
    const chosen = attached ?? (auxiliary.length === 1 ? auxiliary[0] : owner());
    // local patch 0012 (trace)
    const routes: Array<Record<string, unknown>> = [];
    for (const reference of table.routes) {
      const route = reference.deref();
      if (!route) { routes.push({ collected: true }); continue; }
      let shares: unknown;
      try { shares = route.registry?.getRegisteredNativeProvider(PROVIDER_ID) === provider; } catch { shares = "<throws>"; }
      routes.push({ sid: devinTraceSid(route.sessionId), shut: route.isShutDown, order: route.attachOrder, aux: route.isAuxiliary(), shares, self: route === self });
    }
    devinTrace("route.stream", { requested: sessionId, chosen: devinTraceSid(chosen.sessionId), reason: attached ? "attached" : auxiliary.length === 1 ? "auxiliary" : "owner",
      registeredBy: devinTraceSid(self.sessionId), registeredByShut: self.isShutDown, routes });
    return chosen;
#;
s#(      Object\.assign\(self, \{ sessionId, registry, isShutDown: false, attachOrder: \+\+table\.attaches \}\);\n)#$1      devinTrace("route.attach", { sid: devinTraceSid(sessionId), order: self.attachOrder });\n#;
s#    detach: \(\) => \{ self\.isShutDown = true; \},#    detach: () => { devinTrace("route.detach", { sid: devinTraceSid(self.sessionId), order: self.attachOrder }); self.isShutDown = true; },#;
# --- lifecycle.ts ---
s#\n(const cancelled = \(\) => new Cancelled\(\{ message: "The previous Devin run ended\." \}\);)#\nimport { appendFileSync as devinTraceAppend, mkdirSync as devinTraceMkdir } from "node:fs";
import { homedir as devinTraceHome } from "node:os";
// local patch 0012 (trace): one JSON line per routing or cancellation decision, to find the request that lands on another
// session's run. Off with PI_DEVIN_ROUTE_TRACE=0. Writes ~/.pi/agent/pi-devin/route-trace.jsonl; never throws.
const devinTrace = (event: string, data: Record<string, unknown>): void => {
  if (process.env.PI_DEVIN_ROUTE_TRACE === "0") return;
  try {
    const dir = devinTraceHome() + "/.pi/agent/pi-devin";
    devinTraceMkdir(dir, { recursive: true });
    devinTraceAppend(dir + "/route-trace.jsonl", JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + "\\n");
  } catch { /* tracing never breaks a request */ }
};
const devinTraceSid = (read: (() => string) | undefined): string | undefined => { try { return read?.(); } catch { return "<throws>"; } };
$1#;
s#(      yield\* this\.abort\(cancelled\(\))(\);\n      this\.binding = binding;)#$1, "attach"$2#;
s#(      yield\* this\.abort\(cancelled\(\))(\);\n      if \(execution\.hasCheckpoint\))#$1, "finish"$2#;
s#(      yield\* this\.abort\(cancelled\(\))(\);\n      this\.state = yield\* restoreState\(this\.binding\);)#$1, "treeChanged"$2#;
s#(return Effect\.andThen\(this\.abort\(cancelled\(\))(\), Effect\.sync\(\(\) => \{ this\.isClosed = true; \}\)\);)#$1, "shutdown"$2#;
s#  abort\(reason: DevinFailure\): Effect\.Effect<void> \{\n    return Effect\.suspend\(\(\) => \{\n      const active = this\.execution;\n      if \(!active\) return Effect\.void;\n#  abort(reason: DevinFailure, where = "external"): Effect.Effect<void> {
    return Effect.suspend(() => {
      const active = this.execution;
      // local patch 0012 (trace)
      devinTrace("lifecycle.abort", { where, sid: devinTraceSid(this.binding?.getSessionId), stateSid: this.state.sessionId, exec: active?.data.id,
        kind: active?.data.kind, settled: active?.data.settled, activeRequests: active?.activeRequests, reason: (reason as { message?: string }).message ?? String(reason) });
      if (!active) return Effect.void;
#;
s#(else if \(kind === "agent" && \["manual", "tree", "direct"\]\.includes\(current\.data\.kind\) && current\.activeRequests === 0\) )yield\* this\.finish;#$1\{ devinTrace("lifecycle.begin-finishes-prior", { sid: devinTraceSid(this.binding?.getSessionId), prior: current.data.kind, exec: current.data.id }); yield* this.finish; \}#;
s#(      if \(this\.binding && this\.binding\.getSessionId\(\) !== this\.state\.sessionId\) )return Effect\.fail\(cancelled\(\)\);#$1\{ devinTrace("lifecycle.checkpoint-stale", { sid: devinTraceSid(this.binding.getSessionId), stateSid: this.state.sessionId }); return Effect.fail(cancelled()); \}#;
s#        if \(reason\) return Effect\.fail\(reason\);\n        if \(this\.execution !== active \|\| this\.state !== state \|\| this\.isClosed \|\| \(this\.binding && this\.binding\.getSessionId\(\) !== state\.sessionId\)\) return Effect\.fail\(cancelled\(\)\);#        // local patch 0012 (trace)
        if (reason) { devinTrace("lifecycle.assert-cancelled", { sid: devinTraceSid(this.binding?.getSessionId), stateSid: state.sessionId, exec: active.data.id, reason: (reason as { message?: string }).message }); return Effect.fail(reason); }
        if (this.execution !== active || this.state !== state || this.isClosed || (this.binding && this.binding.getSessionId() !== state.sessionId)) {
          devinTrace("lifecycle.assert-stale", { sid: devinTraceSid(this.binding?.getSessionId), stateSid: state.sessionId, exec: active.data.id,
            executionReplaced: this.execution !== active, stateReplaced: this.state !== state, isClosed: this.isClosed });
          return Effect.fail(cancelled());
        }#;
s#(      if \(!this\.execution\) yield\* this\.begin\("direct"\);\n      const active = this\.execution!, state = this\.state;\n)#$1      devinTrace("lifecycle.acquire", { sid: devinTraceSid(this.binding?.getSessionId), stateSid: state.sessionId, exec: active.data.id, kind: active.data.kind, activeRequests: active.activeRequests });\n#;
# --- index.ts (0009 lazy entry point) ---
s#\n(/\*\* Runs process-wide loads one after another, whichever copy of this module asks\. \*/)#\nimport { appendFileSync as devinTraceAppend, mkdirSync as devinTraceMkdir } from "node:fs";
import { homedir as devinTraceHome } from "node:os";
// local patch 0012 (trace): which call loads an instance and whether the session attaches. Same file as the routing trace.
const devinTrace = (event: string, data: Record<string, unknown>): void => {
  if (process.env.PI_DEVIN_ROUTE_TRACE === "0") return;
  try {
    const dir = devinTraceHome() + "/.pi/agent/pi-devin";
    devinTraceMkdir(dir, { recursive: true });
    devinTraceAppend(dir + "/route-trace.jsonl", JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + "\\n");
  } catch { /* tracing never breaks a request */ }
};
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("\@buyong/pi-devin/local-patch-0012/trace")] = devinTrace;
const devinTraceStack = (): string[] => (new Error().stack ?? "").split("\\n").slice(2, 12).map((line) => line.trim());
const devinTraceCtxSid = (context: unknown): string | undefined => { try { return (context as ExtensionContext | undefined)?.sessionManager.getSessionId(); } catch { return "<throws>"; } };

$1#;
s#(  const disposers: \(\(\) => void\)\[\] = \[\];\n)#$1  // local patch 0012 (trace)
  const devinTraceInst = Math.random().toString(36).slice(2, 8);
  let devinTraceStubSid: string | undefined;
#;
s#(  const ensureLoaded = \(\): Promise<LoadedExtension> => \{\n)#$1    if (!loading) devinTrace("stub.load", { inst: devinTraceInst, sid: devinTraceStubSid, stack: devinTraceStack() });
#;
s#(      for \(const dispose of disposers\.splice\(0\)\) dispose\(\);\n)#      devinTrace("stub.handover", { inst: devinTraceInst, sid: devinTraceStubSid, disposers: disposers.length });
$1#;
s#    ensureLoaded\(\)\.then\(\(extension\) => extension\.startSession\?\.\(undefined, context as ExtensionContext\)\)\.catch\(\(\) => \{\}\);#    ensureLoaded().then((extension) => {
      devinTrace("stub.attach", { inst: devinTraceInst, sid: devinTraceCtxSid(context), hasStartSession: Boolean(extension.startSession) });
      return extension.startSession?.(undefined, context as ExtensionContext);
    }).catch((error: unknown) => { devinTrace("stub.attach-failed", { inst: devinTraceInst, sid: devinTraceCtxSid(context), error: String(error) }); });#;
s#(  on\("session_start", \(_event, context\) => \{\n)#$1    devinTraceStubSid = devinTraceCtxSid(context);
    devinTrace("stub.session_start", { inst: devinTraceInst, sid: devinTraceStubSid, model: context?.model?.provider, stored: models.length, loaded: Boolean(loaded) });
#;
s#(  on\("model_select", \(event, context\) => \{\n)#$1    devinTrace("stub.model_select", { inst: devinTraceInst, sid: devinTraceCtxSid(context), model: (event as unknown as { model?: Model<any> }).model?.provider, loaded: Boolean(loaded) });
#;
# --- registration.ts (real handlers, after the load) ---
s#(  pi\.on\("model_select", \(event, context\) => \{\n)#$1    // local patch 0012 (trace): the real model_select never attaches; log it so a switch to Devin after the load shows up.
    (globalThis as unknown as Record<symbol, ((event: string, data: Record<string, unknown>) => void) | undefined>)[Symbol.for("\@buyong/pi-devin/local-patch-0012/trace")]?.("real.model_select",
      { sid: (() => { try { return context.sessionManager.getSessionId(); } catch { return "<throws>"; } })(), model: event.model?.provider });
#;
