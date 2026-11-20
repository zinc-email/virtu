import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SCENARIOS,
  assertScratchDatabase,
  isDatabaseScenario,
  stressConfig,
  stressWorkload,
  type StressWorkload,
  type WorkerScenario,
  type Scenario,
} from "./config.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--list") {
  console.log(SCENARIOS.join("\n"));
  process.exit(0);
}
if (process.env.MAIL_STRESS !== "1") {
  console.error("Disabled: set MAIL_STRESS=1 to run stress tests. Use --list to list scenarios.");
  process.exit(2);
}
let profile = "smoke";
let selected: readonly Scenario[] = SCENARIOS;
let output: string | undefined;
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (!value) throw new Error(`Missing value for ${args[i]}`);
  if (args[i] === "--profile") profile = value;
  else if (args[i] === "--scenario") {
    const names = value.split(",");
    if (!names.every((name) => SCENARIOS.includes(name as Scenario)))
      throw new Error("Unknown scenario");
    selected = [...new Set(names)] as Scenario[];
  } else if (args[i] === "--output") output = value;
  else throw new Error(`Unknown option ${args[i]}`);
}
const config = stressConfig(profile);
const adminUrl = process.env.MAIL_STRESS_ADMIN_DATABASE_URL;
if (selected.some(isDatabaseScenario) && !adminUrl) {
  throw new Error(
    "Database scenarios require MAIL_STRESS_ADMIN_DATABASE_URL with CREATEDB permission; a fresh database is created for each scenario. DATABASE_URL is never used as the test target.",
  );
}
let interrupted = false;
let killActive: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
    killActive?.();
  });
}

type Result = {
  workload?: StressWorkload;
  ok: boolean;
  error?: string;
  elapsedMs?: number;
  peakRssBytes?: number;
  metrics?: Record<string, number>;
};

// Recheck elapsed time when a timer wakes: suspended hosts or clock adjustments
// must not turn an early timer callback into a false stress failure.
function deadlineAfter(ms: number, expire: () => void): () => void {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const remaining = ms - (performance.now() - started);
    if (remaining > 0) timer = setTimeout(check, Math.ceil(remaining));
    else expire();
  };
  timer = setTimeout(check, ms);
  return () => clearTimeout(timer);
}

async function child(
  argv: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
  scenario?: WorkerScenario,
): Promise<Result> {
  const measure = scenario !== undefined;
  const workload = scenario === undefined ? undefined : stressWorkload(config, scenario);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([process.execPath, "--no-env-file", ...argv], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { ok: false, workload, error: error instanceof Error ? error.message : String(error) };
  }
  let failure: string | undefined;
  let result: Result | undefined;
  let tail = "";
  let sampledPeak = 0;
  const started = performance.now();
  const stop = (reason: string) => {
    failure ??= reason;
    proc.kill("SIGKILL");
  };
  killActive = () => stop("Interrupted");
  const cancelDeadline = deadlineAfter(timeoutMs, () =>
    stop(`Deadline exceeded (${timeoutMs} ms)`),
  );
  const read = async (stream: ReadableStream<Uint8Array>, parse: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!parse) {
        tail = (tail + text).slice(-8192);
        if (measure) process.stderr.write(text);
        continue;
      }
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      if (pending.length > 65536 || lines.some((line) => line.length > 65536)) {
        stop("Worker output exceeded bounded line buffer");
        pending = "";
        continue;
      }
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "sample") {
          sampledPeak = Math.max(sampledPeak, event.rssBytes);
          if (event.rssBytes > config.rssLimitBytes)
            stop(`RSS limit exceeded (${event.rssBytes} bytes)`);
        }
        if (event.type === "result") result = event;
      }
    }
  };
  try {
    const [exitCode] = await Promise.all([
      proc.exited,
      read(proc.stdout, measure),
      read(proc.stderr, false),
    ]);
    if (failure)
      return {
        ok: false,
        workload,
        error: `${failure}${tail ? `; last output: ${tail}` : ""}`,
        elapsedMs: performance.now() - started,
        peakRssBytes: sampledPeak,
      };
    if (exitCode !== 0)
      return {
        ...result,
        workload,
        ok: false,
        error: result?.error ?? `Child exited ${exitCode}: ${tail}`,
      };
    return measure
      ? { ...(result ?? { ok: false, error: "Worker exited without a result" }), workload }
      : { ok: true };
  } finally {
    cancelDeadline();
    killActive = undefined;
  }
}

