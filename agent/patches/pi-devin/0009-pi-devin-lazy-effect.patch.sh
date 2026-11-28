#!/bin/sh
# @buyong/pi-devin builds a ManagedRuntime and runSync()s ExtensionConfig, ModelCatalog, Runs, Sidekicks and
# UsageStatus while Pi loads the extension (src/pi/adapters/pi/registration.ts registerDevinExtension), so every
# Pi process carries effect (+30 MB RSS), its own Effect-typed module graph (+30 MB) and protobufjs (+4 MB) even
# when Devin is never used. Pi also calls provider.refreshModels() during the load phase (registerNativeProvider
# -> refresh({ allowNetwork: false })), so "load on first use" only works if the entry point serves the model
# list itself.
#
# Fix: index.ts registers the provider, /devin, /devin-fusion and the two session hooks from plain code: the
# model list is Pi's own stored catalog (models-store.json, the list this extension published last), and the
# Effect extension is imported when the session starts on a Devin model, selects one, carries a Devin run state,
# runs /devin, /devin-fusion, signs in, or streams. registration.ts hands its session-start body back as
# startSession so the session that triggered the load gets attached; the two command bodies are exported for the
# same reason. Behaviour for a session that uses Devin is unchanged; behaviour for a session that never does is
# "nothing happens", as before, minus the imports.
#
# v2 (2026-11-25): the cold stub must not freeze the catalog. v1's refreshModels() only re-read the store, and the
# real provider's registration refresh is offline, so the Devin list stayed at whatever a loaded process last fetched
# (SWE-2.1 never appeared; debugging note 2026-11-25-pi-devin-swe-2-1-missing-lazy-stub-froze-the-catalog). Now a
# cold refreshModels() with network fetches when the stored list is missing, older than 24 h, or forced, and the
# daily account check (oauth.refresh) runs cold too, both in a short-lived Node child that exits when done: a worker
# thread leaves its Effect graph resident in pi (+50 MB measured after terminate + GC). /devin refresh forces the
# fetch (cold: stub handler; loaded: a branch in devinCommand). No Node child (single-file build, Bun) -> in-process.
#
# v3 (2026-11-26): loading on first use registers the real provider mid-session, often a few ms before a request, while
# its list is still empty until Pi's refresh restores it; Pi then refuses the request ("No API provider registered for
# api: devin-connect"). The real provider now answers with the stored list while its own is empty (0011 tries another
# attached instance first). Upgrading an install already on v1/v2 needs index.ts restored from index.ts.orig first,
# because the runner sees the 0009 marker and reports "already patched".
#
# v4 (2026-11-26): subagents that switched to Devin together hung forever or failed. Loads now run one at a time per
# process (concurrent loads got a half-initialized module: "reading 'makeExtensionRuntime'"), and the session_start /
# model_select handlers return the load, which Pi awaits, so the session's own instance is attached before its first
# request (an earlier request reached the instance another session registered last, and died with that session).
PATCH_ID="0009-pi-devin-lazy-effect"
PATCH_TITLE="pi-devin: load Effect, protobufjs and the runtime only when the session uses Devin"
PATCH_UPSTREAM="https://github.com/buYoung/pi-packages/issues/91 (present in @buyong/pi-devin 0.1.16)"
PATCH_REMOVE_WHEN="upstream registers the provider, commands and session hooks from a non-Effect entry point with a cached model list and imports the runtime on first use; or the author rejects the change and the package is dropped from enabledModels"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="index.ts src/pi/adapters/pi/registration.ts src/pi/adapters/pi/devin-command.ts src/pi/adapters/pi/fusion-command.ts"

UNPATCHED_RE="Pi's entry point\\.|pi\\.on\\(\"session_start\", \\(_event, context\\)|^const devinCommand = \\(|^const fusionCommand = \\("
PATCHED_RE="local patch 0009"

# The replacement entry point. Kept in its own variable because PATCH_PERL only substitutes; a whole-file
# replacement of a 12-line file is the smallest edit that keeps every Pi-facing registration synchronous.
NEW_DEVIN_INDEX=$(patch_asset .index.ts) || return 1
export NEW_DEVIN_INDEX

PATCH_PERL=$(patch_asset .pl) || return 1
