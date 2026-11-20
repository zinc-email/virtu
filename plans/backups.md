# Database backup and recovery

Local tooling is implemented. Production off-host storage, scheduling, alert routing,
and a restore from that storage still need deployment. The maximum acceptable loss
of SMTP-accepted mail has not been agreed. Do not use a daily dump as evidence that
accepted mail can be recovered within minutes.

## Run a backup

Install a PostgreSQL client matching the server major version, `age`, `rclone`, and
`shasum`. Generate the age identity on the recovery workstation. Keep its private
key off the database host and store a second recovery copy separately.

Set these environment variables for `bin/db-backup`:

- `DATABASE_URL`: host-reachable PostgreSQL connection string.
- `BACKUP_AGE_PUBKEY`: public age recipient.
- `BACKUP_DESTINATION`: off-host rclone directory, such as `b2:bucket/each.email`.
- `BACKUP_PING_URL`: optional success URL for an external missed-backup monitor.

Configure the rclone remote with a bucket-scoped application key. Upload/read-back
verification needs write, list and read access; omit delete access. Set bucket
retention independently of the host: 35 days for daily dumps, 400 days under
`monthly/`. Test those policies in the storage console. The script also uploads a
monthly copy on the first UTC day of the month.

The script streams `pg_dump -Fc` through age, stages ciphertext with mode 0600,
uploads it, then downloads it to compare SHA-256. It exits nonzero if configuration
is missing or any stage fails. It does not write a plaintext dump on the source host.

For a systemd host, copy `deploy/virtu-backup.service` and `.timer` to
`/etc/systemd/system/`. Put the environment values in `/opt/virtu/backup.env`, readable
only by root and the `virtu` user; configure rclone for that user. Run the service
once and check its journal before enabling the timer with
`systemctl enable --now virtu-backup.timer`. Configure the external monitor to alert
on a missed run. The supplied timer is daily.

## Restore drill

Download a snapshot with rclone to the recovery workstation. Set
`BACKUP_AGE_IDENTITY` to the local private-key file and run:

```sh
bin/db-restore downloaded.dump.age
```

The default starts an isolated PostgreSQL 17 container with no network, restores in
one transaction, prints queue/account/routing counts, and removes the container.
Set `BACKUP_POSTGRES_IMAGE` if the source uses a different major version.

For an existing **empty scratch database**, use:

```sh
bin/db-restore downloaded.dump.age --into "$SCRATCH_DATABASE_URL"
```

This refuses a nonempty destination. It never starts mail workers. Compare account,
routing and queue counts against the snapshot, and compare queued raw-message bytes.
Record the source snapshot time, upload completion, restore duration and checksums.
A restore into scratch proves readability; a recovery exercise must also demonstrate
that routing, keys and accepted queue rows can resume on replacement infrastructure.

For real recovery, stop acceptance and workers, preserve the failed installation,
restore into a new empty database, and inspect its queue before pointing services at
it. Previously delivered messages may still be pending in an older snapshot. Resolve
that ambiguity against delivery logs before resuming, or document the duplicate risk.
Never run the old and restored workers together.

## Accepted-mail recovery gate

A daily snapshot can lose changes since its snapshot began, including mail already
acknowledged with SMTP 250. The interval plus upload time and failed runs determines
the actual exposure. Record the agreed RPO (maximum lost accepted-mail interval) and
RTO (maximum recovery time) before cutover.

If the RPO is minutes, provision continuous off-host WAL archiving/PITR and monitor
archive lag; verify recovery to a chosen timestamp. If the requirement is zero loss
after a host failure, acceptance needs synchronous durability on another failure
domain. Neither guarantee is supplied by these logical-dump scripts. Retaining the
existing MTA with a durable spool remains an option while that work is completed.

## Local validation

The encrypted dump, rclone upload/read-back and restore into an empty PostgreSQL
scratch database were exercised locally with a throwaway key and the rclone local
backend on 2026-10-31. The populated restore matched complete-row checksums for
606 accounts, 237 aliases and 741 queue rows, including their raw-message bytes.
The nonempty-destination guard also refused an overwrite. This is not a test of
production B2 credentials, retention, alert delivery,
or host replacement. Repeat the drill from the deployed off-host destination before
cutover and monthly thereafter.
