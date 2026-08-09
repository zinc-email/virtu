// Typed env parsing (madi pattern, adapted to zod 4). Pure helpers — no
// process.env reads at module load, so they're unit-testable with an
// injected env record.

import { z } from "zod";

// databaseUrl -> PREFIX + DATABASE_URL, apiPort -> PREFIX + API_PORT, ...
export function toEnvKey(key: string, prefix = ""): string {
  return prefix + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export function loadConfigFromEnv<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  prefix = "",
  env: Record<string, string | undefined> = process.env,
): z.infer<z.ZodObject<T>> {
  const raw: Record<string, unknown> = {};

  for (const key of Object.keys(schema.shape)) {
    const envKey = toEnvKey(key, prefix);
    const value = env[envKey];
    // Treat empty strings as absent. .env-style files (compose env_file)
    // commonly leave optional vars as `KEY=`, which would otherwise be a
    // defined-but-empty value that fails validation on optional fields.
    raw[key] = value === "" ? undefined : value;
  }

  return schema.parse(raw);
}

// Boolean from an env string. Accepts "true"/"false"/"1"/"0"/"yes"/"no"
// (case-insensitive, whitespace-trimmed); anything else fails parse with a
// clear error. Use this instead of z.coerce.boolean(), which truthy-coerces
// the literal string "false" to `true` — a classic ops footgun.
export const booleanString = (defaultValue: boolean) =>
  z
    .string()
    .default(defaultValue ? "true" : "false")
    .transform((raw, ctx) => {
      const v = raw.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "no") return false;
      ctx.addIssue({
        code: "custom",
        message: `expected "true"/"false"/"1"/"0"/"yes"/"no" (case-insensitive), got ${JSON.stringify(raw)}`,
      });
      return z.NEVER;
    });
