/**
 * Delivery queue (PLAN Lane D): `enqueue` is the only entry point for
 * outbound mail; the worker drains outbound_messages with FOR UPDATE SKIP
 * LOCKED, delivers over SMTP and classifies failures.
 */

export { BASE_DELAY_MS, JITTER, MAX_DELAY_MS, backoffDelayMs } from "./backoff.ts";
export { DEFAULT_MAX_RAW_BYTES, enqueue, type EnqueueInput } from "./enqueue.ts";
export {
  classifySendResult,
  type DeliverFn,
  deliverOverSmtp,
  type DeliveryOutcome,
  type MxTarget,
  processQueueOnce,
  type QueueWorker,
  type QueueWorkerOptions,
  resolveMxTargets,
  type SmtpDeliveryOptions,
  startQueueWorker,
} from "./worker.ts";
