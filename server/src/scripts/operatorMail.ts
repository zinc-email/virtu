// Opt an operator in to (--on) or out of (--off) operator mail — the CLI
// mirror of PATCH /api/admin/operators/:id (pipeline/operatorMail.ts), so
// postmaster@/abuse@ routing can be set with the API down. Prints the
// effective recipient list afterwards.
//
// Usage: bin/operator-mail <email> --on|--off, or on a box:
//   docker compose -f docker-compose.serve.yml exec api \
//     bun run src/scripts/operatorMail.ts <email> --on|--off

import { eq } from "drizzle-orm";
import { receivesOperatorMail } from "../auth/userFlags";
import { db } from "../db";
import { users } from "../db/schema";
import { effectiveOperators, listOperators, setOperatorMail } from "../pipeline/operatorMail";

const args = process.argv.slice(2);
const on = args.includes("--on");
const off = args.includes("--off");
const email = args
  .find((a) => !a.startsWith("--"))
  ?.trim()
  .toLowerCase();
if (!email || on === off) {
  console.error("usage: operatorMail.ts <email> --on|--off");
  process.exit(2);
}

const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
if (user === undefined) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}
const operators = await listOperators(db);
if (!operators.some((o) => o.user.id === user.id)) {
  console.error(`${email} is not an active operator (bin/admin-grant first)`);
  process.exit(1);
}
await setOperatorMail(db, user.id, on);
const effective = effectiveOperators(await listOperators(db));
console.log(`${email}: operator mail ${on ? "on" : "off"}`);
console.log(
  `effective recipients: ${effective
    .map((o) => `${o.user.email}${receivesOperatorMail(o.user) ? "" : " (default)"}`)
    .join(", ")}`,
);
process.exit(0);
