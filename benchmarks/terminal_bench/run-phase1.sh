#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
env_file="${1:-$repo_root/.benchmark-secrets/terminal-bench.env}"
jobs_root="${2:-$repo_root/benchmarks/terminal_bench/results}"
package_path="${3:-}"

if [[ ! -f "$env_file" ]]; then
  echo "缺少 Benchmark 环境文件：$env_file" >&2
  exit 2
fi
if [[ -z "$package_path" || ! -f "$package_path" ]]; then
  echo "第三个参数必须是 npm pack 生成的 Kross tgz" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
if [[ -z "${ANTHROPIC_MODEL:-}" ]]; then
  echo "环境文件缺少 ANTHROPIC_MODEL" >&2
  exit 2
fi
model_name="anthropic/$ANTHROPIC_MODEL"
model_slug="$(printf '%s' "$ANTHROPIC_MODEL" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
model_slug="${model_slug%-}"

task_args=()
while IFS= read -r task; do
  [[ -n "$task" ]] && task_args+=(--include-task-name "$task")
done < "$repo_root/benchmarks/terminal_bench/tasks.txt"

mkdir -p "$jobs_root"
export PYTHONPATH="$repo_root${PYTHONPATH:+:$PYTHONPATH}"

harbor run \
  --dataset terminal-bench@2.0 \
  --agent benchmarks.terminal_bench.kross_agent:KrossAgent \
  --model "$model_name" \
  --agent-kwarg "package_path=$package_path" \
  --env-file "$env_file" \
  --n-attempts 3 \
  --n-concurrent 2 \
  --job-name "kross-$model_slug-phase1-watchdog" \
  --jobs-dir "$jobs_root" \
  --yes \
  "${task_args[@]}"

harbor run \
  --dataset terminal-bench@2.0 \
  --agent benchmarks.terminal_bench.pi_agent:PiBaselineAgent \
  --model "$model_name" \
  --agent-kwarg thinking=high \
  --env-file "$env_file" \
  --n-attempts 3 \
  --n-concurrent 2 \
  --job-name "pi-$model_slug-phase1-watchdog" \
  --jobs-dir "$jobs_root" \
  --yes \
  "${task_args[@]}"

cd "$repo_root"
node benchmarks/terminal_bench/summarize-results.mjs \
  "$jobs_root/kross-$model_slug-phase1-watchdog" \
  "$jobs_root/pi-$model_slug-phase1-watchdog"