/** Server timeouts cannot bound a lost client connection; also enforce a local deadline. */
async function adminOperation<T>(admin: SQL, query: PromiseLike<T>, name: string): Promise<T> {
  let abort!: (reason: string) => void;
  const expired = new Promise<never>((_, reject) => {
    abort = (reason) => {
      void admin.close({ timeout: 0 }).catch(() => {});
      reject(new Error(`${name}: ${reason}`));
    };
  });
  const cancelDeadline = deadlineAfter(20_000, () => abort("admin deadline exceeded (20 seconds)"));
  killActive = () => abort("Interrupted");
  try {
    return await Promise.race([Promise.resolve(query), expired]);
  } finally {
    cancelDeadline();
    killActive = undefined;
  }
}

const results: Array<
  Result & {
    scenario: Scenario;
    scratchRemoved: boolean;
    scratchDatabase?: string;
    preparation?: Result;
  }
> = [];
const started = new Date().toISOString();
for (const scenario of selected) {
  if (interrupted) break;
  let admin: SQL | undefined;
  let databaseName: string | undefined;
  let attemptedDatabase: string | undefined;
  let preparation: Result | undefined;
  let result: Result = {
    ok: false,
    workload: stressWorkload(config, scenario),
    error: "Scenario did not finish",
  };
  let scratchRemoved = true;
  let spool: string | undefined;
  const env = {
    ...process.env,
    NODE_ENV: "test",
    MAIL_STRESS_WORKER: "1",
    SMTP_SPOOL_DIRECTORY: spool,
    DATABASE_URL: undefined,
    MAIL_STRESS_ADMIN_DATABASE_URL: undefined,
  };
  try {
    spool = await mkdtemp(join(tmpdir(), "virtu-stress-"));
    env.SMTP_SPOOL_DIRECTORY = spool;
    if (isDatabaseScenario(scenario)) {
      admin = new SQL(adminUrl!, { max: 1, connectionTimeout: 5 });
      await adminOperation(
        admin,
        admin.unsafe("SET statement_timeout = '15s'"),
        "Configure scratch connection",
      );
      const name = `virtu_stress_${crypto.randomUUID().replaceAll("-", "")}`;
      attemptedDatabase = name;
      await adminOperation(admin, admin.unsafe(`CREATE DATABASE "${name}"`), `Create ${name}`);
      databaseName = name; // Only this successfully created name may be dropped.
      const url = new URL(adminUrl!);
      url.pathname = `/${name}`;
      assertScratchDatabase(url.toString());
      Object.assign(env, { DATABASE_URL: url.toString() });
      const migrated = await child(["src/scripts/dbMigrate.ts"], env, 60000);
      if (!migrated.ok) throw new Error(migrated.error);
    }
    if (interrupted) throw new Error("Interrupted");
    if (scenario === "queue-recovery") {
      preparation = await child(
        ["stress/worker.ts", "queue-seed", profile],
        env,
        config.timeoutMs,
        "queue-seed",
      );
      if (!preparation.ok) throw new Error(`Queue preparation failed: ${preparation.error}`);
    }
    if (interrupted) throw new Error("Interrupted");
    result = await child(["stress/worker.ts", scenario, profile], env, config.timeoutMs, scenario);
  } catch (error) {
    result = {
      ok: false,
      workload: stressWorkload(config, scenario),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (attemptedDatabase && !databaseName) {
      scratchRemoved = false;
      result = {
        ...result,
        ok: false,
        error: `${result.error ?? ""} Creation was not confirmed; inspect ${attemptedDatabase} if the server lost its reply.`,
      };
    }
    if (databaseName && admin) {
      try {
        await adminOperation(
          admin,
          admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`),
          `Drop ${databaseName}`,
        );
      } catch (error) {
        scratchRemoved = false;
        result = {
          ...result,
          ok: false,
          error: `${result.error ?? ""} Cleanup failed for ${databaseName}: ${String(error)}`,
        };
      }
    }
    try {
      if (admin)
        await adminOperation(admin, admin.close({ timeout: 1 }), "Close scratch connection");
    } catch {
      /* Drop result above records cleanup failure. */
    }
    try {
      if (spool) await rm(spool, { recursive: true, force: true });
    } catch (error) {
      scratchRemoved = false;
      result = {
        ...result,
        ok: false,
        error: `${result.error ?? ""} Spool cleanup failed: ${String(error)}`,
      };
    }
  }
  results.push({
    ...result,
    scenario,
    scratchRemoved,
    scratchDatabase: databaseName ?? attemptedDatabase,
    preparation,
  });
  console.error(
    `${scenario}: ${result.ok ? "PASS" : "FAIL"}${result.error ? ` — ${result.error}` : ""}`,
  );
}
const report = {
  started,
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  config,
  memoryScope:
    "Worker process including bounded in-process load driver; PostgreSQL and runner excluded",
  interrupted,
  ok: !interrupted && results.length === selected.length && results.every((r) => r.ok),
  results,
};
const json = JSON.stringify(report, null, 2);
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${json}\n`);
}
console.log(json);
process.exit(report.ok ? 0 : 1);
