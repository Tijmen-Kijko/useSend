#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_REF="${1:-}"
if [[ -z "$BACKUP_REF" ]]; then
  echo "Usage: $0 restic:<64-hex-snapshot-id>" >&2
  exit 64
fi

if [[ ! "$BACKUP_REF" =~ ^restic:([0-9a-f]{64})$ ]]; then
  echo "Backup reference must be restic:<64-hex-snapshot-id>" >&2
  exit 64
fi
SNAPSHOT_ID="${BASH_REMATCH[1]}"

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
DEFAULT_REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
BACKUP_ENV="${USESEND_BACKUP_ENV:-/etc/usesend/backup.env}"
RESTORE_ROOT=""
VERIFY_CONTAINER=""
started_epoch="$(date -u +%s)"

log() {
  printf '[usesend-postgres-restore-verify] %s\n' "$*" >&2
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

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$VERIFY_CONTAINER" ]]; then
    docker rm -f "$VERIFY_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RESTORE_ROOT" && -d "$RESTORE_ROOT" ]]; then
    rm -rf "$RESTORE_ROOT"
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
COUNTS_SQL="$REPO_ROOT/docker/kijko/backup_core_counts.sql"
WORK_ROOT="${USESEND_BACKUP_WORKDIR:-/home/usesend-data/backup-staging}"
RECEIPT_DIR="${USESEND_BACKUP_RECEIPT_DIR:-/home/usesend-data/backup-receipts}"

require_private_file "$PRODUCTION_ENV"
[[ -r "$COUNTS_SQL" ]] || fail "core-count SQL not found: $COUNTS_SQL"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY must be set in backup.env}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE must be set in backup.env}"
require_private_file "$RESTIC_PASSWORD_FILE"

for command_name in docker restic python3 sha256sum stat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

set -a
# shellcheck disable=SC1090
source "$PRODUCTION_ENV"
set +a
: "${POSTGRES_IMAGE:?POSTGRES_IMAGE must be set in production.env}"

install -d -m 0700 "$WORK_ROOT" "$RECEIPT_DIR"
RESTORE_ROOT="$(mktemp -d "$WORK_ROOT/restore-$SNAPSHOT_ID.XXXXXX")"

log "restoring immutable snapshot $SNAPSHOT_ID into temporary files"
restic restore "$SNAPSHOT_ID" --target "$RESTORE_ROOT" >/dev/null

mapfile -t dump_files < <(find "$RESTORE_ROOT" -type f -name postgres.dump -print)
if (( ${#dump_files[@]} != 1 )); then
  fail "expected exactly one postgres.dump in snapshot, found ${#dump_files[@]}"
fi
dump_path="${dump_files[0]}"
manifest_path="$(dirname "$dump_path")/manifest.json"
[[ -r "$manifest_path" ]] || fail "manifest.json missing next to restored dump"

read -r backup_kind backup_created_epoch expected_sha256 < <(
  python3 - "$manifest_path" <<'PY'
import json
import pathlib
import re
import sys
m = json.loads(pathlib.Path(sys.argv[1]).read_text())
kind = m.get("backup_kind")
epoch = m.get("created_at_epoch")
digest = m.get("dump_sha256")
if kind not in {"scheduled", "pre-migration"}:
    raise SystemExit("invalid backup_kind in manifest")
if not isinstance(epoch, int) or epoch <= 0:
    raise SystemExit("invalid created_at_epoch in manifest")
if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
    raise SystemExit("invalid dump_sha256 in manifest")
print(kind, epoch, digest)
PY
)

actual_sha256="$(sha256sum "$dump_path" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || fail "restored dump checksum does not match manifest"

suffix="${SNAPSHOT_ID:0:12}"
VERIFY_CONTAINER="usesend-restore-verify-$suffix-$$"
VERIFY_USER="usesend_verify"
VERIFY_DB="usesend_verify"
VERIFY_PASSWORD="verify-$(cat /proc/sys/kernel/random/uuid)"

log "starting isolated PostgreSQL verification container (no network, no host ports)"
docker run -d --rm \
  --name "$VERIFY_CONTAINER" \
  --network none \
  -e POSTGRES_USER="$VERIFY_USER" \
  -e POSTGRES_PASSWORD="$VERIFY_PASSWORD" \
  -e POSTGRES_DB="$VERIFY_DB" \
  "$POSTGRES_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$VERIFY_CONTAINER" pg_isready -U "$VERIFY_USER" -d "$VERIFY_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
(( ready == 1 )) || fail "isolated PostgreSQL verification container did not become ready"

log "restoring dump into isolated PostgreSQL"
docker exec -i "$VERIFY_CONTAINER" \
  pg_restore --exit-on-error --no-owner --no-privileges \
  -U "$VERIFY_USER" -d "$VERIFY_DB" <"$dump_path"

restored_counts="$(
  docker exec -i "$VERIFY_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U "$VERIFY_USER" -d "$VERIFY_DB" -At \
    <"$COUNTS_SQL"
)"

python3 - "$manifest_path" "$restored_counts" "$backup_kind" <<'PY'
import json
import pathlib
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
expected = manifest.get("core_counts")
actual = json.loads(sys.argv[2])
backup_kind = sys.argv[3]

if not isinstance(expected, dict) or set(expected) != set(actual):
    print("Core dataset set mismatch after restore", file=sys.stderr)
    raise SystemExit(1)

if backup_kind == "pre-migration":
    if expected != actual:
        print("Core dataset cardinality mismatch after quiesced pre-migration restore", file=sys.stderr)
        print("expected=" + json.dumps(expected, sort_keys=True), file=sys.stderr)
        print("actual=" + json.dumps(actual, sort_keys=True), file=sys.stderr)
        raise SystemExit(1)
else:
    for key in expected:
        if (expected[key] is None) != (actual[key] is None):
            print(f"Core dataset schema presence mismatch for {key}", file=sys.stderr)
            raise SystemExit(1)
PY

verified_epoch="$(date -u +%s)"
verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
duration_seconds="$((verified_epoch - started_epoch))"
counts_sha256="$(printf '%s' "$restored_counts" | sha256sum | awk '{print $1}')"
receipt_path="$RECEIPT_DIR/$SNAPSHOT_ID.receipt"
receipt_tmp="$receipt_path.tmp.$$"
umask 077
cat >"$receipt_tmp" <<EOF
receipt_version=1
backup_ref=$BACKUP_REF
snapshot_id=$SNAPSHOT_ID
backup_kind=$backup_kind
backup_created_at_epoch=$backup_created_epoch
verification=passed
verified_at_epoch=$verified_epoch
verified_at_utc=$verified_at
verification_duration_seconds=$duration_seconds
dump_sha256=$actual_sha256
core_counts_sha256=$counts_sha256
core_counts_json=$restored_counts
postgres_image=$POSTGRES_IMAGE
EOF
chmod 600 "$receipt_tmp"
mv -f "$receipt_tmp" "$receipt_path"

log "restore verification passed; receipt: $receipt_path"
printf '%s\n' "$receipt_path"
