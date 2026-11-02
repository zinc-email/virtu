import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { dkimKeys, domains, users } from "../db/schema.ts";
import { parseMessage } from "../mail/headers.ts";
import { makeRsaKeyPair } from "../mailauth/test-fixtures.ts";
import { signOutbound } from "../mailauth/sign.ts";
import { clearDkimKeyCache, selectReplyDkimKey } from "./dkim.ts";

const suffix = crypto.randomUUID();
const serviceDomain = `service-${suffix}.test`;
const opts = { serviceDomain, serviceSelector: "mail" };
const key = makeRsaKeyPair();
let userId: number;
const keyIds: number[] = [];

async function insertKey(domain: string, selector = "dkim", privateKeyPem = key.privateKeyPem) {
  const [row] = await db
    .insert(dkimKeys)
    .values({ domain, selector, privateKeyPem, publicKeyBase64: key.publicKeyBase64 })
    .returning();
  keyIds.push(row!.id);
  clearDkimKeyCache();
}

async function domain(overrides: Partial<typeof domains.$inferInsert> = {}) {
  const nameRequested = `custom-${crypto.randomUUID()}.test`;
  const [row] = await db
    .insert(domains)
    .values({
      userId,
      nameRequested,
      verifiedOwner: true,
      verifiedDkim: true,
      verifiedSpf: true,
      ...overrides,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `dkim-${suffix}@test.invalid`, activated: true })
    .returning();
  userId = user!.id;
  await insertKey(serviceDomain, "mail");
});

afterAll(async () => {
  if (keyIds.length > 0) await db.delete(dkimKeys).where(inArray(dkimKeys.id, keyIds));
  if (userId !== undefined) await db.delete(users).where(eq(users.id, userId));
  clearDkimKeyCache();
});

describe("required reply signing identity", () => {
  test("service aliases select their service key", async () => {
    expect(await selectReplyDkimKey(db, { domainId: null }, opts)).toMatchObject({
      signingDomain: serviceDomain,
      selector: "mail",
    });
  });

  test("send-enabled custom domains select their own published key", async () => {
    const custom = await domain();
    await insertKey(custom.nameRequested);
    expect(await selectReplyDkimKey(db, { domainId: custom.id }, opts)).toMatchObject({
      signingDomain: custom.nameRequested,
      selector: "dkim",
    });
  });

  test("missing custom key cannot fall back to the valid service key", async () => {
    const custom = await domain();
    expect(await selectReplyDkimKey(db, { domainId: custom.id }, opts)).toBeNull();
  });

  test("an alternate unverified selector is not a substitute for the published selector", async () => {
    const custom = await domain();
    await insertKey(custom.nameRequested, "other");
    expect(await selectReplyDkimKey(db, { domainId: custom.id }, opts)).toBeNull();
  });

  test("revoked sending capability and missing domain cannot use service identity", async () => {
    for (const capability of ["verifiedOwner", "verifiedDkim", "verifiedSpf"] as const) {
      const custom = await domain({ [capability]: false });
      await insertKey(custom.nameRequested);
      expect(await selectReplyDkimKey(db, { domainId: custom.id }, opts)).toBeNull();
    }
    expect(await selectReplyDkimKey(db, { domainId: -1 }, opts)).toBeNull();
  });

  test("unusable custom key aborts signing instead of substituting the service key", async () => {
    const custom = await domain();
    await insertKey(custom.nameRequested, "dkim", "not a private key");
    const required = await selectReplyDkimKey(db, { domainId: custom.id }, opts);
    expect(required?.signingDomain).toBe(custom.nameRequested);
    const message = parseMessage(
      Buffer.from(`From: alias@${custom.nameRequested}\r\nSubject: test\r\n\r\nbody\r\n`),
    );
    await expect(
      signOutbound(message.headers, message.body, { dkimKeys: [required!] }),
    ).rejects.toThrow("Required DKIM signing failed");
  });
});
