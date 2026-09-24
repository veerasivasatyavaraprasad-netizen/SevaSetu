#!/usr/bin/env bash
# Daily PostgreSQL backup, kept for 14 days. Copy them off the server too
# (and test a restore): see README.md → Backups.
set -euo pipefail
COMPOSE_DIR=/opt/sevasetu/deploy/oracle
DEST=/var/backups/sevasetu
mkdir -p "$DEST" && chmod 700 "$DEST"
cd "$COMPOSE_DIR"
FILE="$DEST/sevasetu-$(date +%F-%H%M).sql.gz"
docker compose exec -T db pg_dump -U sevasetu --no-owner sevasetu | gzip > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
chmod 600 "$FILE"
find "$DEST" -name 'sevasetu-*.sql.gz' -mtime +14 -delete
