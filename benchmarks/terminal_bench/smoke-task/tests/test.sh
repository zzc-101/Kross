#!/usr/bin/env bash
set -euo pipefail
mkdir -p /logs/verifier
if [[ "$(cat /workspace/kross-adapter-smoke.txt 2>/dev/null || true)" == "ok" ]]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
