#!/usr/bin/env bash
set -uo pipefail

instruction="$1"
provider="$2"
model="$3"
thinking="$4"
poll_sec="${PI_WATCHDOG_POLL_SEC:-20}"
stagnation_sec="${PI_WATCHDOG_STAGNATION_SEC:-360}"
min_turns="${PI_WATCHDOG_MIN_TURNS:-6}"
output=/logs/agent/pi.txt
watchdog=/logs/agent/pi.watchdog.json

mkdir -p /logs/agent/pi/sessions

workspace_fingerprint() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    {
      git diff --no-ext-diff --binary -- . 2>/dev/null
      while IFS= read -r -d '' file; do
        cksum "$file" 2>/dev/null || true
      done < <(git ls-files --others --exclude-standard -z 2>/dev/null)
    } | cksum | awk '{print $1 ":" $2}'
  else
    find . -type f \
      -not -path './.git/*' \
      -not -path './node_modules/*' \
      -size -5M -exec cksum {} + 2>/dev/null | sort | cksum | awk '{print $1 ":" $2}'
  fi
}

"$HOME/.pi-agent/bin/pi" --print --mode json \
  --session-dir /logs/agent/pi/sessions \
  --provider "$provider" --model "$model" --thinking "$thinking" \
  "$instruction" >"$output" 2>&1 &
agent_pid=$!
started_at=$(date +%s)
last_progress_at=$started_at
last_action_at=$started_at
last_fingerprint=$(workspace_fingerprint)
last_action_count=0
turns_at_progress=0
triggered=false
reason=""
turn_count=0

while kill -0 "$agent_pid" 2>/dev/null; do
  sleep "$poll_sec"
  kill -0 "$agent_pid" 2>/dev/null || break
  now=$(date +%s)
  fingerprint=$(workspace_fingerprint)
  action_count=$(grep -v '"type":"message_update"' "$output" 2>/dev/null | wc -l | tr -d ' ')
  turn_count=$(grep -Ec '"type":"(turn_end|tool_execution_start)"' "$output" 2>/dev/null || true)

  if [[ "$fingerprint" != "$last_fingerprint" ]]; then
    last_fingerprint="$fingerprint"
    last_progress_at=$now
    turns_at_progress=$turn_count
  fi
  if (( action_count > last_action_count )); then
    last_action_count=$action_count
    last_action_at=$now
  fi

  if (( now - started_at >= stagnation_sec && now - last_action_at >= stagnation_sec )); then
    triggered=true
    reason="no-meaningful-action"
  elif (( now - started_at >= stagnation_sec && now - last_progress_at >= stagnation_sec && turn_count - turns_at_progress >= min_turns )); then
    triggered=true
    reason="workspace-stagnation-loop"
  fi

  if [[ "$triggered" == true ]]; then
    kill -TERM "$agent_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$agent_pid" 2>/dev/null || break
      sleep 2
    done
    kill -KILL "$agent_pid" 2>/dev/null || true
    break
  fi
done

wait "$agent_pid" 2>/dev/null
status=$?
finished_at=$(date +%s)
printf '{"triggered":%s,"reason":"%s","elapsedSec":%d,"turnCount":%d,"exitCode":%d}\n' \
  "$triggered" "$reason" "$((finished_at - started_at))" "$turn_count" "$status" >"$watchdog"
exit 0
