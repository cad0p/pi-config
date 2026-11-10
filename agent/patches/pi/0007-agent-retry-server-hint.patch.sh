#!/bin/sh
# pi's agent-level auto-retry waits baseDelayMs * 2^(attempt-1) (2s, 4s, 8s with defaults) and
# ignores the wait the server asked for. Devin's per-account request-rate limit says
# "Rate limit (resource_exhausted: Reached request rate limit. ... Your limit will reset in
# 16 seconds (at 06:02 UTC).)" with resets of 0-34 s, so all three retries can land inside the
# window, the turn fails, and pi-fallback-provider switches to exhausted accounts and backs off
# for minutes (2026-11-08: ~14 concurrent subagents on one Devin account stalled ~20 min each).
# Google's per-minute 429 has the same shape ("Please retry in 52.03s.").
#
# Fix, both in AgentSession:
# - _prepareRetry: the delay is at least the hinted wait + 1 s ("reset(s)|retry|try again in N
#   ms|s|seconds|m|minutes|h|hours", "~" allowed), still capped by settings.retry.maxAgentDelayMs.
# - _isRetryableError: a hinted wait longer than maxAgentDelayMs (default 60 s) is not retryable,
#   e.g. Devin's free-model quota "Your limit will reset in ~3 hours": retrying cannot help, so
#   the turn settles at once and fallback moves on instead of burning three retries.
# Upstream: earendil-works/pi#10601 (agent-level retry ignores Retry-After) was closed and its
# PR #10600 (AssistantMessage.retryAfterMs) was not merged; main still uses pure backoff.
PATCH_ID="0007-agent-retry-server-hint"
PATCH_TITLE="Agent retry: wait at least the server's 'reset/retry in N' hint; no retry past the cap"
PATCH_UPSTREAM="earendil-works/pi#10601 (closed, fix #10600 not merged; still present in 1.5.1)"
PATCH_REMOVE_WHEN="upstream agent-level retry honors the server-requested delay (e.g. AssistantMessage.retryAfterMs) for text hints; then delete this file"

PATCH_FILES="dist/core/agent-session.js dist/bundle/chunks/*.js"

UNPATCHED_RE='let delayMs=retryDelayMs\(settings,this\._retryAttempt\);|const delayMs = retryDelayMs\(settings, this\._retryAttempt\);'
PATCHED_RE='_serverRetryHintMs\(message\)\{|_serverRetryHintMs\(message\) \{'

PATCH_PERL='
s#_isRetryableError\(message\)\{return #_serverRetryHintMs(message){let m=/\\b(?:resets?|retry|try again) in ~?\\s*(\\d+(?:\\.\\d+)?)\\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\\b/i.exec(message.errorMessage??"");if(!m)return;let u=m[2].toLowerCase(),f=u.startsWith("ms")||u.startsWith("milli")?1:u.startsWith("h")?36e5:u.startsWith("m")?6e4:1e3;return Math.ceil(Number(m[1])*f)}_isRetryableError(message){let hintMs=this._serverRetryHintMs(message),capMs=this.settingsManager.getRetrySettings().maxAgentDelayMs??6e4;if(hintMs!==void 0&&capMs>0&&hintMs>capMs)return!1;return #;
s#let delayMs=retryDelayMs\(settings,this\._retryAttempt\);#let delayMs=retryDelayMs(settings,this._retryAttempt),hintMs=this._serverRetryHintMs(message);hintMs!==void 0&&(delayMs=Math.min(Math.max(delayMs,hintMs+1e3),settings.maxAgentDelayMs??6e4));#;
s#(\n(\s*)_isRetryableError\(message\) \{\n)#\n$2/** local patch 0007: the wait a provider asked for in its error text, e.g. "reset in 16 seconds" or "retry in 52.03s". */\n$2_serverRetryHintMs(message) {\n$2    const m = /\\b(?:resets?|retry|try again) in ~?\\s*(\\d+(?:\\.\\d+)?)\\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\\b/i.exec(message.errorMessage ?? "");\n$2    if (!m)\n$2        return undefined;\n$2    const u = m[2].toLowerCase();\n$2    const f = u.startsWith("ms") || u.startsWith("milli") ? 1 : u.startsWith("h") ? 3600000 : u.startsWith("m") ? 60000 : 1000;\n$2    return Math.ceil(Number(m[1]) * f);\n$2}$1$2    // local patch 0007: a hinted wait past the retry cap cannot be retried away; let the turn settle.\n$2    const hintMs = this._serverRetryHintMs(message);\n$2    const capMs = this.settingsManager.getRetrySettings().maxAgentDelayMs ?? 60000;\n$2    if (hintMs !== undefined && capMs > 0 && hintMs > capMs)\n$2        return false;\n#;
s#const delayMs = retryDelayMs\(settings, this\._retryAttempt\);#let delayMs = retryDelayMs(settings, this._retryAttempt);\n        const hintMs = this._serverRetryHintMs(message);\n        if (hintMs !== undefined)\n            delayMs = Math.min(Math.max(delayMs, hintMs + 1000), settings.maxAgentDelayMs ?? 60000);#;
'
