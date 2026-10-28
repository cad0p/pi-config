#!/bin/bash
# usage: otp.sh <mailbox> <email>
BOX="$1"; EMAIL="$2"
curl -s -m 20 -X POST https://app.aqta.ai/api/auth/send-otp -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" -w ' send=%{http_code}\n'
for i in 1 2 3 4 5 6 7 8; do
  sleep 4
  R=$(curl -s -m 15 -X POST https://api.maildrop.cc/graphql -H 'Content-Type: application/json' -d "{\"query\":\"query { inbox(mailbox:\\\"$BOX\\\") { id subject date } }\"}")
  case "$R" in *'"inbox":[]'*) echo "  poll $i: empty";; *'inbox'*) echo "  inbox: ${R:0:200}"; break;; *) echo "  poll $i: ${R:0:120}";; esac
done
