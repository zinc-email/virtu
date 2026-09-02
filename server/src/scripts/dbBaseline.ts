// Baseline an EXISTING database onto the migration ledger — the one-time
// bridge from the push era: a DB whose schema was applied by `drizzle-kit
// push` has every table but no drizzle.__drizzle_migrations rows, so the
// first `db-migrate` would try to CREATE TABLE users and fail.
//
// This marks every migration in server/drizzle/meta/_journal.json as applied
// WITHOUT running its SQL (same hash + created_at the real migrator writes).
// Precondition, checked: the schema already matches — run `just db push` one
// last time first if unsure. Refuses when the ledger already has rows.
//
// Usage: just db-baseline (dev), or on a box:
//   docker compose -f docker-compose.serve.yml run --rm --no-deps api \
//     bun run src/scripts/dbBaseline.ts

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

const folder = new URL("../../drizzle", import.meta.url).pathname;
const journal: Journal = await Bun.file(`${folder}/meta/_journal.json`).json();

// The schema must already be there (this is a baseline, not a migrate).
const [probe] = await db.execute<{ n: string }>(
  sql`select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_name = 'users'`,
);
if (probe?.n !== "1") {
  console.error("db-baseline: no `users` table — this DB is empty; run db-migrate instead");
  process.exit(1);
}

await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
await db.execute(
  sql`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
);
const [existing] = await db.execute<{ n: string }>(
  sql`select count(*)::text as n from "drizzle"."__drizzle_migrations"`,
);
if (existing?.n !== "0") {
  console.error(`db-baseline: ledger already has ${existing?.n} rows — nothing to baseline`);
  process.exit(1);
}

for (const entry of journal.entries) {
  const query = await Bun.file(`${folder}/${entry.tag}.sql`).text();
  const hash = createHash("sha256").update(query).digest("hex");
  await db.execute(
    sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values (${hash}, ${entry.when})`,
  );
  console.log(`db-baseline: marked ${entry.tag} applied`);
}
process.exit(0);
