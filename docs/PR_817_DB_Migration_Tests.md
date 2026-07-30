# Database Migration Tests

## Summary

Adds a dedicated CI workflow that validates all 22 Prisma migrations apply cleanly forward against a fresh PostgreSQL database, with drift detection and seed verification.

## Changes

### New: `.github/workflows/db-migrations.yml`

A CI job that runs on every push/PR to `main`:

| Step | What it does | Why it matters |
|------|-------------|----------------|
| **Postgres service** | Spins up `postgres:16-alpine` with healthcheck | Matches production DB version (`docker-compose.yml` uses `postgres:16-alpine`) |
| **Prisma generate** | Generates `@prisma/client` from the schema | Required before any Prisma commands |
| **Prisma migrate deploy** | Applies all 22 pending migrations in order | Confirms each `migration.sql` runs without error on a clean DB |
| **Prisma db validate** | Checks the Prisma schema matches the DB schema | Catches manual DB changes that drift from the schema |
| **Drift detection** | `prisma migrate diff --exit-code` compares migrations vs schema datamodel | Fails CI if schema and migrations are out of sync |
| **Seed script** | Runs `seed.ts` with test credentials | Verifies seed logic against the migrated schema |

### New: `packages/api/prisma/migrations/migration_lock.toml`

The `migration_lock.toml` was missing from the repository, which can cause `prisma migrate deploy` to fail in CI environments. Added with `providers = ["postgresql"]` to match the schema datasource.

## Acceptance Criteria

- [x] Migrations apply cleanly in CI against a fresh PostgreSQL database
- [x] Drift detection (`migrate diff --exit-code`) fails CI when schema and migrations diverge
- [x] `prisma db validate` confirms the in-database schema matches `schema.prisma`
- [x] Seed scripts run successfully post-migration
- [x] `migration_lock.toml` is committed so CI doesn't block on its absence

## Files

| File | Action |
|------|--------|
| `.github/workflows/db-migrations.yml` | **Added** — CI workflow |
| `packages/api/prisma/migrations/migration_lock.toml` | **Added** — required by `prisma migrate deploy` |
| `docs/PR_817_DB_Migration_Tests.md` | **Added** — this document |

closes #817
