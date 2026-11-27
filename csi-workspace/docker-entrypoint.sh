#!/bin/sh
# Make sure the data directory (a mounted disk on Render/Docker volumes, often root-owned)
# is writable, then drop root privileges and run the app as the unprivileged "node" user.
set -e
DATA_DIR="$(dirname "${DATABASE_PATH:-/data/csi-workspace.db}")"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
