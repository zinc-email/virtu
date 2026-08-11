/**
 * Postgres error classification, robust to the driver wrapping the original
 * error in an `err.cause` chain (Bun's postgres client does this).
 */

/** True when the error is a unique-constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err, depth = 0; typeof e === "object" && e !== null && depth < 4; depth++) {
    const rec = e as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    if (rec.code === "23505" || rec.errno === "23505") return true;
    if (typeof rec.message === "string" && rec.message.includes("duplicate key")) return true;
    e = rec.cause;
  }
  return false;
}
