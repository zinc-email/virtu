// Lift a destination's outbound pause now — the CLI mirror of
// DELETE /api/admin/destinations/:domain (queue/destinationThrottle.ts).
//
// Usage: bin/destination-resume <domain>, or on a box:
//   docker compose -f docker-compose.serve.yml exec api \
//     bun run src/scripts/destinationResume.ts <domain>

import { db } from "../db";
import { clearThrottle } from "../queue/destinationThrottle";

const domain = process.argv[2]?.trim().toLowerCase();
if (!domain) {
  console.error("usage: destinationResume.ts <domain>");
  process.exit(2);
}
if (await clearThrottle(db, domain)) {
  console.log(`${domain}: pause lifted, strikes reset`);
  process.exit(0);
}
console.error(`${domain}: no throttle row`);
process.exit(1);
