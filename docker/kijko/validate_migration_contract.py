#!/usr/bin/env python3

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    start = (ROOT / "docker/start.sh").read_text()
    migrate = (ROOT / "docker/migrate.sh").read_text()
    dockerfile = (ROOT / "docker/Dockerfile").read_text()

    if "prisma" in start.lower() or "migrate deploy" in start.lower():
        fail("docker/start.sh must not invoke Prisma or deploy migrations")

    if "exec node apps/web/server.js" not in start:
        fail("docker/start.sh must exec the web server directly")

    required_migration_markers = (
        "migrate status",
        "migrate deploy",
        "USESEND_MIGRATION_BACKUP_REF",
        "USESEND_MIGRATION_COMPATIBILITY",
        "backward-compatible",
        "roll-forward-only",
    )
    for marker in required_migration_markers:
        if marker not in migrate:
            fail(f"docker/migrate.sh is missing required gate/operation: {marker}")

    if "pnpx" in migrate or "npx" in migrate:
        fail("docker/migrate.sh must use the Prisma CLI bundled in the image")

    if "COPY ./docker/migrate.sh ./migrate.sh" not in dockerfile:
        fail("docker/Dockerfile must copy the explicit migration command")

    print("Kijko UseSend migration contract: OK")


if __name__ == "__main__":
    main()
