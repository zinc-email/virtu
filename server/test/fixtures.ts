/**
 * DB fixtures for story tests: find-or-create, parallel-safe (unique
 * constraints + retry, never truncation), per-test unique aliases. Runs on
 * the test-runner container where DATABASE_URL / VERP_SECRET point at the
 * same Postgres and secret the `mail` service uses.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { generateApiKey, hashApiKey } from "../src/auth/apiKey.ts";
import { config } from "../src/config.ts";
import { db } from "../src/db/index.ts";
import {
  type Alias,
  aliases,
  apiKeys,
  type CustomDomain,
  customDomains,
  type DkimKey,
  dkimKeys,
  type Mailbox,
  mailboxes,
  smtpCredentials,
  type User,
  users,
} from "../src/db/schema.ts";
import { wes } from "./personas.ts";
import { publishTxt } from "./nsupdate.ts";

/** Wes's submission password (constant so reruns against dirty state work).
 * Accounts have no password: this is the per-device SMTP credential
 * ensureUser mints (name {@link STORY_DEVICE}). */
export const WES_PASSWORD = "correct-horse-battery-staple";

/** Device name of the SMTP credential every ensureUser fixture carries. */
export const STORY_DEVICE = "story-fixture";

/** Short unique tag for per-test alias/mailbox localparts. */
export function randomTag(): string {
  return randomBytes(4).toString("hex");
}

/** Generic condition poller for DB-side assertions. */
export async function pollUntil<T>(
  check: () => Promise<T | undefined | false>,
  { timeoutMs = 30_000, pollMs = 250, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() >= deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(pollMs);
  }
}

/**
 * Find-or-create our signing key (config.mailDomain / config.dkimSelector)
 * and publish its public half at {selector}._domainkey.{domain} via
 * nsupdate. Publishing is unconditional: the BIND zone resets on container
 * recreation while the key row lives in Postgres.
 */
export async function ensureDkimKey(): Promise<DkimKey> {
  const { mailDomain: domain, dkimSelector: selector } = config;

  let row = (
    await db
      .select()
      .from(dkimKeys)
      .where(and(eq(dkimKeys.domain, domain), eq(dkimKeys.selector, selector)))
      .limit(1)
  )[0];

  if (row === undefined) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await db
      .insert(dkimKeys)
      .values({
        domain,
        selector,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
        publicKeyBase64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
          "base64",
        ),
      })
      .onConflictDoNothing();
    row = (
      await db
        .select()
        .from(dkimKeys)
        .where(and(eq(dkimKeys.domain, domain), eq(dkimKeys.selector, selector)))
        .limit(1)
    )[0];
    if (row === undefined) throw new Error("dkim_keys find-or-create lost both races");
  }

  await publishTxt(
    domain,
    `${selector}._domainkey.${domain}`,
    `v=DKIM1; k=rsa; p=${row.publicKeyBase64}`,
  );
  return row;
}

/** A user plus their (verified, default) mailbox. */
export interface UserFixture {
  user: User;
  mailbox: Mailbox;
}

/** Find-or-create a user with a verified default mailbox at their own
 * address plus a per-device SMTP credential for `password` (accounts have no
 * password — device credentials are the only thing SMTP AUTH accepts). */
export async function ensureUser(email: string, password: string): Promise<UserFixture> {
  const normalized = email.trim().toLowerCase();

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = (await db.select().from(users).where(eq(users.email, normalized)).limit(1))[0];
    if (existing !== undefined) {
      const mailbox = await ensureMailbox(existing.id, normalized);
      await ensureSmtpCredential(existing.id, password);
      return { user: existing, mailbox };
    }

    const inserted = await db
      .insert(users)
      .values({ email: normalized, name: normalized, activated: true })
      .onConflictDoNothing()
      .returning();
    const user = inserted[0];
    if (user === undefined) continue; // lost the race; loop finds the winner

    const mailbox = await ensureMailbox(user.id, normalized);
    await db.update(users).set({ defaultMailboxId: mailbox.id }).where(eq(users.id, user.id));
    await ensureSmtpCredential(user.id, password);
    return { user: { ...user, defaultMailboxId: mailbox.id }, mailbox };
  }
  throw new Error(`ensureUser lost every race for ${normalized}`);
}

