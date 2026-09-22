#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_KIND="${1:-scheduled}"
case "$BACKUP_KIND" in
  scheduled|pre-migration) ;;
  *)
    echo "Usage: $0 [scheduled|pre-migration]" >&2
    exit 64
    ;;
esac

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
DEFAULT_REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
BACKUP_ENV="${USESEND_BACKUP_ENV:-/etc/usesend/backup.env}"
STAGE_DIR=""
RESTIC_LOG=""
BACKUP_SUCCEEDED=0

log() {
  printf '[usesend-postgres-backup] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_private_file() {
  local path="$1"
  local mode
  [[ -r "$path" ]] || fail "required file is not readable: $path"
  mode="$(stat -c '%a' "$path")"
  case "$mode" in
    400|600) ;;
    *) fail "$path must be mode 400 or 600 (found $mode)" ;;
  esac
}

send_failure_alert() {
  local host payload
  if [[ -z "${USESEND_BACKUP_ALERT_WEBHOOK_URL:-}" ]]; then
    log "WARNING: backup failed and USESEND_BACKUP_ALERT_WEBHOOK_URL is not configured"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log "WARNING: backup failed and curl is unavailable for alert delivery"
    return 1
  fi
  host="$(hostname -f 2>/dev/null || hostname)"
  payload="$(python3 - "$host" "$BACKUP_KIND" <<'PY'
import json
import sys
print(json.dumps({
    "event": "usesend_postgres_backup_failed",
    "host": sys.argv[1],
    "backup_kind": sys.argv[2],
}))
PY
)"
  curl --fail --silent --show-error --max-time 15 \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" \
    "$USESEND_BACKUP_ALERT_WEBHOOK_URL" >/dev/null
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
  if [[ -n "$RESTIC_LOG" && -f "$RESTIC_LOG" ]]; then
    rm -f "$RESTIC_LOG"
  fi
  if (( rc != 0 )) && (( BACKUP_SUCCEEDED == 0 )); then
    send_failure_alert || true
  fi
  exit "$rc"
}
trap cleanup EXIT

require_private_file "$BACKUP_ENV"
set -a
# shellcheck disable=SC1090
source "$BACKUP_ENV"
set +a

REPO_ROOT="${USESEND_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
PRODUCTION_ENV="${USESEND_PRODUCTION_ENV:-/etc/usesend/production.env}"
COMPOSE_FILE="$REPO_ROOT/docker/kijko/compose.yml"
COUNTS_SQL="$REPO_ROOT/docker/kijko/backup_core_counts.sql"
WORK_ROOT="${USESEND_BACKUP_WORKDIR:-/home/usesend-data/backup-staging}"

require_private_file "$PRODUCTION_ENV"
[[ -r "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"
[[ -r "$COUNTS_SQL" ]] || fail "core-count SQL not found: $COUNTS_SQL"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY must be set in backup.env}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE must be set in backup.env}"
: "${USESEND_BACKUP_ALERT_WEBHOOK_URL:?USESEND_BACKUP_ALERT_WEBHOOK_URL must be set in backup.env}"
require_private_file "$RESTIC_PASSWORD_FILE"

for command_name in docker restic python3 sha256sum curl stat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

set -a
# shellcheck disable=SC1090
source "$PRODUCTION_ENV"
set +a
: "${POSTGRES_USER:?POSTGRES_USER must be set in production.env}"
: "${POSTGRES_DB:?POSTGRES_DB must be set in production.env}"

compose() {
  docker compose --env-file "$PRODUCTION_ENV" -f "$COMPOSE_FILE" "$@"
}

if [[ "$BACKUP_KIND" == "pre-migration" ]]; then
  running_usesend="$(compose ps --status running -q usesend)"
  if [[ -n "$running_usesend" ]]; then
    fail "pre-migration backup requires the UseSend application to be stopped"
  fi
fi

if ! compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null; then
  fail "production PostgreSQL is not ready"
fi

install -d -m 0700 "$WORK_ROOT"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
created_epoch="$(date -u +%s)"
STAGE_DIR="$(mktemp -d "$WORK_ROOT/usesend-postgres-$timestamp.XXXXXX")"
RESTIC_LOG="$(mktemp "$WORK_ROOT/restic-$timestamp.XXXXXX.json")"
dump_path="$STAGE_DIR/postgres.dump"
counts_path="$STAGE_DIR/core-counts.json"
manifest_path="$STAGE_DIR/manifest.json"

log "creating consistent PostgreSQL dump ($BACKUP_KIND)"
compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$dump_path"
[[ -s "$dump_path" ]] || fail "pg_dump produced an empty artifact"

core_counts="$(
  compose exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
    <"$COUNTS_SQL"
)"
python3 - "$core_counts" "$counts_path" <<'PY'
import json
import pathlib
import sys
data = json.loads(sys.argv[1])
pathlib.Path(sys.argv[2]).write_text(json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n")
PY

dump_sha256="$(sha256sum "$dump_path" | awk '{print $1}')"
git_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
python3 - "$manifest_path" "$BACKUP_KIND" "$timestamp" "$created_epoch" "$dump_sha256" "$git_sha" "$counts_path" <<'PY'
import json
import pathlib
import sys
manifest_path, kind, created_at, created_epoch, digest, git_sha, counts_path = sys.argv[1:]
manifest = {
    "format_version": 1,
    "backup_kind": kind,
    "created_at_utc": created_at,
    "created_at_epoch": int(created_epoch),
    "dump_sha256": digest,
    "source_git_sha": git_sha,
    "core_counts": json.loads(pathlib.Path(counts_path).read_text()),
}
pathlib.Path(manifest_path).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
PY

tag="usesend-$BACKUP_KIND"
log "uploading encrypted artifact to Restic repository with tag $tag"
restic backup "$STAGE_DIR" --tag "$tag" --json >"$RESTIC_LOG"

snapshot_id="$(
  python3 - "$RESTIC_LOG" <<'PY'
import json
import pathlib
import re
import sys
snapshot = None
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    try:
        item = json.loads(line)
    except json.JSONDecodeError:
        continue
    if item.get("message_type") == "summary" and item.get("snapshot_id"):
        snapshot = item["snapshot_id"]
if not snapshot or not re.fullmatch(r"[0-9a-f]{64}", snapshot):
    raise SystemExit("restic did not return a full immutable snapshot id")
print(snapshot)
PY
)"

restic snapshots "$snapshot_id" --json >/dev/null

if [[ "$BACKUP_KIND" == "scheduled" ]]; then
  log "applying scheduled retention: 14 daily / 8 weekly / 3 monthly"
  restic forget --tag usesend-scheduled \
    --keep-daily 14 --keep-weekly 8 --keep-monthly 3 --prune >&2
else
  log "retaining pre-migration recovery points for at least 14 days"
  restic forget --tag usesend-pre-migration --keep-within 14d >&2
fi

BACKUP_SUCCEEDED=1
backup_ref="restic:$snapshot_id"
log "backup complete: $backup_ref"
printf '%s\n' "$backup_ref"
