// Shared route schemas. Field names copy SimpleLogin's serializers verbatim
// (tmp/simple-login/app/app/api/serializer.py) — snake_case on the wire.
// Where a field mirrors a DB column, derive it from the drizzle-zod select
// schema so the contract can't drift from db/schema.ts.

import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "../db/schema";

export const userSelect = createSelectSchema(users);

export const ErrorResponse = z
  .object({ error: z.string() })
  .meta({ id: "ErrorResponse", description: "SimpleLogin-compatible error envelope" });

// GET /user_info (and PATCH later). Docs: tmp/simple-login/app/docs/api.md.
export const UserInfoResponse = z
  .object({
    name: z.string(),
    is_premium: z.boolean(),
    email: userSelect.shape.email,
    in_trial: z.boolean(),
    trial_end_timestamp: z.number().int().nullable(),
    max_alias_free_plan: z.number().int(),
    connected_proton_address: z.string().nullable(),
    can_create_reverse_alias: z.boolean(),
    profile_picture_url: z.string().nullable(),
  })
  .meta({ id: "UserInfoResponse" });

export type UserInfo = z.infer<typeof UserInfoResponse>;

// ---------------------------------------------------------------------------
// Aliases (serialize_alias_info_v2 shape — docs/api.md GET /aliases/:alias_id)
// ---------------------------------------------------------------------------

export const MailboxLite = z
  .object({ id: z.number().int(), email: z.string() })
  .meta({ id: "MailboxLite" });

export const ActivityAction = z
  .enum(["forward", "reply", "block", "bounced"])
  .meta({ id: "ActivityAction" });

export const LatestActivity = z
  .object({
    action: ActivityAction,
    timestamp: z.number().int(),
    contact: z.object({
      email: z.string(),
      name: z.string().nullable(),
      reverse_alias: z.string(),
    }),
  })
  .meta({ id: "LatestActivity" });

export const AliasDto = z
  .object({
    id: z.number().int(),
    email: z.string(),
    creation_date: z.string(),
    creation_timestamp: z.number().int(),
    enabled: z.boolean(),
    note: z.string().nullable(),
    name: z.string().nullable(),
    nb_forward: z.number().int(),
    nb_block: z.number().int(),
    nb_reply: z.number().int(),
    mailbox: MailboxLite,
    mailboxes: z.array(MailboxLite),
    support_pgp: z.boolean(),
    disable_pgp: z.boolean(),
    latest_activity: LatestActivity.nullable(),
    pinned: z.boolean(),
  })
  .meta({ id: "Alias" });

export const AliasesResponse = z.object({ aliases: z.array(AliasDto) }).meta({
  id: "AliasesResponse",
});

// POST /v3/alias/custom/new + /alias/random/new: alias info plus the bare
// address under `alias` (SimpleLogin returns both).
export const CreatedAliasResponse = AliasDto.extend({ alias: z.string() }).meta({
  id: "CreatedAliasResponse",
});

// ---------------------------------------------------------------------------
// Contacts (serialize_contact shape)
// ---------------------------------------------------------------------------

export const ContactDto = z
  .object({
    id: z.number().int(),
    contact: z.string(),
    creation_date: z.string(),
    creation_timestamp: z.number().int(),
    last_email_sent_date: z.string().nullable(),
    last_email_sent_timestamp: z.number().int().nullable(),
    reverse_alias: z.string(),
    reverse_alias_address: z.string(),
    block_forward: z.boolean(),
    existed: z.boolean(),
  })
  .meta({ id: "Contact" });

// ---------------------------------------------------------------------------
// Mailboxes (mailbox_to_dict shape)
// ---------------------------------------------------------------------------

export const MailboxDto = z
  .object({
    id: z.number().int(),
    email: z.string(),
    verified: z.boolean(),
    default: z.boolean(),
    creation_timestamp: z.number().int(),
    nb_alias: z.number().int(),
    // Virtu extension (not in SimpleLogin): true when this mailbox is the
    // account's trash inbox — mail for disabled ("off") aliases lands here.
    trash: z.boolean(),
  })
  .meta({ id: "Mailbox" });

// ---------------------------------------------------------------------------
// SMTP credentials (per-device submission passwords — Virtu extension)
// ---------------------------------------------------------------------------

export const SmtpCredentialDto = z
  .object({
    id: z.number().int(),
    name: z.string(),
    creation_timestamp: z.number().int(),
    last_used_timestamp: z.number().int().nullable(),
  })
  .meta({ id: "SmtpCredential" });

export const SmtpCredentialCreatedDto = z
  .object({
    ...SmtpCredentialDto.shape,
    // Shown exactly once; only a hash is stored.
    password: z.string(),
  })
  .meta({ id: "SmtpCredentialCreated" });

// ---------------------------------------------------------------------------
// Small envelopes shared across route groups
// ---------------------------------------------------------------------------

export const DeletedResponse = z.object({ deleted: z.boolean() }).meta({ id: "DeletedResponse" });
export const OkResponse = z.object({ ok: z.boolean() }).meta({ id: "OkResponse" });
export const UpdatedResponse = z.object({ updated: z.boolean() }).meta({ id: "UpdatedResponse" });
export const EnabledResponse = z.object({ enabled: z.boolean() }).meta({ id: "EnabledResponse" });
