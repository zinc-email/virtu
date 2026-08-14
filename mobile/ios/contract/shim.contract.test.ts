// End-to-end contract check for the iOS shim, runnable anywhere bun is — no
// Mac, Xcode, or device:
//   real client/src/shell.ts  →  real Resources/shell-bridge.js  →  fake native
// The fake native side mirrors ShellProtocol.swift's dispatch rules. iOS has
// no id envelope: webkit.messageHandlers.virtuShell.postMessage returns the
// reply promise directly (WKScriptMessageHandlerWithReply), so what this
// pins is that promise plumbing plus both shell.md error conventions.
// Run with: bun test mobile/ios/contract/  (or `just test-contract` for all
// platforms). The Swift message layer has its own XCTest suite (VirtuTests/).
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VirtuShell } from "../../../client/src/shell.ts";

const SHIM_PATH = join(import.meta.dir, "../Virtu/Resources/shell-bridge.js");
const SEAM_PATH = join(import.meta.dir, "../../../client/src/shell.ts");

type Msg = { type: string; [k: string]: unknown };

// --- fake native side (mirrors ShellProtocol.swift + ShellBridge.execute) ---
const nativeLog: Msg[] = [];
let holdReplies = false;
const heldReplies: Array<{ resolve: (reply: string) => void; reply: string }> = [];

function nativeReply(msgJson: string): string {
  let msg: Msg;
  try {
    msg = JSON.parse(msgJson) as Msg;
  } catch {
    return JSON.stringify({ ok: false, error: "bad-payload" });
  }
  switch (msg.type) {
    case "apiKey.store":
      if (typeof msg.key !== "string" || msg.key === "") {
        return JSON.stringify({ ok: false, error: "bad-payload" });
      }
      break;
    case "apiKey.clear":
      break;
    case "share":
      if (typeof msg.text !== "string" && typeof msg.url !== "string") {
        return JSON.stringify({ ok: false, error: "bad-payload" });
      }
      break;
    case "external.open":
      if (typeof msg.url !== "string" || !/^https?:\/\//i.test(msg.url)) {
        return JSON.stringify({ ok: false, error: "bad-payload" });
      }
      break;
    default:
      return JSON.stringify({ ok: false, error: "unknown-message" });
  }
  nativeLog.push(msg);
  return JSON.stringify({ ok: true });
}

// --- the injected environment, as ShellBridge.attach() sets it up ---
// The `as` casts below stub browser globals in a non-DOM runtime — the
// tests-only exception (there is no typed seam for "a WKWebView's window").
beforeAll(() => {
  const g = globalThis as {
    window?: unknown;
    webkit?: unknown;
    virtuShell?: unknown;
    virtuShellPort?: unknown;
  };
  // bun runs all test files in one process: scrub anything the Android
  // contract suite installed so this file exercises the iOS path alone.
  delete g.virtuShell;
  delete g.virtuShellPort;
  g.window = globalThis;
  g.webkit = {
    messageHandlers: {
      virtuShell: {
        postMessage(msgJson: string): Promise<string> {
          const reply = nativeReply(msgJson);
          if (holdReplies) {
            return new Promise((resolve) => heldReplies.push({ resolve, reply }));
          }
          return Promise.resolve(reply);
        },
      },
    },
  };
  const shim = readFileSync(SHIM_PATH, "utf8").replaceAll("__SHELL_VERSION__", "0.1.0-test");
  new Function(shim)();
});

function installedShell(): VirtuShell {
  const s = (globalThis as { virtuShell?: VirtuShell }).virtuShell;
  if (!s) throw new Error("shim did not install window.virtuShell");
  return s;
}

test("shim installs window.virtuShell with the contract's static facts", () => {
  const s = installedShell();
  expect(s.platform).toBe("ios");
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
  expect(await share({ title: "only a title" })).toBe(false);
});

test("apiKey.store round-trips the key", async () => {
  const { shellStoreApiKey, shellClearApiKey } = await import(SEAM_PATH);
  shellStoreApiKey("sk-test-456");
  await Bun.sleep(0);
  expect(nativeLog.at(-1)).toEqual({ type: "apiKey.store", key: "sk-test-456" });
  shellClearApiKey();
  await Bun.sleep(0);
  expect(nativeLog.at(-1)).toEqual({ type: "apiKey.clear" });
});

test("unknown message type gets the unknown-message slug", async () => {
  const raw = await installedShell().request(JSON.stringify({ type: "push.register" }));
  expect(JSON.parse(raw)).toEqual({ ok: false, error: "unknown-message" });
});

test("concurrent requests each get their own reply (promise-per-call)", async () => {
  const s = installedShell();
  holdReplies = true;
  const first = s.request(JSON.stringify({ type: "share", url: "https://a.test/" }));
  const second = s.request(JSON.stringify({ type: "nope" }));
  expect(heldReplies.length).toBe(2);
  holdReplies = false;
  // settle in reverse order — each promise must keep its own reply
  heldReplies[1]!.resolve(heldReplies[1]!.reply);
  heldReplies[0]!.resolve(heldReplies[0]!.reply);
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
