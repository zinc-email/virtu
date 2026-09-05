// The shell seam — the ONE place the web app talks to a shell that hosts it:
// the native mobile apps (plans/mobile.md) and the browser extension's popup
// (extension/). Protocol spec: shell.md beside this file (change them
// together). Shells inject `window.virtuShell` at document start; plain
// browsers never have it, and every helper here degrades to web behavior when
// it's absent.

export type ShellPlatform = "ios" | "android" | "extension";

export interface VirtuShell {
  platform: ShellPlatform;
  shellVersion: string;
  protocol: number;
  /**
   * Absolute origin of the API, set only by a shell that serves the app from
   * a non-web origin (the extension packages the built SPA at
   * chrome-extension://…, where the SDK's relative /api would point nowhere).
   * Webviews load the production URL and leave it unset.
   */
  apiOrigin?: string;
  /** One JSON-encoded message in, one JSON-encoded reply out (shell.md). */
  request(message: string): Promise<string>;
}

declare global {
  interface Window {
    virtuShell?: VirtuShell;
  }
}

type ShellMessage =
  | { type: "apiKey.store"; key: string }
  | { type: "apiKey.clear" }
  | { type: "share"; title?: string; text?: string; url?: string }
  | { type: "external.open"; url: string };

interface ShellReply {
  ok: boolean;
  error?: string;
}

export function shell(): VirtuShell | null {
  return typeof window === "undefined" ? null : (window.virtuShell ?? null);
}

export function isShell(): boolean {
  return shell() !== null;
}

/** Which shell, for the few UI decisions that differ by store policy. */
export function shellPlatform(): ShellPlatform | null {
  return shell()?.platform ?? null;
}

/**
 * Prefix for the SDK's relative `/api` base: "" on the web and in webviews
 * (same origin), the shell-declared origin in the extension popup.
 */
export function shellApiOrigin(): string {
  return shell()?.apiOrigin ?? "";
}

/**
 * The extension popup is a file inside the extension package, so the app
 * routes by hash there instead of by path (src/app.tsx) — the one place the
 * platform changes routing rather than a capability.
 */
export function isExtension(): boolean {
  return shellPlatform() === "extension";
}

function isReply(value: unknown): value is ShellReply {
  return (
    typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean"
  );
}

// A shell must always reply (shell.md), but a buggy one that never settles
// would otherwise hang callers forever (e.g. a share button awaiting us).
const REPLY_TIMEOUT_MS = 10_000;

// Every error reply means "capability unavailable" — callers fall back to web
// behavior and never surface bridge errors to the user (shell.md).
async function request(message: ShellMessage): Promise<ShellReply> {
  const s = shell();
  if (!s) return { ok: false, error: "no-shell" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      s.request(JSON.stringify(message)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("shell reply timeout")), REPLY_TIMEOUT_MS);
      }),
    ]);
    const parsed: unknown = JSON.parse(raw);
    return isReply(parsed) ? parsed : { ok: false, error: "malformed-reply" };
  } catch {
    return { ok: false, error: "bridge-broken" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hand the API key to the shell for Keychain/Keystore storage (the share and
 * autofill extensions read it from there). Fire-and-forget; no-op on the web.
 */
export function shellStoreApiKey(key: string): void {
  if (isShell()) void request({ type: "apiKey.store", key });
}

/** Logout/401: the shell wipes the stored key (extensions lose access too). */
export function shellClearApiKey(): void {
  if (isShell()) void request({ type: "apiKey.clear" });
}

/**
 * Present a native share sheet — the shell's if present, else the Web Share
 * API. Resolves false when neither is available or the user canceled; the
 * caller keeps its copy-to-clipboard UI as the fallback.
 */
export async function share(payload: {
  title?: string;
  text?: string;
  url?: string;
}): Promise<boolean> {
  if (isShell()) return (await request({ type: "share", ...payload })).ok;
  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      await navigator.share(payload);
      return true;
    } catch {
      return false; // canceled, or payload unsupported
    }
  }
  return false;
}

/**
 * Open an http(s) URL outside the app: system browser in a shell, new tab on
 * the web. For links that must never navigate the shell's webview. Enforces
 * the same http/https rule the shells do, so a crafted scheme (javascript:,
 * intent:) is inert on every platform.
 */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (isShell()) {
    // Best-effort fallback on an error reply (e.g. an older shell): inside a
    // WebView window.open may be gesture-gated by then and no-op, but it can
    // never make things worse than silently doing nothing.
    void request({ type: "external.open", url }).then((reply) => {
      if (!reply.ok) window.open(url, "_blank", "noopener");
    });
    return;
  }
  window.open(url, "_blank", "noopener");
}
