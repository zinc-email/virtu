// POST /api/auth/{login,verify} — the passwordless single-entrypoint auth
// flow carried over from legacy virtu (tmp/virtu Controller/Auth.php): one
// email field serves both login and signup. Submitting an unknown email
// creates a *provisional* user (users.activated = false — the modern
// equivalent of legacy's accountId-NULL row) and emails a 6-digit code
// exactly like a login does; verifying the code "graduates" the user
// (activated = true, trial started, self-mailbox created) and mints the API
// key. The two cases are indistinguishable on the wire, so the endpoints
// never reveal whether an email is registered.
//
// Unlike legacy virtu the codes are hardened: sha256-stored, 15-minute
// expiry, 3 wrong attempts kill the code (pipeline/transactional), sends are
// budgeted per address (sent_alerts, 3/hour) and the whole surface sits
// behind a per-IP rate limit. Errors use the {"error": "..."} envelope via
// the shared handler.

import rateLimit from "@fastify/rate-limit";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "../auth/apiKey";
import { config } from "../config";
import { db } from "../db";
import { apiKeys, invites, mailboxes, type User, users } from "../db/schema";
import {
  consumeVerificationCode,
  createVerificationCode,
  isRateLimited,
  LOGIN_CODE_ALERT_TYPE,
  loginCodeEmail,
  sendWithRateLimit,
} from "../pipeline/transactional";
import { HttpError } from "./httpError";
import { ErrorResponse } from "./schema";

const LoginPost = z
  .object({
    email: z.string(),
    // Device name; becomes the API key's name so the user can manage keys.
    device: z.string().optional(),
  })
  .meta({
    id: "AuthLoginRequest",
    example: { email: "user@example.com", device: "Chrome extension" },
  });

const MsgResponse = z.object({ msg: z.string() }).meta({ id: "MsgResponse" });

const VerifyPost = z
  .object({
    email: z.string(),
    code: z.string(),
    device: z.string().optional(),
    // Consumed only when the deployment is invite-only AND this verify would
    // graduate a new account; ignored otherwise.
    invite: z.string().optional(),
  })
  .meta({
    id: "AuthVerifyRequest",
    example: { email: "user@example.com", code: "662302", device: "Chrome extension" },
  });

const LoginResponse = z
  .object({
    name: z.string(),
    email: z.string(),
    mfa_enabled: z.boolean(),
    mfa_key: z.string().nullable(),
    api_key: z.string().nullable(),
  })
  .meta({ id: "AuthLoginResponse" });

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately loose — real deliverability checks (MX, disposable-domain
// blocklist; legacy virtu had both) are a wave-2 concern.
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// The trial starts at graduation (first verified login), not at the
// provisional insert: 7 days + 1 hour, SimpleLogin's trial_end default.
const TRIAL_MS = (7 * 24 + 1) * 60 * 60 * 1000;

// One response for every successful /auth/login, new user or old.
const CODE_SENT_MSG = "Login code sent";

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? err.code : undefined;
  const message = err instanceof Error ? err.message : "";
  return code === "23505" || message.includes("duplicate key");
}

/** Find-or-create the user row for a submitted email (provisional on miss). */
async function findOrCreateUser(email: string): Promise<User> {
  const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (found[0] !== undefined) return found[0];

  try {
    const inserted = await db.insert(users).values({ email, activated: false }).returning();
    if (inserted[0] !== undefined) return inserted[0];
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  // Lost the insert race — the winner's row is the user.
  const winner = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (winner[0] === undefined) throw new Error(`user find-or-create lost both races for ${email}`);
  return winner[0];
}

/**
 * Graduate a provisional user: activate, start the trial, and create the
 * self-mailbox as the default. Born verified: the login code was delivered
 * to this exact address, so verifying it proves control. Races (double
 * verify, legacy half-created rows) are absorbed by the activated-flag guard
 * and the mailbox find-or-create.
 *
 * When `inviteCode` is set (invite-only deployments — ABUSE.md Tier 0) the
 * invite is consumed inside the same transaction, after the activated-flag
 * guard: a bad code rolls the activation back, and a concurrent graduation
 * that already won never burns the invite.
 */
async function graduateUser(userId: number, email: string, inviteCode?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ activated: true, trialEnd: new Date(Date.now() + TRIAL_MS) })
      .where(and(eq(users.id, userId), eq(users.activated, false)))
      .returning({ id: users.id });
    if (updated.length === 0) return; // concurrent graduation won

    if (inviteCode !== undefined) {
      const consumed = await tx
        .update(invites)
        .set({ usedBy: userId, usedAt: new Date() })
        .where(
          and(
            eq(invites.code, inviteCode),
            isNull(invites.usedAt),
            or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
          ),
        )
        .returning({ id: invites.id });
      if (consumed.length === 0) {
        throw new HttpError(403, "Invalid, expired or already-used invite code");
      }
    }

    const existing = await tx
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.userId, userId), eq(mailboxes.email, email)))
      .limit(1);
    let mailboxId = existing[0]?.id;
    if (mailboxId === undefined) {
      const inserted = await tx
        .insert(mailboxes)
        .values({ userId, email, verified: true })
        .returning({ id: mailboxes.id });
      mailboxId = inserted[0]?.id;
      if (mailboxId === undefined) throw new Error("mailbox insert returned no id");
    }
    await tx.update(users).set({ defaultMailboxId: mailboxId }).where(eq(users.id, userId));
  });
}

