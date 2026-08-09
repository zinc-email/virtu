// Drizzle over Bun's native postgres (drizzle-orm/bun-sql — NOT `pg`).
// snake_case casing means schema.ts never names columns explicitly.

import { drizzle } from "drizzle-orm/bun-sql";
import { config } from "../config";
import * as schema from "./schema";

export const db = drizzle({
  connection: config.databaseUrl,
  casing: "snake_case",
  schema,
});

export type Db = typeof db;
