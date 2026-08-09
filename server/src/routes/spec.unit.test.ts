// Contract check: the committed server/spec/openapi.json IS the review
// artifact. This test fails when a route is added/changed without running
// bin/openapi-gen (or when the emitted spec loses a route). Runs in the unit
// tier: buildApp never touches the DB for spec emission.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { App } from "../app/server";
import { buildApp } from "../app/server";

let app: App;
let liveSpec: Record<string, unknown>;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  liveSpec = app.swagger() as unknown as Record<string, unknown>;
});

afterAll(async () => {
  await app.close();
});

// Every SimpleLogin-compatible route we ship, as spec paths (the /api prefix
// lives in `servers`, not in the path keys).
const EXPECTED: [string, string][] = [
  ["/auth/register", "post"],
  ["/auth/login", "post"],
  ["/user_info", "get"],
  ["/v2/aliases", "get"],
  ["/v2/aliases", "post"],
  ["/aliases/{alias_id}", "get"],
  ["/aliases/{alias_id}", "put"],
  ["/aliases/{alias_id}", "patch"],
  ["/aliases/{alias_id}", "delete"],
  ["/aliases/{alias_id}/toggle", "post"],
  ["/aliases/{alias_id}/activities", "get"],
  ["/aliases/{alias_id}/contacts", "get"],
  ["/aliases/{alias_id}/contacts", "post"],
  ["/v5/alias/options", "get"],
  ["/v3/alias/custom/new", "post"],
  ["/alias/random/new", "post"],
  ["/contacts/{contact_id}", "delete"],
  ["/contacts/{contact_id}/toggle", "post"],
  ["/v2/mailboxes", "get"],
  ["/mailboxes", "post"],
  ["/mailboxes/{mailbox_id}", "put"],
  ["/mailboxes/{mailbox_id}", "delete"],
  ["/stats", "get"],
  ["/setting", "get"],
  ["/setting", "patch"],
  ["/v2/setting/domains", "get"],
  ["/sudo", "patch"],
  ["/api_key", "post"],
  ["/logout", "get"],
];

describe("OpenAPI contract", () => {
  test("every shipped route appears in the emitted spec", () => {
    const paths = liveSpec.paths as Record<string, Record<string, unknown>>;
    for (const [path, method] of EXPECTED) {
      expect(paths[path], `missing path ${path}`).toBeDefined();
      expect(paths[path]?.[method], `missing ${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });

  test("the committed spec matches the app (run bin/openapi-gen when this fails)", async () => {
    const committedPath = join(import.meta.dir, "../../spec/openapi.json");
    const committedText = (await Bun.file(committedPath).text()).trimEnd();
    // JSON round-trip normalizes the live doc to plain data. String compare
    // (not deep toEqual): the doc is huge and deep-equality on it has crashed
    // bun test in multi-file runs.
    const liveText = JSON.stringify(JSON.parse(JSON.stringify(liveSpec)), null, 2);
    expect(liveText === committedText).toBe(true);
  });
});
