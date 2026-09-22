#!/usr/bin/env python3
"""Validate the security invariants of docker/kijko/compose.yml.

Run with the same environment variables used by Docker Compose. This command
never starts containers; it only renders and inspects the Compose model.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

COMPOSE_FILE = Path(__file__).with_name("compose.yml")


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def render_compose() -> dict:
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(COMPOSE_FILE),
            "config",
            "--format",
            "json",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def main() -> None:
    config = render_compose()
    services = config.get("services", {})

    expected_services = {"postgres", "redis", "usesend"}
    if set(services) != expected_services:
        fail(
            f"expected services {sorted(expected_services)}, "
            f"got {sorted(services)}"
        )

    usesend_image = services["usesend"].get("image", "")
    immutable_image = re.fullmatch(
        r"ghcr\.io/tijmen-kijko/usesend@sha256:[0-9a-f]{64}",
        usesend_image,
    )
    if immutable_image is None:
        fail(
            "usesend image must be the canonical digest-pinned "
            "ghcr.io/tijmen-kijko/usesend@sha256:<digest> reference"
        )

    for service_name in ("postgres", "redis"):
        if services[service_name].get("ports"):
            fail(f"{service_name} must not publish host ports")

    usesend_ports = services["usesend"].get("ports", [])
    if len(usesend_ports) != 1:
        fail("usesend must publish exactly one host port")

    port = usesend_ports[0]
    if (
        port.get("host_ip") != "127.0.0.1"
        or int(port.get("target", 0)) != 3000
    ):
        fail("usesend must only publish container port 3000 on 127.0.0.1")

    backend = config.get("networks", {}).get("backend", {})
    if backend.get("internal") is not True:
        fail("backend network must remain internal")

    data_root = Path(
        services["postgres"]["volumes"][0].get("source", "")
    ).parent
    expected_root = Path("/home/usesend-data")
    if data_root != expected_root:
        fail(f"postgres state must live under {expected_root}")

    redis_source = Path(services["redis"]["volumes"][0].get("source", ""))
    if redis_source.parent != expected_root:
        fail(f"redis state must live under {expected_root}")

    print("Kijko UseSend compose security invariants: OK")


if __name__ == "__main__":
    main()
