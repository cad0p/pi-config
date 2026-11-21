#!/bin/sh
# Every register*/unregister* call on ModelRuntime ends with
# "void this.refresh({ allowNetwork: false })" — a fire-and-forget FULL rebuild:
# rebuildProviders() recomposes every provider (structuredClone of ~2k model
# definitions on this machine), models.refresh() restores the stored catalog of
# every provider, and queueAvailabilityRefresh() re-checks every credential.
# pi-fallback-provider registers 33 alias providers at factory time and again on
# session_start, so creating an in-process subagent session re-runs ~66 full
# rebuilds inside one synchronous burst and blocks the loop for ~5-8 s
# (/data/tmp/pimem/stall/REPORT.md §4).
#
# A per-provider refresh ({ providers: [id] }) is not provably equivalent: the
# void refresh also reloads models.json (new configured/radius providers for
# OTHER ids), restores stored catalogs of other providers, and refreshes their
# availability — incidental, but observable. Instead this patch coalesces the
# fire-and-forget refresh: requestCoalescedRefresh() keeps at most one full pass
# in flight and re-runs once if a registration landed mid-pass. Every
# registration mutates extensionProviders synchronously before scheduling, so a
# pass that starts after the last registration composes the exact same state the
# last of N overlapping passes would have composed — identical end state.
PATCH_ID="0010-provider-registration-refresh"
PATCH_TITLE="Coalesce the fire-and-forget full refresh triggered by each provider registration"
PATCH_UPSTREAM="none yet (to file on earendil-works/pi)"
PATCH_REMOVE_WHEN="upstream stops running a full rebuildProviders()+refresh per registerProvider/registerNativeProvider/unregisterProvider/registerVirtualModel/unregisterVirtualModel call (e.g. batches registrations or coalesces the refresh); then delete this file"

PATCH_FILES="dist/core/model-runtime.js dist/bundle/chunks/*.js"

UNPATCHED_RE='void this\.refresh\(\{ allowNetwork: false \}\);|this\.refresh\(\{allowNetwork:!1\}\)'
PATCHED_RE='coalescedRefreshError'

# Order matters: the call-site substitutions must run before the method
# insertion, otherwise the "this.refresh({allowNetwork:!1})" inside the inserted
# minified code would be rewritten into a recursive requestCoalescedRefresh()
# (perl -0 applies later commands to already-substituted text). The inserted
# minified method uses "t" instead of "this" for the same reason.
PATCH_PERL='
s#void this\.refresh\(\{ allowNetwork: false \}\);#void this.requestCoalescedRefresh(); /* local patch 0010 */#g;
s#this\.refresh\(\{allowNetwork:!1\}\)#this.requestCoalescedRefresh() /* local patch 0010 */#g;
s#(    markProvisionallyConfigured\(providerId, configuredStatus, type\) \{)#    /** local patch 0010: register/unregister calls each fired a full rebuild+refresh; coalesce to one\n    * in-flight pass plus at most one re-run per burst — the pass after the last registration\n    * composes the same state the last of N overlapping passes would have. */\n    coalescedRefreshDirty = false;\n    coalescedRefresh;\n    requestCoalescedRefresh() {\n        this.coalescedRefreshDirty = true;\n        if (!this.coalescedRefresh)\n            this.coalescedRefresh = (async () => {\n                // A failed pass must not drop a re-run queued during it; the last error still surfaces.\n                let coalescedRefreshError;\n                try {\n                    while (this.coalescedRefreshDirty) {\n                        this.coalescedRefreshDirty = false;\n                        try {\n                            await this.refresh({ allowNetwork: false });\n                        }\n                        catch (error) {\n                            coalescedRefreshError = error;\n                        }\n                    }\n                }\n                finally {\n                    this.coalescedRefresh = undefined;\n                }\n                if (coalescedRefreshError !== undefined)\n                    throw coalescedRefreshError;\n            })();\n        return this.coalescedRefresh;\n    }\n$1#;
s#(markProvisionallyConfigured\(providerId,configuredStatus,type\)\{)#requestCoalescedRefresh(){let t=this;t.coalescedRefreshDirty=!0,t.coalescedRefresh||(t.coalescedRefresh=(async()=>{let coalescedRefreshError;try{for(;t.coalescedRefreshDirty;){t.coalescedRefreshDirty=!1;try{await t.refresh({allowNetwork:!1})}catch(e){coalescedRefreshError=e}}}finally{t.coalescedRefresh=void 0}if(coalescedRefreshError!==void 0)throw coalescedRefreshError})());return t.coalescedRefresh}/* local patch 0010 */$1#;
'
