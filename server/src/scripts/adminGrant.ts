// Grant (or with --revoke, clear) the admin flag on a user — the break-glass
// mint for PLAN Lane K: the first admin can't be created through the API
// because no admin exists yet. Direct DB, so it works with the API down.
//
// Usage: bin/admin-grant <email> | bin/admin-revoke <email>, or on a box:
//   docker compose -f docker-compose.serve.yml exec api \
//     bun run src/scripts/adminGrant.ts [--revoke] <email>

import { eq } from "drizzle-orm";
import { isAdmin, USER_FLAGS } from "../auth/userFlags";
import { db } from "../db";
import { users } from "../db/schema";

const args = process.argv.slice(2).filter((a) => a !== "--revoke");
const revoke = process.argv.includes("--revoke");
const email = args[0]?.trim().toLowerCase();
if (!email) {
  console.error("usage: adminGrant.ts [--revoke] <email>");
  process.exit(2);
}

const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
const user = rows[0];
if (user === undefined) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

const flags = revoke ? user.flags & ~USER_FLAGS.admin : user.flags | USER_FLAGS.admin;
await db.update(users).set({ flags }).where(eq(users.id, user.id));
console.log(
  `${email} (user ${user.id}): admin ${isAdmin(user) ? "yes" : "no"} -> ${
    isAdmin({ flags }) ? "yes" : "no"
  }`,
);
process.exit(0);
