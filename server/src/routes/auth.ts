// POST /api/auth/{register,activate,reactivate,login} — SimpleLogin-
// compatible (tmp/simple-login/app/docs/api.md + app/api/views/auth.py).
// Exact error strings and field names; {"error": "..."} envelope via the
// shared handler.
//
// Registration creates an unactivated account and emails a 6-digit code
// (verification_codes + pipeline/transactional); /auth/activate consumes it
// (400 wrong / 410 after too many tries), /auth/reactivate resends behind a
// sent_alerts budget. Login for an unactivated account is SimpleLogin's
// 422 {"error": "Account not activated"}.
//
// Registered in its own encapsulated context so the per-IP rate limit
// (SimpleLogin's 10/minute) applies only to the auth surface.

import rateLimit from "@fastify/rate-limit";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "../auth/apiKey";
import { db } from "../db";
import { apiKeys, mailboxes, users } from "../db/schema";
import {
  ACCOUNT_ACTIVATION_ALERT_TYPE,
  accountActivationEmail,
  consumeVerificationCode,
  createVerificationCode,
  isRateLimited,
  sendWithRateLimit,
} from "../pipeline/transactional";
import { HttpError } from "./httpError";
import { ErrorResponse } from "./schema";

const RegisterPost = z
  .object({
    email: z.string(),
    password: z.string(),
  })
  .meta({
    id: "AuthRegisterRequest",
    example: { email: "user@example.com", password: "correct horse battery staple" },
  });

const MsgResponse = z.object({ msg: z.string() }).meta({ id: "MsgResponse" });

const ActivatePost = z
  .object({
    email: z.string(),
    code: z.string(),
  })
  .meta({
    id: "AuthActivateRequest",
    example: { email: "user@example.com", code: "662302" },
  });

const ReactivatePost = z
  .object({ email: z.string() })
  .meta({ id: "AuthReactivateRequest", example: { email: "user@example.com" } });

