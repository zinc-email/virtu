// Hard-delete terminal queue rows (failed/sent) ahead of retention — the
// break-glass form of POST /api/admin/queue/delete. Same primitive
// (queue/admin.ts deleteMessages). Pending/sending rows are refused: drop
// (or bounce) them first.
//
// Usage: bin/queue-delete <id...>

import { db } from "../db";
import { deleteMessages } from "../queue/admin";

const ids = process.argv.slice(2).map(Number);
if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 1)) {
  console.error("usage: queueDelete.ts <id...>");
  process.exit(2);
}

const deleted = await deleteMessages(db, ids);
console.log(`deleted ${deleted.length}/${ids.length}: ${deleted.join(", ") || "(none)"}`);
const missed = ids.filter((id) => !deleted.includes(id));
if (missed.length > 0) {
  console.log(`not deletable (unknown id, or not terminal — drop first): ${missed.join(", ")}`);
}
process.exit(0);
