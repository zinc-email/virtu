// Bounce queue rows: DSN to the originator + failed("bounced by operator")
// — the break-glass form of POST /api/admin/queue/bounce. Same function
// (pipeline/operatorBounce.ts); never touches the alias auto-disable ledger.
//
// Usage: bin/queue-bounce <id...>

import { db } from "../db";
import { bounceQueuedMessages } from "../pipeline/operatorBounce";

const ids = process.argv.slice(2).map(Number);
if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 1)) {
  console.error("usage: queueBounce.ts <id...>");
  process.exit(2);
}

const result = await bounceQueuedMessages(db, ids);
console.log(
  `bounced ${result.bounced.length}/${ids.length}: ${result.bounced.join(", ") || "(none)"}`,
);
for (const skip of result.skipped) {
  console.log(`skipped #${skip.id}: ${skip.reason}`);
}
process.exit(0);
