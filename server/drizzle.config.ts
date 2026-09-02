// Generated migrations: `just db-generate` (drizzle-kit generate) diffs
// src/db/schema.ts against the last snapshot into ./drizzle (committed);
// src/scripts/dbMigrate.ts applies them everywhere, unattended.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://virtu:virtu@localhost:5432/virtu",
  },
});
