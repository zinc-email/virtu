// Mint signup invite codes from the shell — the break-glass path when no
// admin session is handy (or the API is down; only Postgres must be up).
// Rides the same primitive as POST /api/admin/invites (auth/invites.ts).
//
// Usage: bin/invite-create [count] [--note "text"] [--expires-days N]

import { createInvites } from "../auth/invites";
import { db } from "../db";

const args = process.argv.slice(2);
let inviteCount = 1;
let note: string | undefined;
let expiresDays: number | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--note") {
    note = args[++i];
  } else if (arg === "--expires-days") {
    expiresDays = Number(args[++i]);
  } else if (arg !== undefined && /^\d+$/.test(arg)) {
    inviteCount = Number(arg);
  } else {
    console.error(`unknown argument: ${arg}`);
    console.error('usage: inviteCreate.ts [count] [--note "text"] [--expires-days N]');
    process.exit(2);
  }
}

if (!Number.isInteger(inviteCount) || inviteCount < 1 || inviteCount > 100) {
  console.error("count must be 1-100");
  process.exit(2);
}
if (expiresDays !== undefined && (!Number.isInteger(expiresDays) || expiresDays < 1)) {
  console.error("--expires-days must be a positive integer");
  process.exit(2);
}

const rows = await createInvites(db, {
  count: inviteCount,
  note,
  expiresAt: expiresDays === undefined ? null : new Date(Date.now() + expiresDays * 86_400_000),
  createdBy: null,
});
for (const row of rows) console.log(row.code);
process.exit(0);
