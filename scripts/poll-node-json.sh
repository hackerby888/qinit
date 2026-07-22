#!/usr/bin/env bash
# Poll a node RPC field until it is present and non-zero, tolerating transient failures.
# Usage: poll-node-json.sh <url> <jq-filter> [tries=12] [sleep-secs=2]
set -uo pipefail
url="$1"
filter="$2"
tries="${3:-12}"
nap="${4:-2}"
for ((i = 0; i < tries; i++)); do
  out=$(curl -s --max-time 5 "$url" | jq -r "$filter" 2>/dev/null || true)
  if [ -n "$out" ] && [ "$out" != "null" ] && [ "$out" != "0" ]; then
    echo "$out"
    exit 0
  fi
  sleep "$nap"
done
exit 1
