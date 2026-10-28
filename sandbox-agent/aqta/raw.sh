#!/bin/bash
# usage: raw.sh '<json body>' [extra curl args]
B=https://app.aqta.ai/api/mcp
BODY="$1"; shift
curl -s -m 30 -X POST "$B" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "$@" -o /tmp/or -w 'code=%{http_code}\n' -d "$BODY"
head -c 1200 /tmp/or; echo
