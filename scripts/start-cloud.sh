#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
ENV_FILE="$PROJECT_DIR/.env"
ENV_EXAMPLE="$PROJECT_DIR/.env.example"

usage() {
  cat <<'EOF'
用法：
  ./scripts/start-cloud.sh             构建并启动 SaaS Work Agent
  ./scripts/start-cloud.sh --no-build  使用现有镜像启动
  ./scripts/start-cloud.sh --stop      停止服务并保留 PostgreSQL / MinIO 数据卷
  ./scripts/start-cloud.sh --logs      持续查看服务日志
  ./scripts/start-cloud.sh --migrate   启动控制面以执行 Flyway 迁移
  ./scripts/start-cloud.sh --help      显示帮助
EOF
}

read_env_value() {
  key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "错误：未找到 Docker，请先安装并启动 Docker Desktop。" >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "错误：当前 Docker 未提供 Compose 插件。" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "错误：Docker Engine 未运行，请先启动 Docker Desktop。" >&2
    exit 1
  fi
}

ensure_secret() {
  key=$1
  current=$(read_env_value "$key")
  if [ -n "$current" ]; then
    return
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "错误：无法生成 $key，请安装 openssl 或手动配置。" >&2
    exit 1
  fi
  generated=$(openssl rand -hex 32)
  temp_env=$(mktemp "${TMPDIR:-/tmp}/kross-env.XXXXXX")
  awk -v key="$key" -v value="$generated" '
    index($0, key "=") == 1 { print key "=" value; updated = 1; next }
    { print }
    END { if (!updated) print key "=" value }
  ' "$ENV_FILE" >"$temp_env"
  mv "$temp_env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成 $key 并保存到 ${ENV_FILE}。"
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "已根据 .env.example 创建 .env。"
  fi
  ensure_secret KROSS_POSTGRES_PASSWORD
  ensure_secret KROSS_CREDENTIAL_MASTER_KEY
  ensure_secret KROSS_S3_SECRET_KEY
}

wait_for_web() {
  port=$(read_env_value KROSS_PORT)
  if [ -z "$port" ]; then port=8787; fi
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:$port/healthz"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Web 入口未能在 60 秒内就绪，最近日志如下：" >&2
  docker compose logs --tail 100 web server minio postgres >&2
  return 1
}

wait_for_admin_web() {
  port=$(read_env_value KROSS_ADMIN_PORT)
  if [ -z "$port" ]; then port=8788; fi
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:$port/healthz"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "管理端入口未能在 60 秒内就绪，最近日志如下：" >&2
  docker compose logs --tail 100 admin-web server postgres >&2
  return 1
}

command=${1:-start}
case "$command" in
  start | --no-build)
    require_docker
    ensure_env
    cd "$PROJECT_DIR"
    if [ "$command" = "start" ]; then
      echo "正在构建用户端、管理端、Java 控制面和 Worker 镜像……"
      docker compose build
    fi
    echo "正在启动 SaaS Work Agent……"
    docker compose up -d web admin-web
    wait_for_web
    wait_for_admin_web
    port=$(read_env_value KROSS_PORT)
    if [ -z "$port" ]; then port=8787; fi
    admin_port=$(read_env_value KROSS_ADMIN_PORT)
    if [ -z "$admin_port" ]; then admin_port=8788; fi
    echo "SaaS Work Agent 用户端已启动：http://localhost:$port"
    echo "SaaS Work Agent 管理端已启动：http://localhost:$admin_port"
    ;;
  --stop)
    require_docker
    ensure_env
    cd "$PROJECT_DIR"
    docker compose down
    echo "服务已停止，PostgreSQL 与 MinIO 数据卷已保留。"
    ;;
  --logs)
    require_docker
    ensure_env
    cd "$PROJECT_DIR"
    docker compose logs -f web admin-web server minio postgres
    ;;
  --migrate | --migrate-apply)
    require_docker
    ensure_env
    cd "$PROJECT_DIR"
    docker compose up -d postgres minio
    docker compose up -d --force-recreate --no-deps server
    echo "控制面已启动，Flyway 会在进程启动时执行迁移。"
    ;;
  --help | -h)
    usage
    ;;
  *)
    echo "错误：未知参数 $command" >&2
    usage >&2
    exit 2
    ;;
esac
