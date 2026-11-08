#!/bin/sh
# @buyong/pi-devin returns { action: "stop" } from cache_warming_decision for every devin
# model (src/pi/adapters/pi/registration.ts). CLI -e extensions load BEFORE installed
# packages and the last handler with an action wins, so no other extension can override it.
#
# Fix: drop the forced stop and let pi decide. Devin catalog models report cost 0 and no
# promptCache lifetime, so pi still never warms them unless models.json opts a model in with
# providers.devin.modelOverrides[<id>] = { promptCache: { short: 300 }, cost: {...} }.
PATCH_ID="0003-pi-devin-cache-warming"
PATCH_TITLE="pi-devin: let pi decide cache warming (opt-in per model via models.json)"
PATCH_UPSTREAM="buYoung/pi-packages (not filed; present in @buyong/pi-devin 0.1.14)"
PATCH_REMOVE_WHEN="upstream stops forcing action stop for devin models, or warm requests turn out to break Devin step state; then delete this file"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/adapters/pi/registration.ts"

UNPATCHED_RE='pi\.on\("cache_warming_decision", \(_event, context\) => context\.model\?\.provider === "devin" \? \{ action: "stop" \} : undefined\);'
PATCHED_RE='local patch 0003'

PATCH_PERL='
s#pi\.on\("cache_warming_decision", \(_event, context\) => context\.model\?\.provider === "devin" \? \{ action: "stop" \} : undefined\);#// local patch 0003: no forced stop; pi decides from the model promptCache/cost metadata.#;
'
