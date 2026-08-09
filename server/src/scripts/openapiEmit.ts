// Emit the committed OpenAPI spec by building the Fastify app in-process —
// no running api server, no HTTP round-trip, no port, and no database (the
// Bun SQL client connects lazily and spec emission never queries).
//
// Usage: bin/openapi-gen (from the repo root), or:
//   cd server && bun run src/scripts/openapiEmit.ts
//
// server/spec/openapi.json is a COMMITTED artifact — review and commit it.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildApp } from "../app/server";

const app = await buildApp({ logger: false });
await app.ready();
try {
  // import.meta.dir = server/src/scripts -> spec lives at server/spec.
  const out = join(import.meta.dir, "../../spec/openapi.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
  console.error(`Wrote ${out}`);
} finally {
  await app.close();
}

// One-off build script — exit deterministically once the file lands, even if
// something (e.g. a lazily-created DB socket) keeps the event loop alive.
process.exit(0);
