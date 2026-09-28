#!/usr/bin/env bash
# Builds the single-file page and publishes it to https://ne.so.gl/gitmusic/
# nginx already serves /var/www/html for ne.so.gl, so no server config is involved.
#   tools/deploy.sh
# Override the target with DEPLOY_HOST / DEPLOY_DIR if needed.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@107.150.2.179}"
DIR="${DEPLOY_DIR:-/var/www/html/gitmusic}"
URL="${DEPLOY_URL:-https://ne.so.gl/gitmusic/}"

cd "$(dirname "$0")/.."
node tools/build.mjs

ssh -o BatchMode=yes "$HOST" "mkdir -p '$DIR'"
# Upload next to the live file, then swap it in one rename so visitors never get half a page.
scp -o BatchMode=yes -q dist/filophone.html "$HOST:$DIR/index.html.tmp"
ssh -o BatchMode=yes "$HOST" "chmod 644 '$DIR/index.html.tmp' && mv -f '$DIR/index.html.tmp' '$DIR/index.html'"

code=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
echo "Published: $URL (HTTP $code)"
