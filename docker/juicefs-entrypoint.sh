#!/bin/sh
# Format JuiceFS once, then mount in the foreground.
# META-URL and bucket are injected by Compose; the FUSE mount is bound to the host.
set -eu

META_URL=${JUICEFS_META_URL:?JUICEFS_META_URL is required}
BUCKET=${JUICEFS_BUCKET:?JUICEFS_BUCKET is required}
ACCESS_KEY=${JUICEFS_ACCESS_KEY:-kross}
SECRET_KEY=${JUICEFS_SECRET_KEY:?JUICEFS_SECRET_KEY is required}
VOLUME_NAME=${JUICEFS_VOLUME_NAME:-kross-work}
MOUNT_POINT=${JUICEFS_MOUNT_POINT:-/jfs}
CACHE_DIR=${JUICEFS_CACHE_DIR:-/var/jfsCache}

mkdir -p "$MOUNT_POINT" "$CACHE_DIR"

if ! juicefs status "$META_URL" >/dev/null 2>&1; then
  juicefs format \
    --storage minio \
    --bucket "$BUCKET" \
    --access-key "$ACCESS_KEY" \
    --secret-key "$SECRET_KEY" \
    "$META_URL" \
    "$VOLUME_NAME"
fi

exec juicefs mount "$META_URL" "$MOUNT_POINT" --cache-dir "$CACHE_DIR" --background=false
