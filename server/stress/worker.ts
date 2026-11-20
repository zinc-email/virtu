import {
  SCENARIOS,
  assertScratchDatabase,
  isDatabaseScenario,
  stressConfig,
  effectiveStressConfig,
  stressWorkload,
  type WorkerScenario,
} from "./config.ts";

// Check before importing anything that opens a socket or a database connection.
if (process.env.MAIL_STRESS !== "1" || process.env.MAIL_STRESS_WORKER !== "1") {
  throw new Error("Stress workers must be launched by the explicitly enabled stress runner");
}
const scenario = process.argv[2] as WorkerScenario;
if (scenario !== "queue-seed" && !SCENARIOS.includes(scenario))
  throw new Error("Unknown stress scenario");
if (isDatabaseScenario(scenario)) assertScratchDatabase(process.env.DATABASE_URL ?? "");
delete process.env.MAIL_STRESS_ADMIN_DATABASE_URL;
const configured = stressConfig(process.argv[3] ?? "smoke");
const config = effectiveStressConfig(configured, scenario);
const workload = stressWorkload(configured, scenario);
const started = performance.now();
let sampledPeak = process.memoryUsage().rss;
const sample = () => {
  const rssBytes = process.memoryUsage().rss;
  sampledPeak = Math.max(sampledPeak, rssBytes);
  console.log(JSON.stringify({ type: "sample", rssBytes }));
};
const timer = setInterval(sample, 200);
try {
  let metrics: Record<string, number>;
  if (scenario === "auth-pressure") {
    metrics = await (await import("./auth.ts")).runAuthPressure(config);
  } else if (scenario === "inbound-mix") {
    metrics = await (await import("./inbound.ts")).runInboundMix(config);
  } else if (isDatabaseScenario(scenario)) {
    const db = await import("./database.ts");
    metrics = await {
      fanout: db.runFanout,
      "queue-seed": db.seedQueue,
      "queue-recovery": db.runQueueRecovery,
      "queue-combined": db.runQueueCombined,
    }[scenario](config);
  } else {
    const smtp = await import("./smtp.ts");
    metrics = await {
      "smtp-load": smtp.runSmtpLoad,
      "smtp-overload": smtp.runSmtpOverload,
      "outbound-backpressure": smtp.runOutboundBackpressure,
    }[scenario as "smtp-load"](config);
  }
  const peakRssBytes = Math.max(sampledPeak, process.resourceUsage().maxRSS * 1024);
  if (peakRssBytes > config.rssLimitBytes)
    throw new Error(`Peak RSS ${peakRssBytes} exceeds ${config.rssLimitBytes}`);
  const elapsedMs = performance.now() - started;
  const messages = metrics.acceptedCopies ?? metrics.accepted;
  if (messages !== undefined) metrics.messagesPerSecond = (messages * 1000) / elapsedMs;
  if (metrics.bytesVerified !== undefined)
    metrics.verifiedMiBPerSecond = (metrics.bytesVerified * 1000) / elapsedMs / 1024 / 1024;
  console.log(
    JSON.stringify({
      type: "result",
      ok: true,
      workload,
      elapsedMs: performance.now() - started,
      peakRssBytes,
      metrics,
    }),
  );
  clearInterval(timer);
  process.exit(0);
} catch (error) {
  clearInterval(timer);
  console.log(
    JSON.stringify({
      type: "result",
      ok: false,
      workload,
      peakRssBytes: Math.max(sampledPeak, process.resourceUsage().maxRSS * 1024),
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
