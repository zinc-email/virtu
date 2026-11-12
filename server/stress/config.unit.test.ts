// Fast harness safety tests only; these never start stress scenarios or a database.
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  assertScratchDatabase,
  stressConfig,
  effectiveStressConfig,
  stressWorkload,
} from "./config.ts";

test("stress profiles validate bounded integer settings", () => {
  expect(stressConfig("smoke", {})).toMatchObject({ clients: 8, copies: 8, queueWorkers: 2 });
  expect(stressConfig("load", {})).toMatchObject({ messageBytes: 25 * 1024 * 1024, copies: 100 });
  for (const bad of ["NaN", "0", "-1", "1.5", "129"]) {
    expect(() => stressConfig("smoke", { MAIL_STRESS_CLIENTS: bad })).toThrow();
  }
  expect(stressConfig("load", {}).queueMessageBytes).toBe(1024 * 1024);
  expect(stressConfig("load", { MAIL_STRESS_MESSAGE_MIB: "25" }).queueMessageBytes).toBe(
    25 * 1024 * 1024,
  );
  expect(
    stressConfig("load", { MAIL_STRESS_MESSAGE_MIB: "25", MAIL_STRESS_QUEUE_MESSAGE_MIB: "2" })
      .queueMessageBytes,
  ).toBe(2 * 1024 * 1024);
  expect(() => stressConfig("unknown", {})).toThrow();
  expect(stressConfig("load", { MAIL_STRESS_QUEUE_WORKERS: "1" }).queueWorkers).toBe(1);
  for (const bad of ["0", "-1", "1.5", "33"]) {
    expect(() => stressConfig("load", { MAIL_STRESS_QUEUE_WORKERS: bad })).toThrow();
  }
});

test("workers accept only generated scratch database targets", () => {
  assertScratchDatabase("postgres://localhost/virtu_stress_0123456789abcdef0123456789abcdef");
  for (const url of [
    "postgres://localhost/virtu",
    "postgres://localhost/postgres",
    "postgres://localhost/virtu_stress_existing",
    "https://localhost/virtu_stress_0123456789abcdef0123456789abcdef",
  ]) {
    expect(() => assertScratchDatabase(url)).toThrow();
  }
});

test("stress runner is disabled before any database access without explicit opt-in", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", fileURLToPath(new URL("run.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        MAIL_STRESS: "0",
        MAIL_STRESS_ADMIN_DATABASE_URL: "postgres://must-not-connect.invalid/postgres",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(2);
  expect(stderr).toContain("Disabled: set MAIL_STRESS=1");
});

test("effective workloads agree for queue preparation, isolated recovery and combined processing", () => {
  const config = stressConfig("load", {
    MAIL_STRESS_QUEUE_MESSAGE_MIB: "3",
    MAIL_STRESS_QUEUE_WORKERS: "4",
  });
  for (const scenario of ["queue-seed", "queue-recovery"] as const) {
    expect(effectiveStressConfig(config, scenario).messageBytes).toBe(3 * 1024 * 1024);
    expect(stressWorkload(config, scenario)).toMatchObject({
      messageBytes: 3 * 1024 * 1024,
      queueWorkers: 4,
    });
  }
  expect(stressWorkload(config, "queue-combined")).toMatchObject({
    messageBytes: 25 * 1024 * 1024,
    queueWorkers: 1,
  });
  expect(effectiveStressConfig(config, "queue-combined").queueWorkers).toBe(1);
  expect(stressWorkload(config, "smtp-load")).toMatchObject({
    messageBytes: 25 * 1024 * 1024,
    queueWorkers: 4,
  });
  expect(config.queueWorkers).toBe(4);
  expect(config.messageBytes).toBe(25 * 1024 * 1024);
});

