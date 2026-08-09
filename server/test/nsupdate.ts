/**
 * Dynamic DNS updates against the fake BIND (test-runner only; the nsupdate
 * binary is baked into the runner image — see server/docker/test/runner).
 * The virtu.email and user.com zones accept updates from both test subnets;
 * fixtures use this to publish DKIM public keys generated at test time.
 */

const DNS_SERVER = process.env.VIRTU_TEST_DNS ?? "192.168.43.254";

/** Run one nsupdate script (the `server`/`send` lines are added here). */
export async function nsupdate(zone: string, updates: string[]): Promise<void> {
  const script = [`server ${DNS_SERVER}`, `zone ${zone}.`, ...updates, "send", ""].join("\n");
  const proc = Bun.spawn(["nsupdate"], {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`nsupdate exited ${code} for zone ${zone}: ${stderr.trim()}\n${script}`);
  }
}

/** Quote a TXT value as <=255-char character-strings (RFC 1035 limit). */
export function quoteTxtValue(value: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) {
    chunks.push(`"${value.slice(i, i + 255)}"`);
  }
  return chunks.join(" ");
}

/** Replace (delete + add) one TXT record. Idempotent. */
export async function publishTxt(
  zone: string,
  name: string,
  value: string,
  ttl = 60,
): Promise<void> {
  await nsupdate(zone, [
    `update delete ${name}. TXT`,
    `update add ${name}. ${ttl} TXT ${quoteTxtValue(value)}`,
  ]);
}
