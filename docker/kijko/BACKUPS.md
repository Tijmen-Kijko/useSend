# PostgreSQL backup, restore, and recovery policy

This runbook is the USESEND-12 recovery contract for the central Kijko
UseSend instance. It deliberately keeps the operating model small: PostgreSQL
stays in the existing Compose stack, backups are logical `pg_dump -Fc`
artifacts, and Restic sends those artifacts encrypted to an off-host Hetzner
Storage Box repository.

## Recovery objectives

The initial operating targets are intentionally proportional to the current
internal-only UseSend deployment:

- normal **RPO: 24 hours**;
- migration RPO: the verified pre-migration recovery point created immediately
  before the migration window;
- initial **RTO objective: 8 hours** from declaring database recovery until the
  restored application is serviceable;
- one scheduled backup every night;
- one additional backup immediately before every production migration;
- scheduled retention: **14 daily / 8 weekly / 3 monthly** recovery points;
- pre-migration recovery points remain for at least 14 days;
- a full restore verification is required before every migration and at least
  once per quarter even when no migration occurs.

The measured restore duration belongs in the operational evidence. If a real
restore exceeds the 8-hour objective, adjust the procedure or explicitly revise
the objective; do not report the target as achieved merely because it is
documented.

## Why this method

`pg_dump -Fc` produces a consistent logical backup while PostgreSQL remains
online and restores through `pg_restore`. Restic provides encrypted,
content-addressed off-host storage and retention without adding another service
to `docker/kijko/compose.yml`.

RAID1 under `/home/usesend-data/postgres` protects against a single disk
failure; it is not a backup. The Restic repository is therefore authoritative
for disaster recovery. Local dump files exist only in a root-only staging
directory and are removed when each job exits.

## 1. Provision the off-host repository once

Use a dedicated Hetzner Storage Box account or sub-account and an SSH key that
is used only for this backup repository. Do not put SSH private keys, Restic
passwords, Storage Box credentials, or populated URLs in this repository.

Install the host dependencies:

```bash
sudo apt-get install restic
```

Create root-only configuration outside the repository:

```bash
sudo install -d -m 0700 /etc/usesend
sudo install -d -m 0700 /home/usesend-data/backup-staging
sudo install -d -m 0700 /home/usesend-data/backup-receipts

sudo cp docker/kijko/backup.env.example /etc/usesend/backup.env
sudo chmod 600 /etc/usesend/backup.env

sudo install -m 0600 /dev/null /etc/usesend/restic-password
# Populate the password through the approved secret workflow.

sudo chmod 600 /etc/usesend/production.env
```

Set `USESEND_REPO_ROOT`, the Storage Box `RESTIC_REPOSITORY`, the
`RESTIC_PASSWORD_FILE`, and the external backup-failure webhook in
`/etc/usesend/backup.env`.

Keep an independent recovery copy of the Restic repository password and the
Storage Box access material outside this host. Losing both the server and the
only decryption credential would make the off-host backup useless.

Initialize the repository once:

```bash
sudo --preserve-env=USESEND_BACKUP_ENV bash -c '
  set -a
  . /etc/usesend/backup.env
  set +a
  restic init
'
```

Do not run `restic init` automatically from the backup job. A changed or
mistyped repository must fail closed rather than silently creating a new empty
backup destination.

## 2. Nightly scheduled backup

Install the reviewed script and timer:

```bash
sudo ln -sfn "$(pwd)/docker/kijko/postgres_backup.sh" \
  /usr/local/sbin/usesend-postgres-backup
sudo cp docker/kijko/systemd/usesend-postgres-backup.service /etc/systemd/system/
sudo cp docker/kijko/systemd/usesend-postgres-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now usesend-postgres-backup.timer
```

The timer runs at 03:00 Europe/Amsterdam and is persistent across host
downtime. Each successful scheduled run:

1. checks that PostgreSQL is ready;
2. creates a custom-format logical dump;
3. captures row counts for the recovery-critical datasets;
4. records the dump SHA-256 in the backup manifest;
5. uploads dump + manifest to Restic with the `usesend-scheduled` tag;
6. verifies Restic can address the returned full snapshot ID;
7. applies 14-daily / 8-weekly / 3-monthly retention.

The local staging directory is deleted on both success and failure.

Run a manual scheduled backup with:

```bash
sudo USESEND_BACKUP_ENV=/etc/usesend/backup.env \
  docker/kijko/postgres_backup.sh scheduled
```

The only stdout value on success is the immutable reference:

```text
restic:<64-hex-snapshot-id>
```

## 3. Backup-failure alerting

`USESEND_BACKUP_ALERT_WEBHOOK_URL` is mandatory in `backup.env`. When the
backup exits unsuccessfully, the script attempts an external JSON event with
`event=usesend_postgres_backup_failed`.