/** Find-or-create the {@link STORY_DEVICE} SMTP credential for a user.
 * Reruns and parallel racers hash the same constant password, so a
 * duplicate row is harmless — both authenticate. */
async function ensureSmtpCredential(userId: number, password: string): Promise<void> {
  const existing = (
    await db
      .select({ id: smtpCredentials.id })
      .from(smtpCredentials)
      .where(and(eq(smtpCredentials.userId, userId), eq(smtpCredentials.name, STORY_DEVICE)))
      .limit(1)
  )[0];
  if (existing !== undefined) return;

  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await db.insert(smtpCredentials).values({ userId, name: STORY_DEVICE, passwordHash });
}

/** Mint an API key for a fixture user directly in the DB — story tests
 * cannot round-trip the emailed login code (deliverd may already have
 * shipped it to a peer Maildir), so they skip the HTTP login flow. */
export async function createApiKey(userId: number): Promise<string> {
  const key = generateApiKey();
  await db
    .insert(apiKeys)
    .values({ userId, keyHash: hashApiKey(key), name: "story", sudoModeAt: new Date() });
  return key;
}

/** Find-or-create a (verified) mailbox row for a user. */
export async function ensureMailbox(userId: number, email: string): Promise<Mailbox> {
  const normalized = email.trim().toLowerCase();
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = (
      await db
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.userId, userId), eq(mailboxes.email, normalized)))
        .limit(1)
    )[0];
    if (existing !== undefined) return existing;

    const inserted = await db
      .insert(mailboxes)
      .values({ userId, email: normalized, verified: true })
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return inserted[0];
  }
  throw new Error(`ensureMailbox lost every race for ${normalized}`);
}

/** Wes: the paying persona (wes@qmail.com) with his qmail mailbox. */
export async function ensureWes(): Promise<UserFixture> {
  return ensureUser(wes.email, WES_PASSWORD);
}

/**
 * Find-or-create a (verified) custom domain row for a user. The test zone
 * for user.com already MXes at mail.virtu.email with delegated SPF, so a
 * row here is all the "setup" a custom-domain story needs.
 */
export async function ensureCustomDomain(userId: number, domain: string): Promise<CustomDomain> {
  const normalized = domain.trim().toLowerCase();
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = (
      await db.select().from(customDomains).where(eq(customDomains.domain, normalized)).limit(1)
    )[0];
    if (existing !== undefined) {
      if (existing.userId !== userId) {
        throw new Error(`custom domain ${normalized} already owned by user ${existing.userId}`);
      }
      return existing;
    }
    const inserted = await db
      .insert(customDomains)
      .values({
        userId,
        domain: normalized,
        verified: true,
        spfVerified: true,
        ownershipVerified: true,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return inserted[0];
  }
  throw new Error(`ensureCustomDomain lost every race for ${normalized}`);
}

/** Options for {@link createAlias}. */
export interface CreateAliasOptions {
  enabled?: boolean;
  mailboxId?: number;
  /** Localpart prefix before the unique tag; default "wes". */
  prefix?: string;
  /** Domain for the alias; default config.mailDomain. */
  domain?: string;
  /** Link the alias to a custom domain row. */
  customDomainId?: number;
}

/**
 * Create a per-test unique alias `{prefix}.{tag}@{mailDomain}` for a user
 * fixture. Never find-or-create: uniqueness IS the test isolation.
 */
export async function createAlias(
  fixture: UserFixture,
  opts: CreateAliasOptions = {},
): Promise<Alias> {
  const email = `${opts.prefix ?? "wes"}.${randomTag()}@${opts.domain ?? config.mailDomain}`;
  const rows = await db
    .insert(aliases)
    .values({
      userId: fixture.user.id,
      email,
      enabled: opts.enabled ?? true,
      mailboxId: opts.mailboxId ?? fixture.mailbox.id,
      customDomainId: opts.customDomainId ?? null,
    })
    .returning();
  return rows[0]!;
}

/** Re-read an alias row (DB-side assertions). */
export async function getAlias(aliasId: number): Promise<Alias | undefined> {
  return (await db.select().from(aliases).where(eq(aliases.id, aliasId)).limit(1))[0];
}
