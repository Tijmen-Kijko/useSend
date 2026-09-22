# Kijko UseSend release and upgrade policy

This document defines how the canonical `Tijmen-Kijko/useSend` repository is
turned into a production image for `usesend.kijko.nl`. Publication and
production promotion are deliberately separate operations.

## Release invariants

- Only commits on `main` in `Tijmen-Kijko/useSend` may publish the Kijko
  UseSend image.
- The publisher builds `docker/Dockerfile` for `linux/amd64` and publishes
  only to `ghcr.io/tijmen-kijko/usesend`.
- Every published commit gets exactly one tag:
  `sha-<full-40-character-git-sha>`.
- A pre-existing SHA tag is never overwritten. A rerun must resolve to an image
  whose OCI revision label equals the same Git SHA or the workflow fails.
- GitHub Actions records the resulting OCI digest and the digest-pinned image
  reference in the job summary.
- Production never consumes `:latest`, a moving upstream tag, or a branch
  name. Production uses
  `ghcr.io/tijmen-kijko/usesend@sha256:<64-hex-digest>`.
- Publishing an image does not deploy it. There is no automatic production
  promotion after a merge.

## 1. Publish from canonical main

Merging an approved change to canonical `main` triggers
`.github/workflows/kijko-image.yml`. A manual workflow dispatch is also
allowed, but the publish job runs only when the repository is
`Tijmen-Kijko/useSend` and the selected ref is `main`.

For each release candidate, retain this evidence:

1. Git commit SHA.
2. Immutable SHA tag.
3. OCI digest / digest-pinned image reference.
4. GitHub Actions run URL.
5. Prisma/schema review decision for the release.
6. Pre-production test result and production promotion timestamp.

The digest, not the tag, is the artifact identity used for promotion.

## 2. Pre-production gate

Before production promotion, deploy the exact candidate digest to
pre-production. Do not rebuild between pre-production and production.

At minimum verify:

- container starts with the intended environment and no unexpected migration;
- `/api/health` succeeds;
- dashboard authentication works for an allowed identity;
- a representative API send succeeds through the intended SES path;
- Redis-backed rate limiting and queue behaviour are healthy;
- the application reports or can be traced back to the expected Git SHA.

Any material failure rejects the digest. Fix the source, merge a new commit, and
publish a new digest rather than retagging or replacing the failed artifact.

## 3. Schema and migration review gate

Before every production promotion, compare the candidate with the currently
running production commit and explicitly inspect changes under
`apps/web/prisma/`, especially `apps/web/prisma/migrations/`.

Classify the release as either:

- **No database migration:** application rollout may proceed after the normal
  pre-production gate.
- **Database migration required:** follow the controlled migration procedure in
  `docker/kijko/MIGRATIONS.md` before replacing the application container.

For a migration release, review at least:

- whether SQL is additive or destructive;
- table rewrites, long locks, index-build impact, and expected runtime;
- backward compatibility with both the current and candidate application;
- backup/restore readiness;
- whether application rollback remains safe after the migration.

A migration that makes the previous application incompatible removes simple
image rollback as a safe recovery mechanism. In that case the release plan must
prefer roll-forward or an explicitly tested database restore path.

## 4. Manual production promotion

The operator promotes a digest only after the pre-production and schema gates
pass.

The production environment keeps both the candidate and the immediately
previous digest:

```dotenv
USESEND_IMAGE=ghcr.io/tijmen-kijko/usesend@sha256:<candidate-digest>
USESEND_PREVIOUS_IMAGE=ghcr.io/tijmen-kijko/usesend@sha256:<previous-production-digest>
```

Before editing `/etc/usesend/production.env`, capture the currently deployed
`USESEND_IMAGE` and copy that exact digest-pinned reference into
`USESEND_PREVIOUS_IMAGE`. Never reconstruct the previous target from a tag.

Then validate the rendered deployment before starting anything:

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

When the candidate contains database migrations, complete
`docker/kijko/MIGRATIONS.md` first. That runbook deliberately separates backup,
migration, and application rollout; a failed migration must not start the new
application. After the migration gate has passed when applicable, pull and roll
out the exact digest:

```bash
docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  pull usesend

docker compose \
  --env-file /etc/usesend/production.env \
  -f docker/kijko/compose.yml \
  up -d --no-deps usesend
```

Verify health and representative send behaviour again after promotion. Record
the promoted Git SHA and digest in the release evidence.

## 5. Rollback

Application rollback is allowed only when the database state remains compatible
with the previous application image.

To roll back:

1. Confirm the migration review says the previous application is compatible
   with the current database state.
2. Swap `USESEND_IMAGE` to the exact value stored in
   `USESEND_PREVIOUS_IMAGE`.
3. Preserve the failed candidate digest in the release record; do not delete or
   retag it.
4. Re-run Compose rendering and `validate_compose.py`.
5. Pull and restart only the UseSend application service.
6. Verify health, authentication, API send, and queue behaviour.

If the database is no longer backward compatible, do not perform an image-only
rollback. Use the reviewed roll-forward or database restore plan instead.

## 6. Upstream UseSend updates

The `upstream` remote may be fetched and reviewed regularly, but upstream
changes never flow directly to production.

For every upstream sync:

1. Fetch `usesend/useSend` and inspect the exact commit range.
2. Review application, authentication, mail path, dependency, Dockerfile, and
   Prisma migration changes.
3. Merge or cherry-pick the reviewed update into the canonical repository.
4. Run the repository test suite and security/deployment validation.
5. Merge through the normal canonical `main` review path.
6. Let the canonical image workflow publish a new SHA-tagged image and digest.
7. Repeat the pre-production, schema, and manual production-promotion gates.

Never configure production to follow upstream `:latest`, an upstream release
tag, or an upstream GHCR/DockerHub image directly.
