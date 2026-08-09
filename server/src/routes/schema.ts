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
