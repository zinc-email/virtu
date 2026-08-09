// Push-based migrations: `just db push` (drizzle-kit push) applies
// src/db/schema.ts directly to the dev DB. No committed migration files
// for now; `out` is where drizzle-kit would write them if we ever switch.

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
