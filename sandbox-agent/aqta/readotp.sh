#!/bin/bash
# usage: readotp.sh <mailbox> [--wait-only]
BOX="$1"
for i in $(seq 1 10); do
  sleep 3
  R=$(curl -s -m 15 -X POST https://api.maildrop.cc/graphql -H 'Content-Type: application/json' -d "{\"query\":\"query { inbox(mailbox:\\\"$BOX\\\") { id subject date } }\"}")
  ID=$(echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const m=j.data.inbox;console.log(m.length?m[0].id:'')}catch(e){console.log('')}})")
  if [ -n "$ID" ]; then
    echo "msg $ID"
    curl -s -m 15 -X POST https://api.maildrop.cc/graphql -H 'Content-Type: application/json' -d "{\"query\":\"query { message(mailbox:\\\"$BOX\\\", id:\\\"$ID\\\") { data } }\"}" | grep -oE '[0-9]{6}' | head -5
    exit 0
  fi
  echo "  poll $i empty"
done
echo NOMAIL
