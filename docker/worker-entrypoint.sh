#!/bin/sh
set -eu

mkdir -p /work/files
chown node:node /work /work/files

export HOME=/home/node
export USER=node

exec su-exec node "$@"
