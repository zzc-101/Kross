#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
ENV_FILE="$PROJECT_DIR/.env"
ENV_EXAMPLE="$PROJECT_DIR/.env.example"

usage() {
  cat <<'EOF'
用法：
  ./scripts/start-cloud.sh             构建镜像并启动 Cloud Agent
  ./scripts/start-cloud.sh --no-build  使用现有镜像启动
  ./scripts/start-cloud.sh --stop      停止服务并保留数据卷
  ./scripts/start-cloud.sh --logs      持续查看 Gateway 日志
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

ensure_env() {
  generated_token=""

  if [ ! -f "$ENV_FILE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "已根据 .env.example 创建 .env。"
  fi

  access_token=$(read_env_value KROSS_ACCESS_TOKEN)
  if [ -z "$access_token" ]; then
    if ! command -v openssl >/dev/null 2>&1; then
      echo "错误：无法生成访问令牌，请安装 openssl 或手动设置 KROSS_ACCESS_TOKEN。" >&2
      exit 1
    fi

    generated_token=$(openssl rand -hex 32)
    temp_env=$(mktemp "${TMPDIR:-/tmp}/kross-env.XXXXXX")
    trap 'rm -f "$temp_env"' EXIT HUP INT TERM
    awk -v token="$generated_token" '
      /^KROSS_ACCESS_TOKEN=/ {
        print "KROSS_ACCESS_TOKEN=" token
        updated = 1
        next
      }
      { print }
      END {
        if (!updated) {
          print "KROSS_ACCESS_TOKEN=" token
        }
      }
    ' "$ENV_FILE" >"$temp_env"
    mv "$temp_env" "$ENV_FILE"
    trap - EXIT HUP INT TERM
    chmod 600 "$ENV_FILE"
  fi
}

wait_for_gateway() {
  port=$(read_env_value KROSS_PORT)
  if [ -z "$port" ]; then
    port=8787
  fi

  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:$port/"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "Gateway 未能在 30 秒内就绪，最近日志如下：" >&2
  docker compose logs --tail 80 gateway >&2
  return 1
}

command=${1:-start}
case "$command" in
  start | --no-build)
    require_docker
    ensure_env
    cd "$PROJECT_DIR"

    if [ "$command" = "start" ]; then
      echo "正在构建 Gateway 和 Worker 镜像……"
      docker compose --profile build build
    fi

    echo "正在启动 Cloud Agent……"
    docker compose up -d gateway
    wait_for_gateway

    port=$(read_env_value KROSS_PORT)
    if [ -z "$port" ]; then
      port=8787
    fi

    echo
    echo "Cloud Agent 已启动：http://localhost:$port"
    if [ -n "$generated_token" ]; then
      echo "首次登录访问令牌：$generated_token"
      echo "令牌已保存到 $ENV_FILE，请妥善保管。"
    else
      echo "请使用 $ENV_FILE 中的 KROSS_ACCESS_TOKEN 登录。"
    fi
    echo "查看日志：./scripts/start-cloud.sh --logs"
    echo "停止服务：./scripts/start-cloud.sh --stop"
    ;;
  --stop)
    require_docker
    cd "$PROJECT_DIR"
    KROSS_ACCESS_TOKEN=unused docker compose down
    echo "Cloud Agent 已停止，工作区和服务端数据卷均已保留。"
    ;;
  --logs)
    require_docker
    cd "$PROJECT_DIR"
    KROSS_ACCESS_TOKEN=unused docker compose logs -f gateway
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