USESEND-16 owns the final receiver, routing, escalation, and monitoring policy.
The backup job does not introduce a second alerting platform. Production
acceptance requires proving that the configured receiver actually surfaces a
failed backup; a local log entry alone is not sufficient evidence.

## 4. Pre-migration backup and restore gate

For an upgrade, first stop the current UseSend application as required by
`MIGRATIONS.md`, while leaving PostgreSQL running. The backup script checks
this condition and refuses a `pre-migration` backup while the Compose UseSend
service is still running. Then create the dedicated recovery point:

```bash
BACKUP_REF="$(
  sudo USESEND_BACKUP_ENV=/etc/usesend/backup.env \
    docker/kijko/postgres_backup.sh pre-migration
)"
```

A pre-migration snapshot is tagged `usesend-pre-migration` and retained for at
least 14 days.

Verify that exact immutable snapshot by restoring it to a new disposable
PostgreSQL container:

```bash
RECEIPT="$(
  sudo USESEND_BACKUP_ENV=/etc/usesend/backup.env \
    docker/kijko/postgres_restore_verify.sh "$BACKUP_REF"
)"
```

The verification container:

- has no host ports;
- uses Docker `--network none`;
- has no production data volume mounted;
- restores the custom-format dump with `pg_restore --exit-on-error`;
- verifies the dump SHA-256;
- for quiesced pre-migration backups, compares restored row counts exactly
  with the source manifest for domains, API-key metadata rows, emails, email
  events, contacts, suppressions, webhooks, webhook calls, and Prisma migration
  records;
- for scheduled backups, verifies the same dataset/table presence and records
  the restored counts without requiring equality with a later live-source count
  (writes may legitimately occur while the online dump is being created).

The script never writes to the production PostgreSQL database. On success it
writes a root-only receipt under
`/home/usesend-data/backup-receipts/<snapshot-id>.receipt`.

The receipt contains no application records or credentials. It records only
verification metadata plus row counts for the recovery-critical datasets so the
restore evidence remains independently reviewable.

## 5. Migration gate

`docker/migrate.sh deploy` accepts only a Restic snapshot reference backed by
a matching restore-verification receipt. Both the backup creation time and
restore-verification time must be no more than 24 hours old, and the receipt
must identify a `pre-migration` backup.

Mount the receipt read-only into the candidate image:

```bash
USESEND_MIGRATION_BACKUP_REF="$BACKUP_REF" \
USESEND_MIGRATION_COMPATIBILITY="$COMPATIBILITY" \
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  run --rm --no-deps \
  -e USESEND_MIGRATION_BACKUP_REF \
  -e USESEND_MIGRATION_COMPATIBILITY \
  -e USESEND_MIGRATION_BACKUP_RECEIPT=/run/usesend-backup.receipt \
  -v "$RECEIPT:/run/usesend-backup.receipt:ro" \
  usesend sh /app/migrate.sh deploy
```

The migration refuses to run when the reference is malformed, the receipt is
missing, the receipt belongs to another snapshot, the snapshot is not
pre-migration, verification did not pass, or either backup/verification is
stale.

## 6. Quarterly restore verification

At least once per quarter, choose a recent scheduled snapshot explicitly and
run:

```bash
restic snapshots --tag usesend-scheduled
sudo USESEND_BACKUP_ENV=/etc/usesend/backup.env \
  docker/kijko/postgres_restore_verify.sh \
  restic:<full-snapshot-id>
```

Record the snapshot ID, verification timestamp, duration, result, and ticket or
incident reference in the operational evidence. Receipts are evidence of a
specific test; they do not themselves extend backup retention.

## 7. Recovery after failure

### Backward-compatible migration

If the database migration is backward-compatible, prefer application rollback:
restore `USESEND_PREVIOUS_IMAGE` and keep the migrated database. The verified
backup remains the disaster-recovery point if later database corruption is
found.

### Roll-forward-only migration

Do not start the previous application against a database classified as
roll-forward-only. Prefer a reviewed corrective migration/application release.

If database rollback is required, keep the application stopped. Restore the
verified pre-migration Restic snapshot into a clean PostgreSQL environment
first, repeat the integrity/cardinality checks, then replace/recover the
production database through an explicitly reviewed incident procedure before
starting the previous image. Never run a destructive restore over the live
production database as a verification step.

## 8. Cleanup and evidence

Restic enforces scheduled retention automatically. Pre-migration snapshots use
a separate tag so the daily retention job cannot accidentally discard the
release recovery point; those snapshots are kept for at least 14 days.

Keep verification receipts only as operational evidence. They are small and
contain no customer content. It is safe to remove receipts after their
corresponding Restic snapshot is no longer retained and release evidence has
been captured.

For every production migration retain:

- candidate Git SHA and OCI digest;
- compatibility classification;
- full `restic:<snapshot-id>` backup reference;
- successful restore-verification receipt timestamp and duration;
- migration status before and after;
- application health/send-path result;
- recovery rehearsal result.
