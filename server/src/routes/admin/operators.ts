// Operator mail routing (pipeline/operatorMail.ts): which admins receive the
// RFC 2142 role addresses (postmaster@, abuse@ …) on the service domain.
// List = every admin with their opt-in flag and whether they are in the
// EFFECTIVE set (opted in, or the first admin when nobody has opted in);
// PATCH flips one admin's flag and returns the recomputed list, so the
// client never has to reproduce the fallback rule. Registered inside the
// requireAdmin scope (routes/index.ts).

import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { receivesOperatorMail } from "../../auth/userFlags";
import { config } from "../../config";
import { db } from "../../db";
import { effectiveOperators, listOperators, setOperatorMail } from "../../pipeline/operatorMail";
import { mailboxDeliverable } from "../../pipeline/policy";
import { HttpError } from "../httpError";
import { ErrorResponse } from "../schema";
import { AdminOperatorListResponse, AdminOperatorUpdateBody } from "./schema";

async function operatorList() {
  const operators = await listOperators(db);
  const effective = new Set(effectiveOperators(operators).map((o) => o.user.id));
  return {
    localparts: config.operatorLocalparts,
    operators: operators.map((o) => ({
      id: o.user.id,
      email: o.user.email,
      receives_operator_mail: receivesOperatorMail(o.user),
      effective: effective.has(o.user.id),
      mailbox: o.mailbox?.email ?? null,
      mailbox_deliverable: o.mailbox !== null && mailboxDeliverable(o.mailbox),
    })),
  };
}

export async function withAdminOperatorRoutes(admin: FastifyInstance) {
  const a = admin.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/operators",
    schema: {
      description:
        "Operators (admins) and who receives operator mail — postmaster@, abuse@ and " +
        "the other role addresses on the service domain. `effective` marks the " +
        "current recipients: the opted-in operators, or the first operator when " +
        "nobody has opted in.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: AdminOperatorListResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: operatorList,
  });

  a.route({
    method: "PATCH",
    url: "/operators/:id",
    schema: {
      description:
        "Opt an operator in to (or out of) operator mail. 404 unless the id is an " +
        "active operator. Returns the recomputed list.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      params: z.object({ id: z.coerce.number().int().min(1) }),
      body: AdminOperatorUpdateBody,
      response: {
        200: AdminOperatorListResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (req) => {
      const operators = await listOperators(db);
      if (!operators.some((o) => o.user.id === req.params.id)) {
        throw new HttpError(404, "No active operator with that id");
      }
      await setOperatorMail(db, req.params.id, req.body.receives_operator_mail);
      return operatorList();
    },
  });
}
