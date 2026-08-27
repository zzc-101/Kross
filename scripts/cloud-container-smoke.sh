#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
COMPOSE_FILE="$PROJECT_DIR/deploy/local/docker-compose.yml"

compose() {
  docker compose --project-directory "$PROJECT_DIR" -f "$COMPOSE_FILE" "$@"
}

smoke_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
export COMPOSE_PROJECT_NAME="kross-smoke-${smoke_suffix}"
export KROSS_POSTGRES_PASSWORD="smoke-postgres-${smoke_suffix}"
export KROSS_CREDENTIAL_MASTER_KEY="abcdef0123456789abcdef0123456789"
export KROSS_S3_SECRET_KEY="kross-minio-smoke-${smoke_suffix}"
export KROSS_DEV_IDENTITY=1
export KROSS_PORT=0
export KROSS_S3_PORT=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    echo "SaaS container smoke 失败，容器状态和日志如下：" >&2
    compose ps >&2 2>/dev/null || true
    compose logs --tail 120 >&2 2>/dev/null || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

compose config --quiet
compose up -d --build web

attempt=0
while [ "$attempt" -lt 90 ]; do
  published=$(compose port web 8787 2>/dev/null || true)
  port=${published##*:}
  if [ -n "$port" ] \
    && curl --fail --silent "http://127.0.0.1:$port/healthz" \
      | grep -q '"status":"ok"' \
    && curl --fail --silent --output /dev/null "http://127.0.0.1:$port/admin/"
  then
    compose exec -T server curl -fsS \
      -H 'x-kross-user-id: smoke-user' \
      http://127.0.0.1:8787/api/v2/me >/dev/null
    echo "SaaS container smoke 通过：PostgreSQL、MinIO、Java 控制面、用户端与管理端均已就绪"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "SaaS 服务未在 90 秒内就绪" >&2
exit 1
