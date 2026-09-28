#!/usr/bin/env bash
# Publishes the site to https://ne.so.gl/gitmusic/.
# The server keeps a clone of this repo right in the web folder (its git dir lives
# outside the web root, in /var/lib/git/gitmusic.git), so publishing is a pull from GitHub:
#   git push && tools/deploy.sh
# Override the target with DEPLOY_HOST / DEPLOY_DIR / DEPLOY_URL if needed.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@107.150.2.179}"
DIR="${DEPLOY_DIR:-/var/www/html/gitmusic}"
URL="${DEPLOY_URL:-https://ne.so.gl/gitmusic/}"

cd "$(dirname "$0")/.."
git fetch -q origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Local HEAD differs from origin/main. Push first: the server pulls from GitHub." >&2
  exit 1
fi

ssh -o BatchMode=yes "$HOST" "git -C '$DIR' pull --ff-only -q && git -C '$DIR' log --oneline -1"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
echo "Published: $URL (HTTP $code)"
