// The background worker's API slice: the stored key + one fetch helper.
// The key arrives from the popup shim (apiKey.store, client/src/shell.md)
// and lives in chrome.storage.local, which every extension context can read.

import type { ApiReply } from "./messages.ts";

export const API_KEY_STORAGE = "apiKey";

export async function getApiKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(API_KEY_STORAGE);
  const key = stored[API_KEY_STORAGE];
  return typeof key === "string" && key !== "" ? key : null;
}

function errorMessage(body: unknown, status: number): string {
  // The SimpleLogin error envelope: {"error": "..."} on every 4xx/5xx.
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body;
    if (typeof error === "string") return error;
  }
  return `Request failed with status ${status}`;
}

/** Call the API with the stored key. Never throws: network trouble is a reply too. */
export async function apiFetch(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ApiReply> {
  const key = await getApiKey();
  if (!key) return { ok: false, status: 401, error: "not logged in" };
  const headers: Record<string, string> = { Accept: "application/json", Authentication: key };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${VIRTU_API_ORIGIN}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: errorMessage(data, res.status) };
  return { ok: true, status: res.status, data };
}
