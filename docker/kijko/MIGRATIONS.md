# Controlled Prisma migrations

Production application startup and database migration are separate operations.
The UseSend container starts the web server only. Prisma migrations run only
through the explicit `/app/migrate.sh` command from the exact candidate image.

## Safety invariants

- `docker/start.sh` never runs Prisma or changes the database schema.
- `migrate.sh status` is read-only and may be run without an approval gate.
- `migrate.sh deploy` refuses to run unless the operator supplies both:
  - `USESEND_MIGRATION_BACKUP_REF`: the identifier of a verified
    pre-migration backup/snapshot;
  - `USESEND_MIGRATION_COMPATIBILITY`: either `backward-compatible` or
    `roll-forward-only`.
- The migration command uses the Prisma CLI bundled in the candidate image. It
  does not download a different Prisma version at deployment time.
- A failed migration exits non-zero. The release procedure stops there; the new
  application image is not started automatically.
- Production migration is blocked until USESEND-12 provides a verified backup
  and restore workflow. A backup reference is evidence, not a substitute for
  actually verifying the backup.

## 1. Review the candidate schema before downtime

Compare the currently deployed commit to the candidate commit:

```bash
git diff <production-commit>..<candidate-commit> -- \
  apps/web/prisma/schema.prisma \
  apps/web/prisma/migrations/
```

Review every new `migration.sql` for destructive statements, table rewrites,
long-running locks, index creation, data backfills, and constraints that can
reject existing rows.

Record one compatibility classification:

- `backward-compatible`: the previous application image can still run against
  the post-migration database. Image-only rollback remains possible.
- `roll-forward-only`: the migration makes the previous application unsafe or
  incompatible. Recovery must use a corrected forward release or restore the
  verified pre-migration database backup before restoring the previous image.

If the effect is uncertain, classify it as `roll-forward-only`.

## 2. Rehearse on a non-production database

Before production, use the exact candidate digest against a disposable or
pre-production PostgreSQL database.

The rehearsal must include:

1. `migrate.sh status` before the change;
2. a backup of the non-production database;
3. `migrate.sh deploy` with the backup reference and compatibility
   classification;
4. `migrate.sh status` after deploy;
5. candidate application health and representative send-path checks;
6. recovery rehearsal:
   - for `backward-compatible`, run the previous app image against the
     migrated database;
   - for `roll-forward-only`, restore the pre-migration backup into a fresh
     database and verify the previous image against that restored database.

Keep the rehearsal output with the release evidence. Do not infer production
rollback safety only from the SQL review.

## 3. Prepare production without starting the candidate app

Set the candidate digest in `/etc/usesend/production.env` only after preserving
the current production digest in `USESEND_PREVIOUS_IMAGE`, as described in
`RELEASES.md`.

Validate the deployment contract:

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  config --quiet

set -a
. /etc/usesend/production.env
set +a
python3 docker/kijko/validate_compose.py
python3 docker/kijko/validate_migration_contract.py
```

Start only the stateful dependencies and pull the candidate image:

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  up -d postgres redis

docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  pull usesend
```

For an upgrade, stop the current application before the backup so application
writes and background workers are quiesced:

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  stop usesend
```

## 4. Backup/restore gate

Use the USESEND-12 procedure to create a pre-migration PostgreSQL backup or
snapshot and complete its restore verification. Record its immutable identifier
as `BACKUP_REF`.

Do not proceed with `migrate deploy` when:

- the backup job failed;
- restore verification is stale or failed;
- the backup cannot be associated with this release window; or
- the operator cannot identify the exact recovery artifact.

Example shell variables after the gate has passed:

```bash
BACKUP_REF='<verified-backup-or-snapshot-id>'
COMPATIBILITY='backward-compatible' # or: roll-forward-only
```

These are one-shot release approvals. Do not persist
`USESEND_MIGRATION_BACKUP_REF` or `USESEND_MIGRATION_COMPATIBILITY` in
`production.env`; inject them only into the explicit migration container.

## 5. Inspect and apply migrations explicitly

Inspect migration state using the candidate image:

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  run --rm --no-deps usesend \
  sh /app/migrate.sh status
```

Prisma may return a non-zero status when migrations are pending; review the
reported migration names before continuing.

Apply only after the backup and compatibility gates:

```bash
USESEND_MIGRATION_BACKUP_REF="$BACKUP_REF" \
USESEND_MIGRATION_COMPATIBILITY="$COMPATIBILITY" \
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  run --rm --no-deps \
  -e USESEND_MIGRATION_BACKUP_REF \
  -e USESEND_MIGRATION_COMPATIBILITY \
  usesend sh /app/migrate.sh deploy
```

Then verify migration state:

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  run --rm --no-deps usesend \
  sh /app/migrate.sh status
```

Only a successful deploy followed by the expected status permits application
rollout.

## 6. Start the candidate application

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  up -d --no-deps usesend
```

Verify the health endpoint, dashboard authentication, representative API send,
Redis-backed queue/rate-limit behaviour, and the expected Git SHA/digest.

## 7. Failure and recovery

### Migration fails before the candidate app starts

Do not start the candidate application. Preserve the Prisma error output and
inspect database state. Do not rerun commands blindly.

Prisma `migrate deploy` does not provide an automatic down-migration, and
`prisma migrate reset` must never be used against production.

If no migration was applied, restart the previous image after confirming the
database is unchanged. If a migration was partially or fully applied, follow
the pre-reviewed compatibility path below.

### Backward-compatible migration

Set `USESEND_IMAGE` back to the exact `USESEND_PREVIOUS_IMAGE` digest,
revalidate Compose, start the previous application, and verify service health.
The migrated schema remains in place.

### Roll-forward-only migration

Do not start the previous application against the migrated database. Prefer a
reviewed corrective forward migration/application release when feasible.

If database rollback is required, keep the application stopped, restore the
verified `BACKUP_REF` using the USESEND-12 restore procedure, verify database
integrity, set `USESEND_IMAGE` to `USESEND_PREVIOUS_IMAGE`, then start and
verify the previous application.

Any manual use of `prisma migrate resolve` during incident recovery requires a
separate review of the actual database state; it is not a normal rollback
mechanism.
