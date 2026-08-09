// The SimpleLogin error envelope: every 4xx/5xx body is {"error": "..."}.
// Handlers/hooks throw HttpError; the shared error handler formats it.

import type { FastifyReply, FastifyRequest } from "fastify";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorEnvelopeHandler(
  err: Error & { statusCode?: number; validation?: unknown },
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof HttpError) {
    reply.status(err.statusCode).send({ error: err.message });
    return;
  }
  // fastify-zod-openapi validation failures carry .validation; surface the
  // message so development errors are diagnosable (SimpleLogin does the same
  // with e.g. "request body cannot be empty").
  if (err.validation) {
    reply.status(400).send({ error: err.message });
    return;
  }
  req.log.error(err);
  reply.status(500).send({ error: "Internal server error" });
}
