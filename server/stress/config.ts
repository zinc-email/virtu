export const SCENARIOS = [
  "smtp-load",
  "smtp-overload",
  "outbound-backpressure",
  "fanout",
  "queue-recovery",
  "queue-combined",
  "auth-pressure",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type WorkerScenario = Scenario | "queue-seed";
export interface StressConfig {
  profile: "smoke" | "load";
  messageBytes: number;
  queueMessageBytes: number;
  clients: number;
  copies: number;
  queueWorkers: number;
  rounds: number;
  rssLimitBytes: number;
  timeoutMs: number;
}

export function stressConfig(
  profile: string,
  env: Record<string, string | undefined> = process.env,
): StressConfig {
  if (profile !== "smoke" && profile !== "load") throw new Error("Profile must be smoke or load");
  const heavy = profile === "load";
  const number = (key: string, fallback: number, max: number, min = 1) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return value;
  };
  return {
    profile,
    messageBytes: number("MAIL_STRESS_MESSAGE_MIB", heavy ? 25 : 1, 25) * 1024 * 1024,
    queueMessageBytes:
      number("MAIL_STRESS_QUEUE_MESSAGE_MIB", Number(env.MAIL_STRESS_MESSAGE_MIB ?? 1), 25) *
      1024 *
      1024,
    clients: number("MAIL_STRESS_CLIENTS", heavy ? 16 : 8, 128),
    queueWorkers: number("MAIL_STRESS_QUEUE_WORKERS", 2, 32, 2),
    copies: number("MAIL_STRESS_COPIES", heavy ? 100 : 8, 1000, 2),
    rounds: number("MAIL_STRESS_ROUNDS", heavy ? 3 : 2, 100),
    rssLimitBytes: number("MAIL_STRESS_RSS_MIB", 768, 65536) * 1024 * 1024,
    timeoutMs: number("MAIL_STRESS_TIMEOUT_SECONDS", heavy ? 600 : 90, 3600) * 1000,
  };
}

export function isDatabaseScenario(
  scenario: WorkerScenario,
): scenario is "fanout" | "queue-recovery" | "queue-combined" | "queue-seed" {
  return (
    scenario === "fanout" ||
    scenario === "queue-recovery" ||
    scenario === "queue-combined" ||
    scenario === "queue-seed"
  );
}

/** The actual inputs for each measured process, including queue preparation. */
export function effectiveStressConfig(
  config: StressConfig,
  scenario: WorkerScenario,
): StressConfig {
  return {
    ...config,
    messageBytes:
      scenario === "queue-seed" || scenario === "queue-recovery"
        ? config.queueMessageBytes
        : config.messageBytes,
    queueWorkers: scenario === "queue-combined" ? 1 : config.queueWorkers,
  };
}

export type StressWorkload = Pick<
  StressConfig,
  "messageBytes" | "clients" | "copies" | "rounds" | "queueWorkers"
>;

export function stressWorkload(config: StressConfig, scenario: WorkerScenario): StressWorkload {
  const { messageBytes, clients, copies, rounds, queueWorkers } = effectiveStressConfig(
    config,
    scenario,
  );
  return { messageBytes, clients, copies, rounds, queueWorkers };
}

export function assertScratchDatabase(url: string): void {
  const parsed = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^\/virtu_stress_[a-f0-9]{32}$/.test(parsed.pathname)
  ) {
    throw new Error("Stress workers require a generated virtu_stress_<uuid> database");
  }
}
