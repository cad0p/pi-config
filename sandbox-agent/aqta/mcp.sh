#!/bin/bash
B=https://app.aqta.ai/api/mcp
post(){ curl -s -m 25 -X POST "$B" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -D /tmp/hm -o /tmp/om -w 'code=%{http_code} type=%{content_type}\n' -d "$1"; grep -i 'mcp-session-id\|www-authenticate' /tmp/hm | tr -d '\r'; head -c 1200 /tmp/om; echo; }
echo '== initialize'; post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
echo '== notifications/initialized'; post '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo '== tools/list'; post '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
echo '== resources/list'; post '{"jsonrpc":"2.0","id":3,"method":"resources/list","params":{}}'
echo '== prompts/list'; post '{"jsonrpc":"2.0","id":4,"method":"prompts/list","params":{}}'
