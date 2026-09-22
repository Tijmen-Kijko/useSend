#!/usr/bin/env python3
"""Validate the production PostgreSQL backup/restore contract."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KIJKO = ROOT / "docker" / "kijko"


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_markers(path: Path, markers: tuple[str, ...]) -> str:
    if not path.is_file():
        fail(f"missing required file: {path.relative_to(ROOT)}")
    text = path.read_text()
    for marker in markers:
        if marker not in text:
            fail(f"{path.relative_to(ROOT)} is missing required marker: {marker}")
    return text


def main() -> None:
    backup = require_markers(
        KIJKO / "postgres_backup.sh",
        (
            "pg_dump",
            "restic backup",
            "usesend-scheduled",
            "usesend-pre-migration",
            "--keep-daily 14",
            "--keep-weekly 8",
            "--keep-monthly 3",
            "--keep-within 14d",
            "USESEND_BACKUP_ALERT_WEBHOOK_URL",
            'compose ps --status running -q usesend',
            "pre-migration backup requires the UseSend application to be stopped",
        ),
    )
    restore = require_markers(
        KIJKO / "postgres_restore_verify.sh",
        (
            "restic restore",
            "--network none",
            "pg_restore --exit-on-error",
            "verification=passed",
            "core_counts",
            "core_counts_json",
            "receipt_version=1",
        ),
    )
    migrate = require_markers(
        ROOT / "docker" / "migrate.sh",
        (
            "USESEND_MIGRATION_BACKUP_REF",
            "USESEND_MIGRATION_BACKUP_RECEIPT",
            "pre-migration",
            "verified_at_epoch",
            "86400",
        ),
    )
    timer = require_markers(
        KIJKO / "systemd" / "usesend-postgres-backup.timer",
        ("OnCalendar=*-*-* 03:00:00 Europe/Amsterdam", "Persistent=true"),
    )
    require_markers(
        KIJKO / "BACKUPS.md",
        (
            "RPO",
            "24 hours",
            "RTO",
            "8 hours",
            "14 daily",
            "8 weekly",
            "3 monthly",
            "quarter",
        ),
    )
    require_markers(
        KIJKO / "backup_core_counts.sql",
        (
            "'Domain'",
            "'ApiKey'",
            "'Email'",
            "'EmailEvent'",
            "'Contact'",
            "'SuppressionList'",
            "'Webhook'",
        ),
    )

    if re.search(r"(?i)(password|secret)\s*=\s*[^<\n][^\n]*", (KIJKO / "backup.env.example").read_text()):
        fail("backup.env.example appears to contain a populated password/secret")

    if "docker compose down" in backup or "docker compose down" in restore:
        fail("backup/restore scripts must not tear down the production stack")

    print("Kijko UseSend PostgreSQL backup/restore contract: OK")


if __name__ == "__main__":
    main()
