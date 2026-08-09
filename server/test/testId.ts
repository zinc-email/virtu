/**
 * Unique per-test ids for X-Virtu-Test-Id addressing (see maildir.ts).
 * A UUID is unique enough and needs no dependency; nothing sorts by these.
 */

import { randomUUID } from "node:crypto";

export function newTestId(): string {
  return randomUUID();
}
