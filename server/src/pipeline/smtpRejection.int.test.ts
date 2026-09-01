/**
 * smtp_rejections against the dockerized Postgres: the recorder writes what
 * the hooks hand it, and the retention pass ages rows out. Parallel-safe:
 * every row carries a unique remote address, and the synthetic-old rows use
 * timestamps no concurrent test produces (fresh rows are never past any
 * retention cutoff).
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { smtpRejections } from "../db/schema.ts";
import { runRejectionRetentionOnce } from "../queue/retention.ts";
import { recordSmtpRejection } from "./smtpRejection.ts";

const uniqueAddress = () => `192.0.2.${Math.floor(Math.random() * 200)}-${crypto.randomUUID()}`;

describe("recordSmtpRejection", () => {
  test("writes one row with the reply and envelope context", async () => {
    const remoteAddress = uniqueAddress().slice(0, 64);
    await recordSmtpRejection(db, {
      entrypoint: "mx",
      phase: "rcpt_to",
      remoteAddress,
      heloName: "spam.example",
      rcptTo: "nobody@virtu.email",
      reject: { code: 550, enhanced: "5.1.1", message: "No such alias" },
    });

    const rows = await db
      .select()
      .from(smtpRejections)
      .where(eq(smtpRejections.remoteAddress, remoteAddress));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.entrypoint).toBe("mx");
    expect(row.phase).toBe("rcpt_to");
    expect(row.heloName).toBe("spam.example");
    expect(row.mailFrom).toBeNull();
    expect(row.rcptTo).toBe("nobody@virtu.email");
    expect(row.smtpCode).toBe(550);
    expect(row.enhancedCode).toBe("5.1.1");
    expect(row.reason).toBe("No such alias");
    expect(row.userId).toBeNull();
  });

  test("null reverse path stores as null, not empty string", async () => {
    const remoteAddress = uniqueAddress().slice(0, 64);
    await recordSmtpRejection(db, {
      entrypoint: "submission",
      phase: "data",
      remoteAddress,
      mailFrom: "",
      userId: null,
      reject: { code: 452, message: "Daily send limit reached (50/day); try again later" },
    });
    const rows = await db
      .select()
      .from(smtpRejections)
      .where(eq(smtpRejections.remoteAddress, remoteAddress));
    expect(rows[0]!.mailFrom).toBeNull();
    expect(rows[0]!.enhancedCode).toBeNull();
  });
});

describe("runRejectionRetentionOnce", () => {
  test("deletes rows past the window, keeps fresh ones", async () => {
    const oldAddress = uniqueAddress().slice(0, 64);
    const freshAddress = uniqueAddress().slice(0, 64);
    await db.insert(smtpRejections).values({
      entrypoint: "mx",
      phase: "rcpt_to",
      remoteAddress: oldAddress,
      smtpCode: 550,
      reason: "aged out",
      createdAt: new Date(Date.now() - 40 * 86_400_000),
    });
    await db.insert(smtpRejections).values({
      entrypoint: "mx",
      phase: "rcpt_to",
      remoteAddress: freshAddress,
      smtpCode: 550,
      reason: "stays",
    });

    const deleted = await runRejectionRetentionOnce(db, { retainDays: 30 });

    expect(deleted).toBeGreaterThanOrEqual(1);
    const oldRows = await db
      .select()
      .from(smtpRejections)
      .where(eq(smtpRejections.remoteAddress, oldAddress));
    expect(oldRows).toHaveLength(0);
    const freshRows = await db
      .select()
      .from(smtpRejections)
      .where(eq(smtpRejections.remoteAddress, freshAddress));
    expect(freshRows).toHaveLength(1);
  });
});
