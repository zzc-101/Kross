#!/bin/sh

set -eu

smoke_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
export COMPOSE_PROJECT_NAME="kross-smoke-${smoke_suffix}"
export KROSS_POSTGRES_PASSWORD="smoke-postgres-${smoke_suffix}"
export KROSS_ORCHESTRATOR_SERVICE_TOKEN="0123456789abcdef0123456789abcdef-${smoke_suffix}"
export KROSS_BLOB_SIGNING_SECRET="abcdef0123456789abcdef0123456789-${smoke_suffix}"
export KROSS_DEV_IDENTITY=1
export KROSS_PORT=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    echo "SaaS container smoke 失败，容器状态和日志如下：" >&2
    docker compose ps >&2 2>/dev/null || true
    docker compose logs --tail 120 >&2 2>/dev/null || true
  fi
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

docker compose config --quiet
docker compose up -d --build web orchestrator

attempt=0
while [ "$attempt" -lt 90 ]; do
  published=$(docker compose port web 8787 2>/dev/null || true)
  port=${published##*:}
  if [ -n "$port" ] && curl --fail --silent "http://127.0.0.1:$port/health" \
    | grep -q '"status":"ok"'
  then
    docker compose exec -T server node -e \
      "fetch('http://127.0.0.1:8787/api/v2/me',{headers:{'x-kross-user-id':'smoke-user'}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
    docker compose exec -T orchestrator node -e \
      "fetch('http://127.0.0.1:8790/healthz',{headers:{authorization:'Bearer $KROSS_ORCHESTRATOR_SERVICE_TOKEN'}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
    echo "SaaS container smoke 通过：PostgreSQL、Migration、Server、Orchestrator、Web 已就绪"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "SaaS 服务未在 90 秒内就绪" >&2
exit 1
