// Drop queue rows (pending/sending -> failed "dropped by operator") — the
// break-glass form of POST /api/admin/queue/drop. Same primitive
// (queue/admin.ts dropMessages), so CLI and API can never diverge.
//
// Usage: bin/queue-drop <id...>

import { db } from "../db";
import { dropMessages } from "../queue/admin";

const ids = process.argv.slice(2).map(Number);
if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 1)) {
  console.error("usage: queueDrop.ts <id...>");
  process.exit(2);
}

const dropped = await dropMessages(db, ids);
console.log(`dropped ${dropped.length}/${ids.length}: ${dropped.join(", ") || "(none)"}`);
const missed = ids.filter((id) => !dropped.includes(id));
if (missed.length > 0) {
  console.log(`not droppable (unknown id or already terminal): ${missed.join(", ")}`);
}
process.exit(0);
