#!/bin/sh

set -eu

smoke_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
network="kross-smoke-${smoke_suffix}"
worker="kross-smoke-worker-${smoke_suffix}"
gateway="kross-smoke-gateway-${smoke_suffix}"
web="kross-smoke-web-${smoke_suffix}"
access_token="kross-smoke-token"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    echo "Cloud container smoke 失败，容器日志如下：" >&2
    docker logs "$worker" >&2 2>/dev/null || true
    docker logs "$gateway" >&2 2>/dev/null || true
    docker logs "$web" >&2 2>/dev/null || true
  fi
  docker rm -f "$web" "$gateway" "$worker" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

wait_for_node_health() {
  container=$1
  url=$2
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if docker exec "$container" node -e \
      "fetch('$url').then(async response => { if (!response.ok) process.exit(1); const body = await response.json(); if (body.ok !== true) process.exit(1); }).catch(() => process.exit(1))"
    then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

docker network create "$network" >/dev/null

docker run --detach \
  --name "$worker" \
  --network "$network" \
  --tmpfs /workspace:uid=1000,gid=1000 \
  --env KROSS_WORKSPACE_ID=smoke-workspace \
  --env KROSS_WORKER_TOKEN=smoke-worker-token \
  kross-worker:ci >/dev/null
wait_for_node_health "$worker" "http://127.0.0.1:8788/"

docker run --detach \
  --name "$gateway" \
  --network "$network" \
  --network-alias gateway \
  --tmpfs /var/lib/kross-server \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --env KROSS_ACCESS_TOKEN="$access_token" \
  --env KROSS_SERVER_DATA=/var/lib/kross-server \
  --env KROSS_WORKER_IMAGE=kross-worker:ci \
  --env KROSS_DOCKER_NETWORK="$network" \
  --env KROSS_MANAGER_ID="smoke-${smoke_suffix}" \
  --env KROSS_STOP_WORKERS_ON_SHUTDOWN=false \
  kross-server:ci >/dev/null
wait_for_node_health "$gateway" "http://127.0.0.1:8787/healthz"
docker exec "$gateway" node -e \
  "fetch('http://127.0.0.1:8787/api/workspaces', { headers: { authorization: 'Bearer $access_token' } }).then(async response => { if (!response.ok) process.exit(1); const body = await response.json(); if (!Array.isArray(body)) process.exit(1); }).catch(() => process.exit(1))"

docker run --detach \
  --name "$web" \
  --network "$network" \
  kross-web:ci >/dev/null

attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$web" wget -qO- http://127.0.0.1:8787/ \
    | grep -q '<title>Kross Cloud</title>' &&
    docker exec "$web" wget -qO- http://127.0.0.1:8787/healthz \
      | grep -q '"ok":true'
  then
    echo "Cloud container smoke 通过：Web、Gateway、Worker 已就绪"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Web 容器未在 30 秒内就绪" >&2
exit 1
