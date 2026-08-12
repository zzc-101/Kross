#!/usr/bin/env bash
set -euo pipefail

package_path="${1:-}"
output_path="${2:-}"
node_image="${KROSS_TBENCH_NODE_IMAGE:-node:22.23.2-bookworm-slim}"

if [[ -z "$package_path" || ! -f "$package_path" ]]; then
  echo "用法：build-linux-runtime.sh <kross.tgz> <output-runtime.tgz>" >&2
  exit 2
fi
if [[ -z "$output_path" ]]; then
  echo "缺少 Runtime 输出路径" >&2
  exit 2
fi

package_dir="$(cd "$(dirname "$package_path")" && pwd)"
package_name="$(basename "$package_path")"
output_dir="$(mkdir -p "$(dirname "$output_path")" && cd "$(dirname "$output_path")" && pwd)"
output_name="$(basename "$output_path")"

echo "使用 $node_image 构建 Linux x86_64 Runtime……"
docker run --rm --platform linux/amd64 \
  -v "$package_dir:/input:ro" \
  -v "$output_dir:/output" \
  "$node_image" \
  sh -lc "
    set -eu
    rm -rf /tmp/kross-runtime
    mkdir -p /tmp/kross-runtime/bin
    npm install -g --prefix /tmp/kross-runtime /input/$package_name
    cp /usr/local/bin/node /tmp/kross-runtime/bin/node
    chmod 0755 /tmp/kross-runtime/bin/node /tmp/kross-runtime/bin/kross
    tar -C /tmp/kross-runtime -czf /output/$output_name .
    chmod 0644 /output/$output_name
    PATH=/tmp/kross-runtime/bin:\$PATH /tmp/kross-runtime/bin/kross --version
  "

echo "$output_path"
