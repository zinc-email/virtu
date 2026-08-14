// Requeue failed rows (failed -> pending, tries reset) — the break-glass
// form of POST /api/admin/queue/requeue. Same primitive
// (queue/admin.ts requeueMessages). Refuses raw-cleared rows.
//
// Usage: bin/queue-requeue <id...>

import { db } from "../db";
import { requeueMessages } from "../queue/admin";

const ids = process.argv.slice(2).map(Number);
if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 1)) {
  console.error("usage: queueRequeue.ts <id...>");
  process.exit(2);
}

const requeued = await requeueMessages(db, ids);
console.log(`requeued ${requeued.length}/${ids.length}: ${requeued.join(", ") || "(none)"}`);
const missed = ids.filter((id) => !requeued.includes(id));
if (missed.length > 0) {
  console.log(`not requeueable (not failed, or raw already cleared): ${missed.join(", ")}`);
}
process.exit(0);
