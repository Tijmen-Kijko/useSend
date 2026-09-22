# Kijko production deployment

This directory is the production deployment contract for the central
`usesend.kijko.nl` instance on the current Kijko/Hetzner host.

## Architecture

- one UseSend application container;
- one dedicated PostgreSQL container;
- one dedicated Redis container;
- PostgreSQL and Redis have no host ports;
- UseSend is published only on host loopback (default `127.0.0.1:3400`);
- Cloudflare/reverse-proxy policy sits in front of that loopback service;
- persistent state lives under `/home/usesend-data` on host RAID1;
- AWS SES/SNS remains the external mail transport/event service;
- object storage is optional and is not deployed by this compose file.

The `backend` Docker network is internal. Only the UseSend application also
joins the normal `edge` network so it can reach GitHub/AWS and accept traffic
from the host-published loopback port.

## Why MinIO is not included

UseSend's S3-compatible configuration is optional. Without it, transactional
email and the core dashboard/API remain usable; only template/campaign image
uploads are unavailable. If that feature is needed later, configure a dedicated
S3-compatible service through the five `S3_COMPATIBLE_*` variables rather
than exposing a local MinIO console/API with default credentials.

## Host preparation

The storage audit for this host selected the `/home` filesystem for durable
UseSend state. Create the directories before first start:

```bash
sudo install -d -m 0750 /home/usesend-data
sudo install -d -m 0750 /home/usesend-data/postgres
sudo install -d -m 0750 /home/usesend-data/redis
sudo install -d -m 0750 /etc/usesend
```

Copy `production.env.example` to `/etc/usesend/production.env`, fill it
through the approved secret-management workflow, and restrict permissions:

```bash
sudo chmod 600 /etc/usesend/production.env
```

Do not add the populated file to this repository.

## Validate before any deployment

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  config --quiet
```

The configuration intentionally requires explicit image references. The UseSend
application reference must be the canonical OCI digest defined in `RELEASES.md`;
`validate_compose.py` rejects tag-based UseSend production references. Also
validate that application startup cannot silently regain migration behaviour:

```bash
python3 docker/kijko/validate_migration_contract.py
```

## Start

Application startup no longer runs Prisma migrations. Controlled migration,
compatibility, failure, and recovery procedures are defined in `MIGRATIONS.md`.
Image publication, digest promotion, and image rollback policy are defined in
`RELEASES.md`.

> First production initialization and any migration-bearing release remain
> blocked until USESEND-12 provides the required PostgreSQL backup and verified
> restore gate. Do not bypass that dependency by inventing a backup reference.

Once the database is initialized/migrated through the controlled procedure:

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  up -d
```

UseSend will listen only on `127.0.0.1:3400` by default. The public hostname
must be served through the Cloudflare/reverse-proxy route policy defined by
USESEND-3/USESEND-15.

## Persistence and recovery boundary

- PostgreSQL: `/home/usesend-data/postgres`
- Redis: `/home/usesend-data/redis`
- container images/logs: Docker root filesystem

Docker named volumes are deliberately not used for these two stateful services.
Backup/restore and queue-loss recovery are handled by USESEND-12/USESEND-13.

## Logging

All services use bounded Docker JSON logs (20 MB x 5 files) to prevent an
unbounded container log from filling the root filesystem. Central log/metric
shipping and disk alerts are handled by USESEND-16.

## Network exposure check

After deployment, these checks must hold:

```bash
ss -ltnp | grep ':3400'
# expected: 127.0.0.1:3400 only

ss -ltnp | grep -E ':(5432|6379)\b'
# expected: no UseSend Postgres/Redis host listeners
```
