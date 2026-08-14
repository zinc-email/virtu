/**
 * Delivery queue (PLAN Lane D): `enqueue` is the only entry point for
 * outbound mail; the worker drains outbound_messages with FOR UPDATE SKIP
 * LOCKED, delivers over SMTP and classifies failures.
 */

export { DROPPED_BY_OPERATOR, deleteMessages, dropMessages, requeueMessages } from "./admin.ts";
export {
  BASE_DELAY_MS,
  type BackoffOptions,
  backoffDelayMs,
  JITTER,
  MAX_DELAY_MS,
} from "./backoff.ts";
export { DEFAULT_MAX_RAW_BYTES, enqueue, type EnqueueInput } from "./enqueue.ts";
export { type ReapOptions, reapStuckSending } from "./reaper.ts";
export { type RetentionOptions, runRetentionOnce } from "./retention.ts";
export {
  classifySendResult,
  type DeliverFn,
  deliverOverSmtp,
  type DeliveryOutcome,
  type MxTarget,
  processQueueOnce,
  type QueueHygieneOptions,
  type QueueWorker,
  type QueueWorkerOptions,
  resolveMxTargets,
  type SmtpDeliveryOptions,
  startQueueWorker,
} from "./worker.ts";