test("runner resolves encoded paths and preserves workload when children fail before reporting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "virtu stress ü "));
  try {
    const stress = join(directory, "stress");
    await mkdir(stress);
    for (const name of ["run.ts", "config.ts"])
      await copyFile(new URL(name, import.meta.url), join(stress, name));
    // A tiny child exercises runner failure handling without SMTP, SQL, or a large body.
    await writeFile(
      join(stress, "worker.ts"),
      `
      const mode = process.env.STRESS_TEST_MODE;
      if (mode === "killed") process.kill(process.pid, "SIGKILL");
      else if (mode === "missing") process.exit(0);
      else if (mode === "rss") { console.log(JSON.stringify({type:"sample",rssBytes:2*1024*1024})); setInterval(() => {}, 100); }
      else if (mode === "timeout") setInterval(() => {}, 100);
      else { console.log(JSON.stringify({type:"result",ok:true,metrics:{cwdCorrect:Number(process.cwd() === process.env.STRESS_TEST_CWD)},workload:{messageBytes:0}})); }
    `,
    );
    const env = {
      ...process.env,
      MAIL_STRESS: "1",
      MAIL_STRESS_MESSAGE_MIB: "2",
      MAIL_STRESS_QUEUE_MESSAGE_MIB: "3",
      MAIL_STRESS_TIMEOUT_SECONDS: "1",
      MAIL_STRESS_RSS_MIB: "1",
      STRESS_TEST_CWD: await realpath(directory),
    };
    const expected = JSON.parse(
      JSON.stringify(stressWorkload(stressConfig("smoke", env), "smtp-load")),
    );
    for (const mode of ["success", "killed", "missing", "rss", "timeout"]) {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", join(stress, "run.ts"), "--scenario", "smtp-load"],
        { env: { ...env, STRESS_TEST_MODE: mode }, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const result = JSON.parse(stdout).results[0];
      expect(result.workload).toEqual(expected);
      expect(code).toBe(mode === "success" ? 0 : 1);
      if (mode === "success") expect(result.metrics.cwdCorrect).toBe(1);
      if (mode === "timeout") expect(result.error).toContain("Deadline exceeded");
      if (mode === "rss") expect(result.error).toContain("RSS limit exceeded");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("one, two and four queue loops keep the same recovery workload", () => {
  const workloads = [1, 2, 4].map((queueWorkers) =>
    stressWorkload(
      stressConfig("load", {
        MAIL_STRESS_QUEUE_WORKERS: String(queueWorkers),
        MAIL_STRESS_QUEUE_MESSAGE_MIB: "25",
      }),
      "queue-recovery",
    ),
  );
  expect(workloads.map((workload) => workload.queueWorkers)).toEqual([1, 2, 4]);
  for (const { queueWorkers: _queueWorkers, ...workload } of workloads) {
    expect(workload).toEqual({
      messageBytes: 25 * 1024 * 1024,
      clients: 16,
      copies: 100,
      rounds: 3,
      queueBatchSize: undefined,
    });
  }
});

test("queue batch size is opt-in, bounded, and reported consistently", () => {
  const baseline = stressConfig("load", {});
  expect(baseline.queueBatchSize).toBeUndefined();
  expect(JSON.stringify(stressWorkload(baseline, "queue-recovery"))).not.toContain(
    "queueBatchSize",
  );
  const configured = stressConfig("load", { MAIL_STRESS_QUEUE_BATCH_SIZE: "10" });
  for (const scenario of ["queue-seed", "queue-recovery", "queue-combined"] as const) {
    expect(effectiveStressConfig(configured, scenario).queueBatchSize).toBe(10);
    expect(stressWorkload(configured, scenario).queueBatchSize).toBe(10);
  }
  expect(stressConfig("smoke", { MAIL_STRESS_QUEUE_BATCH_SIZE: "1" }).queueBatchSize).toBe(1);
  expect(stressConfig("smoke", { MAIL_STRESS_QUEUE_BATCH_SIZE: "1000" }).queueBatchSize).toBe(1000);
  for (const bad of ["", "0", "-1", "1.5", "1001", "NaN"]) {
    expect(() => stressConfig("load", { MAIL_STRESS_QUEUE_BATCH_SIZE: bad })).toThrow();
  }
});