const LoginPost = z
  .object({
    email: z.string(),
    password: z.string(),
    // Device name; becomes the API key's name so the user can manage keys.
    device: z.string().optional(),
  })
  .meta({
    id: "AuthLoginRequest",
    example: { email: "user@example.com", password: "hunter2!!", device: "Chrome extension" },
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

// Deliberately loose — real deliverability checks (MX etc., SimpleLogin's
// email_can_be_used_as_mailbox) are a wave-2 concern.
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// SimpleLogin: trial_end defaults to now + 7 days + 1 hour.
const TRIAL_MS = (7 * 24 + 1) * 60 * 60 * 1000;

// Verify against *some* hash when the account doesn't exist so response
// timing doesn't reveal which emails are registered.
const dummyHash = await Bun.password.hash("dummy-password-for-constant-work", {
  algorithm: "argon2id",
});

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? err.code : undefined;
  const message = err instanceof Error ? err.message : "";
  return code === "23505" || message.includes("duplicate key");
}

/** Create the activation code and email it (rate-controlled resends). */
async function sendActivationCode(userId: number, email: string): Promise<void> {
  const { code, row } = await createVerificationCode(db, { userId, purpose: "account" });
  const { subject, textBody } = accountActivationEmail(code);
  await sendWithRateLimit(db, {
    userId,
    alertType: ACCOUNT_ACTIVATION_ALERT_TYPE,
    to: email,
    subject,
    textBody,
    refId: row.id,
  });
}

export async function withAuthRoutes(api: FastifyInstance) {
  await api.register(async (authCtx) => {
    await authCtx.register(rateLimit, {
      max: 10,
      timeWindow: "1 minute",
      // Must return an Error (thrown into the shared envelope handler) — a
      // plain { error } object would serialize as a 500.
      errorResponseBuilder: () => new HttpError(429, "Too many requests"),
    });

    const a = authCtx.withTypeProvider<FastifyZodOpenApiTypeProvider>();

    a.route({
      method: "POST",
      url: "/auth/register",
      schema: {
        description:
          "Register a new account. The account starts unactivated: a 6-digit activation " +
          "code (15-minute expiry) is emailed to the address; confirm it via " +
          "POST /auth/activate before logging in.",
        tags: ["Account"],
        body: RegisterPost,
        response: { 200: MsgResponse, 400: ErrorResponse, 429: ErrorResponse },
      },
      handler: async (req) => {
        const email = normalizeEmail(req.body.email);
        const { password } = req.body;

        if (!looksLikeEmail(email)) {
          throw new HttpError(400, `cannot use ${email} as personal inbox`);
        }
        if (password.length < 8) throw new HttpError(400, "password too short");
        if (password.length > 100) throw new HttpError(400, "password too long");

        const existing = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (existing.length > 0) {
          throw new HttpError(400, `cannot use ${email} as personal inbox`);
        }

        const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });

        let userId: number;
        try {
          userId = await db.transaction(async (tx) => {
            const inserted = await tx
              .insert(users)
              .values({
                email,
                // SimpleLogin sets name to the email as typed.
                name: req.body.email,
                passwordHash,
                activated: false,
                trialEnd: new Date(Date.now() + TRIAL_MS),
              })
              .returning({ id: users.id });
            const id = inserted[0]?.id;
            if (id === undefined) throw new Error("insert returned no id");

            // The default mailbox is the user's own address (SimpleLogin
            // User.create does the same). Born verified: the activation code
            // is delivered to this exact address, so activating the account
            // proves control of it.
            const mailbox = await tx
              .insert(mailboxes)
              .values({ userId: id, email, verified: true })
              .returning({ id: mailboxes.id });
            const mailboxId = mailbox[0]?.id;
            if (mailboxId === undefined) throw new Error("mailbox insert returned no id");

            await tx.update(users).set({ defaultMailboxId: mailboxId }).where(eq(users.id, id));
            return id;
          });
        } catch (err) {
          // Unique-violation race between the pre-check and the insert.
          if (isUniqueViolation(err)) {
            throw new HttpError(400, `cannot use ${email} as personal inbox`);
          }
          throw err;
        }

        // After commit, so a rolled-back registration never emails a code.
        await sendActivationCode(userId, email);

        return { msg: "User needs to confirm their account" };
      },
    });

    a.route({
      method: "POST",
      url: "/auth/activate",
      schema: {
        description:
          "Enter the emailed activation code to confirm the account. 400 on a wrong " +
          "email/code, 410 once the code has been tried wrongly too many times " +
          "(request a new one via /auth/reactivate).",
        tags: ["Account"],
        body: ActivatePost,
        response: { 200: MsgResponse, 400: ErrorResponse, 410: ErrorResponse, 429: ErrorResponse },
      },
      handler: async (req) => {
        const email = normalizeEmail(req.body.email);
        const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
        const user = found[0];
        // Same message either way — never expose whether the email exists.
        if (!user || user.activated) throw new HttpError(400, "Wrong email or code");

        const result = await consumeVerificationCode(db, {
          userId: user.id,
          purpose: "account",
          code: req.body.code,
          toEmail: email,
        });
        if (result === "too_many") throw new HttpError(410, "Too many wrong tries");
        if (result !== "ok") throw new HttpError(400, "Wrong email or code");

        await db.update(users).set({ activated: true }).where(eq(users.id, user.id));
        return { msg: "Account is activated, user can login now" };
      },
    });

    a.route({
      method: "POST",
      url: "/auth/reactivate",
      schema: {
        description:
          "Resend the activation code. Budgeted per account (3 emails/hour, the " +
          "register email included): 429 when over budget — a deviation from " +
          "SimpleLogin, which relies on its per-IP limit alone.",
        tags: ["Account"],
        body: ReactivatePost,
        response: { 200: MsgResponse, 400: ErrorResponse, 429: ErrorResponse },
      },
      handler: async (req) => {
        const email = normalizeEmail(req.body.email);
        const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
        const user = found[0];
        // SimpleLogin's exact strings (the first one deliberately vague).
        if (!user || user.activated) throw new HttpError(400, "Something went wrong");
        if (user.disabled) throw new HttpError(400, "User is disabled");

        // Budget check BEFORE invalidating the previous code, so hammering
        // this endpoint cannot kill a code that is still in flight.
        if (
          await isRateLimited(db, {
            userId: user.id,
            toEmail: email,
            alertType: ACCOUNT_ACTIVATION_ALERT_TYPE,
          })
        ) {
          throw new HttpError(429, "Too many activation emails requested, try again later");
        }

        await sendActivationCode(user.id, email);
        return { msg: "User needs to confirm their account" };
      },
    });

    a.route({
      method: "POST",
      url: "/auth/login",
      schema: {
        description:
          "Authenticate and obtain an api_key for the Authentication header. " +
          "MFA is not implemented: mfa_enabled is always false and mfa_key null. " +
          "An unactivated account gets 422 (activate first).",
        tags: ["Account"],
        body: LoginPost,
        response: {
          200: LoginResponse,
          400: ErrorResponse,
          422: ErrorResponse,
          429: ErrorResponse,
        },
      },
      handler: async (req) => {
        const email = normalizeEmail(req.body.email);
        const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
        const user = found[0];

        const ok = await Bun.password.verify(req.body.password, user?.passwordHash ?? dummyHash);
        if (!user || !ok) throw new HttpError(400, "Email or password incorrect");
        if (user.disabled) throw new HttpError(400, "Account disabled");
        if (!user.activated) throw new HttpError(422, "Account not activated");

        // Keys are stored hashed, so unlike SimpleLogin we can't return an
        // existing device key — every login mints a fresh one.
        const code = generateApiKey();
        await db.insert(apiKeys).values({
          userId: user.id,
          keyHash: hashApiKey(code),
          name: req.body.device ?? null,
        });

        return {
          name: user.name ?? "",
          email: user.email,
          mfa_enabled: false,
          mfa_key: null,
          api_key: code,
        };
      },
    });
  });
}
