# Backups — plan (not started)

Nightly encrypted logical dumps of Postgres pushed off-box to Backblaze
B2, on the five-dollar box, with retention and a restore drill. Decided
2026-09-02; nothing below is built yet. Companion to README "Deploy" and
STATE.md "Not started".

## Why this shape

The database is ~11 MB and lives in one docker volume on one Linode
nanode. Today's backup is a manual download to a workstation. The Linode
Backups add-on (already on) is a daily whole-disk snapshot: same provider,
whole-box restore, keep it but don't rely on it alone. At this volume a
logical dump is the right primitive: `pg_dump` is exact, portable across
Postgres versions, and small enough that a year of dailies fits inside
B2's free ten gigabytes. WAL archiving / point-in-time recovery
(pgBackRest, WAL-G) is deliberately deferred: another daemon and mental
model for an up-to-one-day loss window that is acceptable here.

## Design

**Gate:** the whole lane is off unless `BACKUP_AGE_PUBKEY` is set in the
box's `/opt/virtu/.env`. No pubkey → `bin/db-backup` exits 0 with "backups
disabled" and the cron line is a no-op. Dumps are encrypted to that public
key with `age`; the matching private key lives ONLY on the operator's
workstation (never on the box), so a compromised box leaks ciphertext.

**Env (box `/opt/virtu/.env`):**

- `BACKUP_AGE_PUBKEY` — `age1…` recipient; the gate.
- `BACKUP_B2_BUCKET` — bucket name (private).
- `BACKUP_B2_KEY_ID` / `BACKUP_B2_KEY` — an application key scoped to that
  one bucket with `writeFiles` + `listFiles` only (no `deleteFiles`: a
  compromised box cannot destroy history; retention is the bucket's job).
- `BACKUP_PREFIX` — defaults to `VIRTU_HOST` (each / lmnop / zinc share one
  bucket, separate prefixes).

**Scripts (`bin/`, concern-first naming):**

- `bin/db-backup` — `docker compose exec -T db pg_dump -U virtu -Fc virtu |
  age -r "$BACKUP_AGE_PUBKEY" | rclone rcat b2:$BUCKET/$PREFIX/virtu-$(date
  -u +%Y%m%dT%H%M%SZ).dump.age`. Custom format (`-Fc`) restores selectively
  and compresses itself. Logs one line to the journal; non-zero exit on any
  stage failure (pipefail). Runs from cron as the `virtu` user.
- `bin/db-restore <file.dump.age>` — decrypts with the workstation key and
  `pg_restore`s into a SCRATCH postgres container (`virtu-restore`) by
  default; `--into <DATABASE_URL>` to restore for real. The restore drill is
  `just db-restore` against the newest dump, monthly.
- `bin/backup-provision` — one-shot from the workstation with the B2
  master key in env: creates the private bucket, sets lifecycle rules
  (below), creates the scoped application key, prints the three env lines
  to paste into the box's `.env`. Uses the `b2` CLI (pipx); documents the
  manual console equivalent for anyone without it.
- `bin/host-provision` gains: install `age` + `rclone` (apt), write the
  rclone remote from the env vars, and the cron line
  `17 3 * * * virtu /opt/virtu/bin/db-backup` — all skipped when the pubkey
  is unset.

**Retention:** B2 lifecycle rules on the bucket, not script logic:
keep every file 35 days (covers "which day did it break"), plus a second
prefix `monthly/` that `bin/db-backup` writes to on the 1st with a 400-day
rule. Weekly granularity beyond a month is not worth the extra rule.
Because the box key cannot delete, retention is enforceable only by B2.

**Second copy:** the workstation keeps pulling one dump a month by hand
(`rclone copy` of the newest file) — off-B2, off-Linode.

**Alerting:** a `virtu_backup_last_success_timestamp` gauge would be ideal
but the backup runs outside maild; simplest honest option is a
healthchecks.io-style ping URL (`BACKUP_PING_URL`, optional) hit on
success, which alerts when a day is missed. Grafana can alert on the ping
service's own metric later.

## Order of work

1. `bin/db-backup` + `bin/db-restore` with the env gate; test locally
   against the dev stack with a throwaway age key and a local rclone
   remote (`local:` backend) — no B2 needed to prove the pipeline.
2. `bin/backup-provision` (B2 CLI) + the manual-console instructions.
3. `bin/host-provision` additions (packages, rclone config, cron).
4. Run on each.email; do the first restore drill into a scratch container;
   record the result in STATE.md.

## Cost

B2: first 10 GB free; a year of daily 11 MB custom-format dumps is under
3 GB. `age`, `rclone`: free. Nothing else.
