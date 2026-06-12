#!/usr/bin/env bash
# Poll a node RPC GET until a jq field yields a present, non-zero value; echo it and exit 0, or exit 1
# on timeout. Robust under `set -e -o pipefail`: a transient curl/jq miss (node still booting, momentary
# refused connection, malformed partial) NEVER aborts the caller — it retries. Shared by qinit's own CI
# and core-lite's qinit-release smoke so the retry logic can't drift between the two repos (the drift is
# exactly what flaked the windows smoke: a bare `curl | jq` aborting the step on the first failure).
#
# usage: poll-node-json.sh <url> <jq-filter> [tries=12] [sleep-secs=2]
#   <jq-filter> e.g. '.digest // empty'  or  '.tick // 0'
set -uo pipefail
url="$1"; filter="$2"; tries="${3:-12}"; nap="${4:-2}"
for ((i = 0; i < tries; i++)); do
  out=$(curl -s --max-time 5 "$url" | jq -r "$filter" 2>/dev/null || true)
  if [ -n "$out" ] && [ "$out" != "null" ] && [ "$out" != "0" ]; then echo "$out"; exit 0; fi
  sleep "$nap"
done
exit 1
