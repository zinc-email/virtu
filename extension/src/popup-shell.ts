// The extension half of window.virtuShell (client/src/shell.md).
//
// The toolbar popup is the built client SPA, packaged in this extension at
// app/ and opened as app/index.html. bin/extension-build injects a plain
// <script src="/popup-shell.js"> into that page's <head>, ahead of the app's
// deferred bundles — "document start" for a page we ship ourselves. The shim
// answers every protocol message in-process from the extension APIs; the
// contract test in ../contract/ drives it through the real client seam.

const API_KEY_STORAGE = "apiKey"; // same key api.ts reads

// The seam's own localStorage slot (client/src/auth.ts, STORAGE_KEY). Named
// here only for healing: chrome.storage.local outlives "clear browsing data"
// and the popup's localStorage doesn't, so a user whose popup forgot the key
// the content script still has is re-seeded instead of re-logged-in — the
// same healing the Android shell does from the Keystore.
const APP_KEY_STORAGE = "virtu.apiKey";

type Reply = { ok: true } | { ok: false; error: string };

function reply(r: Reply): string {
  return JSON.stringify(r);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function handle(message: string): Promise<Reply> {
  let msg: unknown;
  try {
    msg = JSON.parse(message);
  } catch {
    return { ok: false, error: "bad-payload" };
  }
  if (!isRecord(msg) || typeof msg.type !== "string") return { ok: false, error: "bad-payload" };
  try {
    switch (msg.type) {
      case "apiKey.store": {
        if (typeof msg.key !== "string" || msg.key === "")
          return { ok: false, error: "bad-payload" };
        await chrome.storage.local.set({ [API_KEY_STORAGE]: msg.key });
        return { ok: true };
      }
      case "apiKey.clear": {
        await chrome.storage.local.remove(API_KEY_STORAGE);
        return { ok: true };
      }
      case "share": {
        const text = typeof msg.text === "string" ? msg.text : undefined;
        const url = typeof msg.url === "string" ? msg.url : undefined;
        const title = typeof msg.title === "string" ? msg.title : undefined;
        if (text === undefined && url === undefined) return { ok: false, error: "bad-payload" };
        // Desktop browsers offer a share sheet on some platforms only; where
        // there is none the app keeps its copy-to-clipboard UI (shell.md).
        if (typeof navigator.share !== "function") return { ok: false, error: "failed" };
        await navigator.share({ title, text, url });
        return { ok: true };
      }
      case "external.open": {
        if (typeof msg.url !== "string" || !/^https?:\/\//.test(msg.url)) {
          return { ok: false, error: "bad-payload" };
        }
        await chrome.tabs.create({ url: msg.url });
        return { ok: true };
      }
      default:
        return { ok: false, error: "unknown-message" };
    }
  } catch {
    return { ok: false, error: "failed" };
  }
}

function install(): void {
  if (window.virtuShell) return;
  window.virtuShell = {
    platform: "extension",
    shellVersion: chrome.runtime.getManifest().version,
    protocol: 1,
    apiOrigin: VIRTU_API_ORIGIN,
    request: (message: string) => handle(message).then(reply),
  };
}

function heal(): void {
  void chrome.storage.local.get(API_KEY_STORAGE).then((stored) => {
    const key = stored[API_KEY_STORAGE];
    if (typeof key !== "string" || key === "") return;
    try {
      if (localStorage.getItem(APP_KEY_STORAGE)) return;
      localStorage.setItem(APP_KEY_STORAGE, key);
    } catch {
      return; // storage unavailable: nothing to heal into
    }
    // The app booted logged-out before the async read returned; boot again.
    location.reload();
  });
}

install();
heal();
