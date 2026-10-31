#!/usr/bin/env bash
set -euo pipefail
: "${DEPLOY_ROOT:?Set DEPLOY_ROOT to the absolute application release directory}"
: "${RELEASE_ID:?Set RELEASE_ID to a commit SHA}"
[[ "$DEPLOY_ROOT" = /* && "$DEPLOY_ROOT" != / && "$RELEASE_ID" =~ ^[a-f0-9]{40}$ ]] || exit 2
release="$DEPLOY_ROOT/releases/$RELEASE_ID"
mkdir -p "$release" "$DEPLOY_ROOT/shared/uploads"
tar -xzf "$DEPLOY_ROOT/incoming-$RELEASE_ID.tgz" -C "$release"
cd "$release"
ln -s "$DEPLOY_ROOT/shared/.env" .env
ln -s "$DEPLOY_ROOT/shared/uploads" uploads
npm ci --include=dev
# Back up before applying forward-compatible migrations. Stop on backup/migration failure.
BACKUP_DIR="$DEPLOY_ROOT/backups" node scripts/backup.mjs
npm run migration:run
previous="$(readlink "$DEPLOY_ROOT/current" || true)"
ln -s "$release" "$DEPLOY_ROOT/current.next"
mv -Tf "$DEPLOY_ROOT/current.next" "$DEPLOY_ROOT/current"
# cPanel/Passenger application root must point to DEPLOY_ROOT/current.
mkdir -p tmp
touch tmp/restart.txt
if ! curl --fail --retry 10 --retry-delay 3 --retry-all-errors "$HEALTH_URL"; then
  if [[ -n "$previous" ]]; then
    ln -s "$previous" "$DEPLOY_ROOT/current.rollback"
    mv -Tf "$DEPLOY_ROOT/current.rollback" "$DEPLOY_ROOT/current"
    mkdir -p "$DEPLOY_ROOT/current/tmp"
    touch "$DEPLOY_ROOT/current/tmp/restart.txt"
  fi
  echo "Health verification failed; previous code release restored. Database migrations are forward-only." >&2
  exit 1
fi
