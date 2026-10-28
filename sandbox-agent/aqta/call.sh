#!/bin/bash
# usage: call.sh <toolname> <json-arguments> [extra curl args...]
B=https://app.aqta.ai/api/mcp
NAME="$1"; ARGS="$2"; shift 2
curl -s -m 30 -X POST "$B" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "$@" -o /tmp/oc -w 'code=%{http_code}\n' -d "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"$NAME\",\"arguments\":$ARGS}}"
head -c 1400 /tmp/oc; echo
