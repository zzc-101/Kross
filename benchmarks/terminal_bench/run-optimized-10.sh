#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
env_file="${1:-$repo_root/.benchmark-secrets/terminal-bench.env}"
jobs_root="${2:-$repo_root/benchmarks/terminal_bench/results}"
concurrency="${KROSS_TBENCH_CONCURRENCY:-5}"
attempts="${KROSS_TBENCH_ATTEMPTS:-1}"

if [[ ! -f "$env_file" ]]; then
  echo "缺少 Benchmark 环境文件：$env_file" >&2
  exit 2
fi
if ! [[ "$concurrency" =~ ^[1-9][0-9]*$ && "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "并发数和尝试次数必须是正整数" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

for required in AGENT_LLM_PROVIDER ANTHROPIC_MODEL ANTHROPIC_BASE_URL ANTHROPIC_API_KEY; do
  if [[ -z "${!required:-}" ]]; then
    echo "环境文件缺少 $required" >&2
    exit 2
  fi
done

model_host="$(node -e 'process.stdout.write(new URL(process.env.ANTHROPIC_BASE_URL).hostname)')"
resolved_ips="$(node -e '
  const dns = require("node:dns");
  dns.lookup(process.argv[1], { all: true }, (error, addresses) => {
    if (error) { console.error(error.message); process.exit(1); }
    process.stdout.write(addresses.map((item) => item.address).join(" "));
  });
' "$model_host")"

echo "模型域名：$model_host"
echo "DNS 地址：$resolved_ips"
if [[ " $resolved_ips " =~ [[:space:]]198\.(18|19)\. ]]; then
  echo "检测到 TUN/Fake-IP（198.18.0.0/15），请关闭 TUN 或修正规则后重试。" >&2
  exit 3
fi

echo "检查模型端点 TLS……"
curl -sS -I --connect-timeout 8 --max-time 15 \
  -o /dev/null "https://$model_host"

cd "$repo_root"
echo "构建并打包当前 Kross……"
npm run typecheck
npm run build:cli
pack_dir="$(mktemp -d /tmp/kross-terminalbench-pack-XXXXXX)"
package_name="$(npm pack --ignore-scripts --pack-destination "$pack_dir" | tail -n 1)"
package_path="$pack_dir/$package_name"
runtime_path="$pack_dir/kross-linux-x64-runtime.tgz"
"$repo_root/benchmarks/terminal_bench/build-linux-runtime.sh" \
  "$package_path" "$runtime_path"
cleanup() {
  rm -f "$runtime_path"
  rm -f "$package_path"
  rmdir "$pack_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

model_slug="$(printf '%s' "$ANTHROPIC_MODEL" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
model_slug="${model_slug%-}"
job_name="kross-${model_slug}-optimized-10x${attempts}-c${concurrency}-$(date +%Y%m%d-%H%M%S)"
job_dir="$jobs_root/$job_name"

task_args=()
while IFS= read -r task; do
  [[ -n "$task" ]] && task_args+=(--include-task-name "$task")
done < "$repo_root/benchmarks/terminal_bench/tasks.txt"

mkdir -p "$jobs_root"
export PYTHONPATH="$repo_root${PYTHONPATH:+:$PYTHONPATH}"

echo "启动 Terminal-Bench：10 题 × ${attempts} 次，并发 ${concurrency}"
echo "结果目录：$job_dir"
harbor run \
  --dataset terminal-bench@2.0 \
  --agent benchmarks.terminal_bench.kross_agent:KrossAgent \
  --model "anthropic/$ANTHROPIC_MODEL" \
  --agent-kwarg "runtime_path=$runtime_path" \
  --env-file "$env_file" \
  --n-attempts "$attempts" \
  --n-concurrent "$concurrency" \
  --job-name "$job_name" \
  --jobs-dir "$jobs_root" \
  --yes \
  "${task_args[@]}"

node "$repo_root/benchmarks/terminal_bench/summarize-results.mjs" "$job_dir"
echo "评测完成：$job_dir"
