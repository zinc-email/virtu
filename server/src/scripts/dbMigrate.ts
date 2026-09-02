// Apply pending SQL migrations from server/drizzle/ (the committed output of
// `just db-generate`) — the ONLY way schema reaches a database.
//
// Non-interactive by construction: every decision drizzle-kit would prompt
// for (rename-vs-recreate, data loss) was made on the workstation at
// generate time and is baked into the committed SQL, so this runs unattended
// in the serve stack's db-migrate one-shot, the dev api's boot, and the test
// net's mail container. Applied migrations are recorded in
// drizzle.__drizzle_migrations; a rerun is a no-op.
//
// Usage: just db-migrate, or on a box the serve stack runs it before api and
// maild start (docker-compose.serve.yml).

import { migrate } from "drizzle-orm/bun-sql/migrator";
import { db } from "../db";

const folder = new URL("../../drizzle", import.meta.url).pathname;
const started = Date.now();
await migrate(db, { migrationsFolder: folder });
console.log(`db-migrate: up to date (${Date.now() - started}ms)`);
process.exit(0);