export async function withAuthRoutes(api: FastifyInstance) {
  await api.register(async (authCtx) => {
    await authCtx.register(rateLimit, {
      max: config.authRateLimitMax,
      timeWindow: "1 minute",
      // Must return an Error (thrown into the shared envelope handler) — a
      // plain { error } object would serialize as a 500.
      errorResponseBuilder: () => new HttpError(429, "Too many requests"),
    });

    const a = authCtx.withTypeProvider<FastifyZodOpenApiTypeProvider>();

    a.route({
      method: "POST",
      url: "/auth/login",
      schema: {
        description:
          "Request a login code — the single entrypoint for login AND signup. An " +
          "unknown email gets a provisional account created on the spot; either way a " +
          "6-digit code (15-minute expiry) is emailed and the response is identical, " +
          "so whether an address is registered is never revealed. Confirm the code " +
          "via POST /auth/verify. Resending is the same call again (budgeted: 3 " +
          "emails per address per hour → 429).",
        tags: ["Account"],
        body: LoginPost,
        response: { 200: MsgResponse, 400: ErrorResponse, 429: ErrorResponse },
      },
      handler: async (req) => {
        const email = normalizeEmail(req.body.email);
        if (!looksLikeEmail(email)) throw new HttpError(400, "Invalid email address");

        const user = await findOrCreateUser(email);

        // A disabled account gets the uniform response but no email — the
        // flow must not confirm the address exists, let alone its standing.
        if (user.disabled) return { msg: CODE_SENT_MSG };

        // Budget check BEFORE minting, so hammering this endpoint cannot
        // invalidate a code that is still in flight.
        if (
          await isRateLimited(db, {
            userId: user.id,
            toEmail: email,
            alertType: LOGIN_CODE_ALERT_TYPE,
          })
        ) {
          throw new HttpError(429, "Too many login emails requested, try again later");
        }

        const { code, row } = await createVerificationCode(db, {
          userId: user.id,
          purpose: "login",
        });
        const { subject, textBody } = loginCodeEmail(code);
        await sendWithRateLimit(db, {
          userId: user.id,
          alertType: LOGIN_CODE_ALERT_TYPE,
          to: email,
          subject,
          textBody,
          refId: row.id,
        });

        return { msg: CODE_SENT_MSG };
      },
    });

    a.route({
      method: "POST",
      url: "/auth/verify",
      schema: {
        description:
          "Enter the emailed login code to finish authenticating: a first-time email " +
          "is graduated to a full account (trial started, self-mailbox created), and " +
          "an api_key for the Authentication header is minted either way, with sudo " +
          "mode already fresh. 400 on a wrong email/code, 410 once the code has been " +
          "tried wrongly too many times (request a new one via /auth/login). MFA is " +
          "not implemented: mfa_enabled is always false and mfa_key null. On an " +
          "invite-only deployment a FIRST-TIME email additionally needs a valid " +
          "`invite` code or the response is 403 — sent only after code proof (so " +
          "whether an address is registered still never leaks), which spends the " +
          "login code: fix the invite, request a fresh code via /auth/login, and " +
          "verify again. Existing accounts never need an invite.",
        tags: ["Account"],
        body: VerifyPost,
        response: {
          200: LoginResponse,
          400: ErrorResponse,
          403: ErrorResponse,
          410: ErrorResponse,
          429: ErrorResponse,
        },
      },
      handler: async (req) => {
        const email = normalizeEmail(req.body.email);
        const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
        const user = found[0];
        // Same message as a wrong code — never expose whether the email exists.
        if (!user) throw new HttpError(400, "Wrong email or code");

        const result = await consumeVerificationCode(db, {
          userId: user.id,
          purpose: "login",
          code: req.body.code,
          toEmail: email,
        });
        if (result === "too_many") throw new HttpError(410, "Too many wrong tries");
        if (result !== "ok") throw new HttpError(400, "Wrong email or code");
        // Only after code proof — a disabled account never got a code, but a
        // stale one could linger; either way don't leak standing to guessers.
        if (user.disabled) throw new HttpError(400, "Account disabled");

        if (!user.activated) {
          // The invite gate (ABUSE.md Tier 0) sits HERE, at graduation, and
          // only after code proof — the caller has demonstrated mailbox
          // ownership, so a 403 reveals nothing about which emails are
          // registered. The cost: a failed invite spends the login code
          // (consumed above); the client offers a fresh-code retry.
          const needsInvite = config.signupInviteOnly;
          const inviteCode = req.body.invite?.trim();
          if (needsInvite && !inviteCode) {
            throw new HttpError(403, "Signups are invite-only — an invite code is required");
          }
          await graduateUser(user.id, email, needsInvite ? inviteCode : undefined);
        }

        // Keys are stored hashed, so every verify mints a fresh one. A code
        // round-trip is our strongest re-auth, so the key starts in sudo mode
        // (gates POST /api_key for SUDO_MODE_MINUTES_VALID).
        const apiKey = generateApiKey();
        await db.insert(apiKeys).values({
          userId: user.id,
          keyHash: hashApiKey(apiKey),
          name: req.body.device ?? null,
          sudoModeAt: new Date(),
        });

        return {
          name: user.name ?? "",
          email: user.email,
          mfa_enabled: false,
          mfa_key: null,
          api_key: apiKey,
        };
      },
    });
  });
}
