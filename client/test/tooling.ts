// Bridge from client DOM tests to repo-side dev tooling, over a PROCESS
// boundary — never a code import (CLAUDE.md: server↔client couple only via the
// committed spec). DOM tests drive the real stack; when a test needs something
// only the server can produce, it invokes the same `bin/` tool a developer
// would, from the repo root. All DB creds + schema knowledge stay inside the
// invoked tool, on the server side of the boundary.
//
// Safe by construction: argv is an explicit array passed to Bun.spawn — no
// shell, so an email address or domain can never inject.
//
// Reuse for new needs by adding a thin wrapper over runTool(), e.g. the
// custom-domain DNS tests will want something like:
//
//   export function setDnsTxt(zone: string, name: string, value: string) {
//     return runTool([bin("dns-set"), zone, name, "TXT", value]);
//   }

import { resolve } from "node:path";

// This file is <repo>/client/test/tooling.ts, so ../../ is the repo root.
const repoRoot = resolve(import.meta.dir, "..", "..");
const bin = (name: string) => resolve(repoRoot, "bin", name);

/**
 * Run a repo dev tool from the repo root; resolve with its trimmed stdout.
 * Rejects with the tool's stderr (or stdout) on a non-zero exit.
 */
export async function runTool(argv: [string, ...string[]]): Promise<string> {
  const proc = Bun.spawn(argv, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${exitCode})${detail ? `:\n${detail}` : ""}`,
    );
  }
  return stdout.trim();
}

/**
 * Newest 6-digit code emailed to `email`, read from the dev queue via
 * bin/login-code (the dev stack runs no deliverd, so it sits there).
 */
export function latestLoginCode(email: string): Promise<string> {
  return runTool([bin("login-code"), email]);
}

/**
 * Register + activate + login a user via bin/user-create; returns the API
 * key. Fresh users carry the 7-day trial, so they are premium — enough for
 * the custom-domain tests.
 */
export async function createUser(email: string, password: string): Promise<string> {
  const out = await runTool([bin("user-create"), email, password]);
  const match = /api key: (\S+)/.exec(out);
  if (!match?.[1]) throw new Error(`no api key in user-create output:\n${out}`);
  return match[1];
}
