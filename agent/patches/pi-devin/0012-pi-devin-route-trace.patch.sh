#!/bin/sh
# TEMPORARY TRACE, not a fix. Subagents on Devin hang for minutes after a steer and then end with
# stopReason "aborted" / "The previous Devin run ended." at the exact moment a sibling subagent in the same process ends
# (2026-11-26 15:17:41.808/.812 and 15:33:42.978/.982, H4 children). pi-fallback-provider ignores "aborted", so the child
# stops with no fallback. Hypothesis: session-routing.ts forSession() misses the caller's route and falls back to owner(),
# so the request queues on a sibling's run and dies with it. This patch logs every routing decision (requested vs chosen
# session, the whole route table) and every lifecycle cancellation with its cause, to ~/.pi/agent/pi-devin/route-trace.jsonl.
# v2: also index.ts (0009's lazy entry point: which call loads an instance, whether it attaches) and registration.ts (the
# real model_select, which fires after the load and never attaches). Repro v2 found a fallback-switched child whose
# instance loaded and never attached, so every request it made routed to owner().
# PI_DEVIN_ROUTE_TRACE=0 turns it off. Delete this file once the cause is fixed (0013).
PATCH_ID="0012-pi-devin-route-trace"
PATCH_TITLE="pi-devin: trace session routing and run cancellations (diagnostic, temporary)"
PATCH_UPSTREAM="none yet — evidence for an issue at https://github.com/buYoung/pi-packages"
PATCH_REMOVE_WHEN="the cross-session cancellation is understood and fixed; then delete this file and restore both targets from their pre-0012 state"

PATCH_ROOTS="${PI_AGENT_DIR}/npm/node_modules/@buyong/pi-devin"
PATCH_FILES="src/pi/adapters/pi/session-routing.ts src/pi/features/runs/lifecycle.ts index.ts src/pi/adapters/pi/registration.ts"

UNPATCHED_RE='const ROUTES_KEY = Symbol|const cancelled = \(\) => new Cancelled|Runs process-wide loads one after another|pi\.on\("model_select", \(event, context\) => \{'
PATCHED_RE='local patch 0012'

PATCH_PERL=$(patch_asset .pl) || return 1
