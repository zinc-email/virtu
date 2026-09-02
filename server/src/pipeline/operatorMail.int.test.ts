/**
 * Operator mail against the dockerized Postgres: recipient selection
 * (opt-in set, first-operator fallback, deliverability bar) and the RCPT
 * policy's role-address path. Parallel-safe: unique users per test. The
 * shared DB may hold opted-in admins from other tests, so assertions are
 * about OUR operators' membership, never about the set being exactly ours.
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { USER_FLAGS } from "../auth/userFlags.ts";
import { db } from "../db/index.ts";
import { mailboxes, users } from "../db/schema.ts";
import {
  effectiveOperators,
  listOperators,
  operatorLocalpart,
  setOperatorMail,
} from "./operatorMail.ts";
import { evaluateRcpt } from "./policy.ts";

const tag = () => crypto.randomUUID().slice(0, 8);
const LOCALPARTS = ["postmaster", "abuse"];
const OPTS = { verpSecret: "0123456789abcdef0123456789abcdef", mailDomain: "virtu.email" };

async function admin(opts: { verified?: boolean; disabled?: boolean } = {}) {
  const t = tag();
  const user = (
    await db
      .insert(users)
      .values({
        email: `op-${t}@int.test`,
        activated: true,
        disabled: opts.disabled ?? false,
        flags: USER_FLAGS.admin,
      })
      .returning()
  )[0]!;
  const mailbox = (
    await db
      .insert(mailboxes)
      .values({ userId: user.id, email: `op-mb-${t}@int.test`, verified: opts.verified ?? true })
      .returning()
  )[0]!;
  await db.update(users).set({ defaultMailboxId: mailbox.id }).where(eq(users.id, user.id));
  return { user: { ...user, defaultMailboxId: mailbox.id }, mailbox };
}

describe("operatorLocalpart", () => {
  test("role localparts on the service domain only, case-insensitive", () => {
    expect(operatorLocalpart("Postmaster@Virtu.Email", "virtu.email", LOCALPARTS)).toBe(
      "postmaster",
    );
    expect(operatorLocalpart("abuse@virtu.email", "virtu.email", LOCALPARTS)).toBe("abuse");
    expect(operatorLocalpart("abuse@user.com", "virtu.email", LOCALPARTS)).toBeNull();
    expect(operatorLocalpart("wes@virtu.email", "virtu.email", LOCALPARTS)).toBeNull();
    expect(operatorLocalpart("postmaster", "virtu.email", LOCALPARTS)).toBeNull();
  });
});

describe("effectiveOperators", () => {
  test("pure: opted-in set wins, else the first operator", () => {
    const a = { user: { id: 1, flags: USER_FLAGS.admin } as never, mailbox: null };
    const b = {
      user: { id: 2, flags: USER_FLAGS.admin | USER_FLAGS.operatorMail } as never,
      mailbox: null,
    };
    expect(effectiveOperators([a, b])).toEqual([b]);
    expect(effectiveOperators([a])).toEqual([a]);
    expect(effectiveOperators([])).toEqual([]);
  });
});

describe("listOperators / setOperatorMail", () => {
  test("lists active admins with their default mailbox; disabled admins are excluded", async () => {
    const live = await admin();
    const gone = await admin({ disabled: true });
    const list = await listOperators(db);
    const mine = list.find((o) => o.user.id === live.user.id);
    expect(mine?.mailbox?.id).toBe(live.mailbox.id);
    expect(list.some((o) => o.user.id === gone.user.id)).toBe(false);
  });

  test("setOperatorMail flips the flag and keeps the admin bit", async () => {
    const op = await admin();
    const on = await setOperatorMail(db, op.user.id, true);
    expect(on?.flags).toBe(USER_FLAGS.admin | USER_FLAGS.operatorMail);
    const off = await setOperatorMail(db, op.user.id, false);
    expect(off?.flags).toBe(USER_FLAGS.admin);
    expect(await setOperatorMail(db, 0, true)).toBeNull();
  });
});

describe("evaluateRcpt: role addresses", () => {
  test("an opted-in operator with a verified default mailbox receives postmaster@", async () => {
    const op = await admin();
    await setOperatorMail(db, op.user.id, true);
    const { decision } = await evaluateRcpt(db, "postmaster@virtu.email", {
      ...OPTS,
      operatorLocalparts: LOCALPARTS,
    });
    expect(decision.kind).toBe("operator");
    if (decision.kind === "operator") {
      expect(decision.localpart).toBe("postmaster");
      expect(decision.recipients.some((r) => r.mailbox.id === op.mailbox.id)).toBe(true);
    }
    await setOperatorMail(db, op.user.id, false);
  });

  test("an unverified default mailbox is skipped (never forward to an unproven address)", async () => {
    const op = await admin({ verified: false });
    await setOperatorMail(db, op.user.id, true);
    const { decision } = await evaluateRcpt(db, "abuse@virtu.email", {
      ...OPTS,
      operatorLocalparts: LOCALPARTS,
    });
    expect(decision.kind).toBe("operator");
    if (decision.kind === "operator") {
      expect(decision.recipients.some((r) => r.mailbox.id === op.mailbox.id)).toBe(false);
    }
    await setOperatorMail(db, op.user.id, false);
  });

  test("without the option, postmaster@ is an ordinary unknown user", async () => {
    const { decision } = await evaluateRcpt(db, "postmaster@virtu.email", OPTS);
    expect(decision).toMatchObject({ kind: "reject", code: 550 });
  });
});
