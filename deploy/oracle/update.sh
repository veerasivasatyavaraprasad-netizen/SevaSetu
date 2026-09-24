#!/usr/bin/env bash
# Pull the latest code and restart. Database migrations run automatically
# on start; a backup is taken first.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo ./update.sh"; exit 1; }
/usr/local/bin/sevasetu-backup || echo "warning: backup failed"
git -C ../.. pull --ff-only
docker compose build app
docker compose up -d
docker compose ps
