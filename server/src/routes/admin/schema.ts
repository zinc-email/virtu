// Admin DTOs (PLAN Lane K / decision #16). Operator endpoints are a Virtu
// extension, not SimpleLogin wire — so unlike the public surface they may
// carry totals and a limit parameter. snake_case anyway, one API voice.

import { z } from "zod";

export const OutboundStatusDto = z
  .enum(["pending", "sending", "sent", "failed"])
  .meta({ id: "OutboundStatus" });

export const VerpTypeDto = z
  .enum(["bounce_forward", "bounce_reply", "transactional"])
  .meta({ id: "VerpType" });

export const AdminQueueMessage = z
  .object({
    id: z.number().int(),
    status: OutboundStatusDto,
    tries: z.number().int(),
    envelope_from: z.string(),
    envelope_to: z.string(),
    next_attempt_at: z.string(),
    claimed_at: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.string(),
    // octet_length(raw) — the list never selects the raw bytes themselves.
    size_bytes: z.number().int(),
    // Decoded from envelope_from when it HMAC-verifies as ours; null for the
    // null reverse path (DSNs, trash copies) and expired/foreign addresses.
    verp_type: VerpTypeDto.nullable(),
  })
  .meta({ id: "AdminQueueMessage" });

export const AdminQueueListResponse = z
  .object({
    total: z.number().int(),
    messages: z.array(AdminQueueMessage),
  })
  .meta({ id: "AdminQueueListResponse" });

// Routing headers only (an allowlist — see headerAllowlist.ts). Never the
// Subject, never the body: the raw bytea is users' mail; operators debug
// routing, not content.
export const AdminMessageHeader = z
  .object({ name: z.string(), value: z.string() })
  .meta({ id: "AdminMessageHeader" });

export const AdminQueueOwner = z
  .object({
    verp_type: VerpTypeDto,
    verp_id: z.number().int(),
    email_log_id: z.number().int().nullable(),
    verification_code_id: z.number().int().nullable(),
    user: z.object({ id: z.number().int(), email: z.string() }).nullable(),
    alias: z.object({ id: z.number().int(), email: z.string() }).nullable(),
  })
  .meta({ id: "AdminQueueOwner" });

export const AdminQueueMessageDetailResponse = z
  .object({
    message: AdminQueueMessage,
    headers: z.array(AdminMessageHeader),
    owner: AdminQueueOwner.nullable(),
  })
  .meta({ id: "AdminQueueMessageDetailResponse" });

export const AdminIdsBody = z
  .object({ ids: z.array(z.number().int().min(1)).min(1).max(100) })
  .meta({ id: "AdminIdsBody" });

export const AdminDroppedResponse = z
  .object({ dropped: z.number().int(), ids: z.array(z.number().int()) })
  .meta({ id: "AdminDroppedResponse" });

export const AdminRequeuedResponse = z
  .object({ requeued: z.number().int(), ids: z.array(z.number().int()) })
  .meta({ id: "AdminRequeuedResponse" });

export const AdminDeletedResponse = z
  .object({ deleted: z.number().int(), ids: z.array(z.number().int()) })
  .meta({ id: "AdminDeletedResponse" });

export const AdminBounceSkipReason = z
  .enum([
    "unknown_id",
    "already_delivered",
    "null_reverse_path",
    "no_verp_mapping",
    "transactional",
    "raw_cleared",
    "email_log_missing",
    "originator_unresolvable",
    "alias_unresolvable",
    "in_flight",
  ])
  .meta({ id: "AdminBounceSkipReason" });

export const AdminBouncedResponse = z
  .object({
    bounced: z.number().int(),
    ids: z.array(z.number().int()),
    skipped: z.array(z.object({ id: z.number().int(), reason: AdminBounceSkipReason })),
  })
  .meta({ id: "AdminBouncedResponse" });

export const AdminOverviewResponse = z
  .object({
    queue: z.object({
      pending: z.number().int(),
      sending: z.number().int(),
      failed: z.number().int(),
      sent_24h: z.number().int(),
      oldest_pending_age_seconds: z.number().int().nullable(),
    }),
    activity_24h: z.object({
      forwards: z.number().int(),
      replies: z.number().int(),
      bounces: z.number().int(),
      blocked: z.number().int(),
    }),
    users: z.object({
      total: z.number().int(),
      disabled: z.number().int(),
    }),
  })
  .meta({ id: "AdminOverviewResponse" });
