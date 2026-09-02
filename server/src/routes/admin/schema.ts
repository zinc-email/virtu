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
    // Durable attribution (Lane K P2): the owning account, independent of
    // VERP validity. Null on unowned system mail and pre-P2 rows.
    user_id: z.number().int().nullable(),
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
    // Null when the owner came from the durable attribution columns rather
    // than a decodable VERP return path (DSNs, trash copies, expired VERP).
    verp_type: VerpTypeDto.nullable(),
    verp_id: z.number().int().nullable(),
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
    "flagged_inbound",
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

// A user reference on admin DTOs — enough to link, never more.
export const AdminUserRef = z
  .object({ id: z.number().int(), email: z.string() })
  .meta({ id: "AdminUserRef" });

export const AdminInvite = z
  .object({
    id: z.number().int(),
    code: z.string(),
    note: z.string().nullable(),
    created_by: AdminUserRef.nullable(),
    used_by: AdminUserRef.nullable(),
    used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .meta({ id: "AdminInvite" });

export const AdminInviteListResponse = z
  .object({
    total: z.number().int(),
    unused: z.number().int(),
    invites: z.array(AdminInvite),
  })
  .meta({ id: "AdminInviteListResponse" });

export const AdminInviteCreateBody = z
  .object({
    count: z.number().int().min(1).max(100).default(1),
    note: z.string().max(256).optional(),
    expires_in_days: z.number().int().min(1).max(365).optional(),
  })
  .meta({ id: "AdminInviteCreateBody", example: { count: 1, note: "for jane" } });

export const AdminInviteCreatedResponse = z
  .object({ invites: z.array(AdminInvite) })
  .meta({ id: "AdminInviteCreatedResponse" });

export const AdminInviteDeletedResponse = z
  .object({ deleted: z.number().int() })
  .meta({ id: "AdminInviteDeletedResponse" });

// Operator mail (pipeline/operatorMail.ts): who receives postmaster@/abuse@.
export const AdminOperator = z
  .object({
    id: z.number().int(),
    email: z.string(),
    // The opt-in flag (users.flags operatorMail bit).
    receives_operator_mail: z.boolean(),
    // True when this operator is in the effective recipient set right now:
    // opted in, or the first operator when nobody has opted in.
    effective: z.boolean(),
    // The default mailbox operator mail would deliver to, and whether it
    // clears the delivery bar (verified, not disabled, not suppressed).
    mailbox: z.string().nullable(),
    mailbox_deliverable: z.boolean(),
  })
  .meta({ id: "AdminOperator" });

export const AdminOperatorListResponse = z
  .object({
    // The role localparts routed (config.operatorLocalparts).
    localparts: z.array(z.string()),
    operators: z.array(AdminOperator),
  })
  .meta({ id: "AdminOperatorListResponse" });

export const AdminOperatorUpdateBody = z
  .object({ receives_operator_mail: z.boolean() })
  .meta({ id: "AdminOperatorUpdateBody", example: { receives_operator_mail: true } });

// Per-destination throttle (queue/destinationThrottle.ts).
export const DeliveryStepDto = z
  .enum(["greeting", "ehlo", "starttls", "mail_from", "rcpt_to", "data"])
  .meta({ id: "DeliveryStep" });

export const AdminDestination = z
  .object({
    domain: z.string(),
    // Provider bucket (metrics/provider.ts): gmail | microsoft | … | other.
    provider: z.string(),
    // Null when not paused; otherwise the pause end.
    paused_until: z.string().nullable(),
    strikes: z.number().int(),
    pauses: z.number().int(),
    last_code: z.number().int().nullable(),
    last_enhanced: z.string().nullable(),
    last_step: DeliveryStepDto.nullable(),
    last_reply: z.string().nullable(),
    last_deferred_at: z.string().nullable(),
  })
  .meta({ id: "AdminDestination" });

export const AdminDestinationListResponse = z
  .object({
    paused: z.number().int(),
    destinations: z.array(AdminDestination),
  })
  .meta({ id: "AdminDestinationListResponse" });

export const AdminDestinationClearedResponse = z
  .object({ domain: z.string(), cleared: z.boolean() })
  .meta({ id: "AdminDestinationClearedResponse" });

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
    // Destinations currently paused by the outbound throttle.
    destinations_paused: z.number().int(),
  })
  .meta({ id: "AdminOverviewResponse" });
