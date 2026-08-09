// Shared config for every entrypoint (api, mx, submission, deliverd — see
// PLAN.md). Parsed once from env at import; keys map camelCase -> SCREAMING
// snake env names via app/env.ts (databaseUrl -> DATABASE_URL, ...).

import { z } from "zod";
import { loadConfigFromEnv } from "./app/env";

const ConfigSchema = z.object({
  databaseUrl: z.string().default("postgres://virtu:virtu@localhost:5432/virtu"),
  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().default(3000),
});

export const config = loadConfigFromEnv(ConfigSchema);
export type Config = typeof config;

// SimpleLogin's MAX_NB_EMAIL_FREE_PLAN default.
export const MAX_ALIAS_FREE_PLAN = 5;
