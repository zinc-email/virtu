// End-to-end contract check for the Android shim, runnable anywhere bun is —
// no JDK, SDK, or device:
//   real client/src/shell.ts  →  real assets/shell-bridge.js  →  fake native
// The fake native side mirrors ShellProtocol.kt's dispatch rules, so this
// exercises the id-correlation envelope plumbing and both error conventions
// of client/src/shell.md. Run with: bun test mobile/android/contract/
//
// This file pins the web seam and the shim together: a change to either that
// breaks the protocol fails here first. The Kotlin message layer has its own
// conformance suite (app/src/test/, ./gradlew test).
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VirtuShell } from "../../../client/src/shell.ts";

const SHIM_PATH = join(import.meta.dir, "../app/src/main/assets/shell-bridge.js");
const SEAM_PATH = join(import.meta.dir, "../../../client/src/shell.ts");

// The one place we assert the shim's install onto the stubbed global —
// a test-stub cast (bun's globalThis is not a DOM Window), justified here
// instead of `as any` at each use site.
function installedShell(): VirtuShell {
  const s = (globalThis as { virtuShell?: VirtuShell }).virtuShell;
  if (!s) throw new Error("shim did not install window.virtuShell");
  return s;
}

type Msg = { type: string; [k: string]: unknown };

// --- fake native side (mirrors ShellProtocol.kt + ShellBridge.execute) ---
const nativeLog: Msg[] = [];
let holdReplies = false;
const heldReplies: string[] = [];
let onmessageRef: (ev: { data: string }) => void;

function reply(id: number, body: object): void {
  const envelope = JSON.stringify({ id, reply: JSON.stringify(body) });
  if (holdReplies) heldReplies.push(envelope);
  else onmessageRef({ data: envelope });
}

function nativeDeliver(envelopeJson: string): void {
  const envelope = JSON.parse(envelopeJson) as { id: number; message: string };
  let msg: Msg;
  try {
    msg = JSON.parse(envelope.message) as Msg;
  } catch {
    reply(envelope.id, { ok: false, error: "bad-payload" });
    return;
  }
  switch (msg.type) {
    case "apiKey.store":
      if (typeof msg.key !== "string" || msg.key === "") {
        reply(envelope.id, { ok: false, error: "bad-payload" });
        return;
      }
      break;
    case "apiKey.clear":
      break;
    case "share":
      if (typeof msg.text !== "string" && typeof msg.url !== "string") {
        reply(envelope.id, { ok: false, error: "bad-payload" });
        return;
      }
      break;
    case "external.open":
      if (typeof msg.url !== "string" || !/^https?:\/\//.test(msg.url)) {
        reply(envelope.id, { ok: false, error: "bad-payload" });
        return;
      }
      break;
    default:
      reply(envelope.id, { ok: false, error: "unknown-message" });
      return;
  }
  nativeLog.push(msg);
  reply(envelope.id, { ok: true });
}

// --- the injected environment, as ShellBridge.attach() sets it up ---
// The `as` casts below stub browser globals in a non-DOM runtime — the
// tests-only exception (there is no typed seam for "a WebView's window").
beforeAll(() => {
  const port = {
    set onmessage(f: (ev: { data: string }) => void) {
      onmessageRef = f;
    },
    postMessage(data: string) {
      nativeDeliver(data);
    },
  };
  const g = globalThis as Record<string, unknown>;
  // bun runs all test files in one process: scrub anything another
  // platform's contract suite installed (the shim bails if virtuShell
  // already exists) so this file exercises the Android path alone.
  delete g.virtuShell;
  delete g.webkit;
  g.window = globalThis;
  g.virtuShellPort = port;
  const shim = readFileSync(SHIM_PATH, "utf8").replaceAll("__SHELL_VERSION__", "0.1.0-test");
  new Function(shim)();
});

test("shim installs window.virtuShell with the contract's static facts", () => {
  const s = installedShell();
  expect(s.platform).toBe("android");
  expect(s.protocol).toBe(1);
  expect(s.shellVersion).toBe("0.1.0-test");
  expect(typeof s.request).toBe("function");
});

test("the real web seam shares through the shim", async () => {
  const { share, isShell } = await import(SEAM_PATH);
  expect(isShell()).toBe(true);
  expect(await share({ url: "https://zinc.email/a/x" })).toBe(true);
  expect(nativeLog.at(-1)).toEqual({ type: "share", url: "https://zinc.email/a/x" });
});

test("seam treats a bad-payload error reply as capability-unavailable", async () => {
  const { share } = await import(SEAM_PATH);
  // No text and no url → native replies bad-payload → share() === false and
  // the caller keeps its copy UI, per shell.md's error convention.
  expect(await share({ title: "only a title" })).toBe(false);
});

test("apiKey.store round-trips the key", async () => {
  const { shellStoreApiKey, shellClearApiKey } = await import(SEAM_PATH);
  shellStoreApiKey("sk-test-123");
  await Bun.sleep(0);
  expect(nativeLog.at(-1)).toEqual({ type: "apiKey.store", key: "sk-test-123" });
  shellClearApiKey();
  await Bun.sleep(0);
  expect(nativeLog.at(-1)).toEqual({ type: "apiKey.clear" });
});

test("unknown message type gets the unknown-message slug", async () => {
  const raw = await installedShell().request(JSON.stringify({ type: "push.register" }));
  expect(JSON.parse(raw)).toEqual({ ok: false, error: "unknown-message" });
});

test("out-of-order replies land on the right request (id correlation)", async () => {
  const s = installedShell();
  holdReplies = true;
  const first = s.request(JSON.stringify({ type: "share", url: "https://a.test/" }));
  const second = s.request(JSON.stringify({ type: "nope" }));
  expect(heldReplies.length).toBe(2);
  holdReplies = false;
  // flush in reverse order
  onmessageRef({ data: heldReplies[1]! });
  onmessageRef({ data: heldReplies[0]! });
  heldReplies.length = 0;
  expect(JSON.parse(await first)).toEqual({ ok: true });
  expect(JSON.parse(await second)).toEqual({ ok: false, error: "unknown-message" });
});

test("non-string request rejects (bridge misuse, not a protocol error)", async () => {
  // Deliberately violating the string-only signature — the untyped call is
  // the point of the test.
  const request = installedShell().request as (message: unknown) => Promise<string>;
  expect(request({ type: "share" })).rejects.toBeInstanceOf(TypeError);
});
