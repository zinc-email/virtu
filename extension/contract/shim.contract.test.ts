// End-to-end contract check for the extension's popup shim, runnable
// anywhere bun is — no browser:
//   real client/src/shell.ts  →  real src/popup-shell.ts  →  fake chrome.*
// The fake extension API records what the shim asks of it, so this
// exercises every message of client/src/shell.md and both error
// conventions, exactly like the mobile shells' suites (mobile/*/contract/).
// Run with: bun test extension/contract/
//
// This file pins the web seam and the shim together: a change to either
// that breaks the protocol fails here first.
import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const SEAM_PATH = join(import.meta.dir, "../../client/src/shell.ts");
const SHIM_PATH = join(import.meta.dir, "../src/popup-shell.ts");

// --- fake extension side ---
const storage = new Map<string, unknown>();
const openedTabs: string[] = [];
const local = new Map<string, string>(); // the popup page's localStorage
let reloads = 0;

const fakeChrome = {
  runtime: { getManifest: () => ({ version: "0.3.0-test" }) },
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) storage.set(k, v);
      },
      remove: async (key: string) => {
        storage.delete(key);
      },
    },
  },
  tabs: { create: async ({ url }: { url: string }) => openedTabs.push(url) },
};

function installedShell(): VirtuShell {
  const s = window.virtuShell;
  if (!s) throw new Error("shim did not install window.virtuShell");
  return s;
}

// --- the popup environment, as the injected <script> finds it ---
// The `as` casts stub browser/extension globals in a non-DOM runtime — the
// tests-only exception (there is no typed seam for "the popup's window").
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  // bun runs all test files in one process: scrub anything another shell's
  // contract suite installed (the shim bails if virtuShell already exists).
  delete g.virtuShell;
  delete g.webkit;
  delete g.virtuShellPort;
  g.window = globalThis;
  g.chrome = fakeChrome;
  g.VIRTU_API_ORIGIN = "https://zinc.test";
  g.localStorage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => local.set(k, v),
    removeItem: (k: string) => local.delete(k),
  };
  g.location = { reload: () => reloads++ };
  await import(SHIM_PATH);
});

test("shim installs window.virtuShell with the contract's static facts", () => {
  const s = installedShell();
  expect(s.platform).toBe("extension");
  expect(s.protocol).toBe(1);
  expect(s.shellVersion).toBe("0.3.0-test");
  expect(s.apiOrigin).toBe("https://zinc.test");
  expect(typeof s.request).toBe("function");
});

test("the seam reports the extension platform and its API origin", async () => {
  const { isExtension, isShell, shellApiOrigin, shellPlatform } = await import(SEAM_PATH);
  expect(isShell()).toBe(true);
  expect(shellPlatform()).toBe("extension");
  expect(isExtension()).toBe(true);
  expect(shellApiOrigin()).toBe("https://zinc.test");
});

test("apiKey.store / apiKey.clear land in chrome.storage.local", async () => {
  const { shellClearApiKey, shellStoreApiKey } = await import(SEAM_PATH);
  shellStoreApiKey("key-1");
  await Bun.sleep(0);
  expect(storage.get("apiKey")).toBe("key-1");
  shellClearApiKey();
  await Bun.sleep(0);
  expect(storage.has("apiKey")).toBe(false);
});

test("external.open opens a tab; non-http schemes are inert", async () => {
  const { openExternal } = await import(SEAM_PATH);
  openExternal("https://zinc.email/docs");
  await Bun.sleep(0);
  expect(openedTabs).toEqual(["https://zinc.email/docs"]);
  openExternal("javascript:alert(1)");
  await Bun.sleep(0);
  expect(openedTabs).toHaveLength(1);
});

test("share without a Web Share API is capability-unavailable (failed)", async () => {
  const { share } = await import(SEAM_PATH);
  expect(await share({ url: "https://zinc.email/a/x" })).toBe(false);
  const raw = JSON.parse(
    await installedShell().request(JSON.stringify({ type: "share", url: "https://x" })),
  );
  expect(raw).toEqual({ ok: false, error: "failed" });
});

test("error conventions: bad-payload and unknown-message", async () => {
  const s = installedShell();
  const ask = async (m: unknown) => JSON.parse(await s.request(JSON.stringify(m)));
  expect(await ask({ type: "apiKey.store" })).toEqual({ ok: false, error: "bad-payload" });
  expect(await ask({ type: "apiKey.store", key: "" })).toEqual({ ok: false, error: "bad-payload" });
  expect(await ask({ type: "external.open", url: "ftp://x" })).toEqual({
    ok: false,
    error: "bad-payload",
  });
  expect(await ask({ type: "share" })).toEqual({ ok: false, error: "bad-payload" });
  expect(await ask({ type: "push.register" })).toEqual({ ok: false, error: "unknown-message" });
  expect(JSON.parse(await s.request("not json"))).toEqual({ ok: false, error: "bad-payload" });
});

test("healing: a key in chrome.storage re-seeds an emptied popup localStorage", async () => {
  // The shim healed at import time with no key stored: nothing happened.
  expect(reloads).toBe(0);
  expect(local.has("virtu.apiKey")).toBe(false);
  storage.set("apiKey", "key-2");
  const fresh = `${SHIM_PATH}?heal=${Date.now()}`;
  const g = globalThis as Record<string, unknown>;
  delete g.virtuShell;
  await import(fresh);
  await Bun.sleep(0);
  expect(local.get("virtu.apiKey")).toBe("key-2");
  expect(reloads).toBe(1);
});
