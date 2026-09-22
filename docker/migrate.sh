#!/bin/sh

set -eu

PRISMA_BIN="${PRISMA_BIN:-./node_modules/.bin/prisma}"
PRISMA_SCHEMA="${PRISMA_SCHEMA:-./apps/web/prisma/schema.prisma}"

usage() {
  cat <<'EOF'
Usage:
  sh /app/migrate.sh status
  USESEND_MIGRATION_BACKUP_REF=<verified-backup-ref> \
  USESEND_MIGRATION_COMPATIBILITY=<backward-compatible|roll-forward-only> \
    sh /app/migrate.sh deploy
EOF
}

: "${DATABASE_URL:?DATABASE_URL must be set for Prisma migration operations}"

case "${1:-}" in
  status)
    exec "$PRISMA_BIN" migrate status --schema "$PRISMA_SCHEMA"
    ;;

  deploy)
    backup_ref="${USESEND_MIGRATION_BACKUP_REF:-}"
    compatibility="${USESEND_MIGRATION_COMPATIBILITY:-}"

    if [ -z "$backup_ref" ]; then
      echo "Refusing migration: USESEND_MIGRATION_BACKUP_REF must identify a verified pre-migration backup." >&2
      exit 64
    fi

    case "$compatibility" in
      backward-compatible|roll-forward-only)
        ;;
      *)
        echo "Refusing migration: USESEND_MIGRATION_COMPATIBILITY must be backward-compatible or roll-forward-only." >&2
        exit 64
        ;;
    esac

    echo "Applying Prisma migrations after backup gate: $backup_ref"
    echo "Schema compatibility classification: $compatibility"
    exec "$PRISMA_BIN" migrate deploy --schema "$PRISMA_SCHEMA"
    ;;

  *)
    usage >&2
    exit 64
    ;;
esac
