// Messages between the content script and the background worker.
//
// The content script can't call the API itself: it runs under the host
// page's origin, and in Manifest V3 the extension's host permission doesn't
// extend to content scripts, so a direct fetch would be a cross-origin
// request the API doesn't answer. The background worker holds the key and
// makes the call.

export type ContentToBackground =
  | { type: "api"; method: "GET" | "POST"; path: string; body?: unknown }
  /** Open the app (the popup page) in a tab, e.g. to log in. `route` is a hash route. */
  | { type: "app.open"; route?: string };

export type ApiReply =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string };

/** Context-menu clicks, background → the frame that was right-clicked. */
export type BackgroundToContent = { type: "menu.fill" } | { type: "menu.show" };

// Alias fields the content script reads. The full shapes are AliasDto /
// AliasOptionsResponse in server/spec/openapi.json; this is the slice the
// menu needs, typed by hand like the Android shell's VirtuApi.kt.
export interface AliasRow {
  id: number;
  email: string;
  creation_timestamp: number;
  enabled: boolean;
}

export interface AliasList {
  aliases: AliasRow[];
}

export interface AliasOptions {
  can_create: boolean;
  recommendation?: { alias: string; hostname: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isAliasRow(v: unknown): v is AliasRow {
  return (
    isRecord(v) &&
    typeof v.id === "number" &&
    typeof v.email === "string" &&
    typeof v.creation_timestamp === "number" &&
    typeof v.enabled === "boolean"
  );
}

export function isAliasList(v: unknown): v is AliasList {
  return isRecord(v) && Array.isArray(v.aliases) && v.aliases.every(isAliasRow);
}

export function isAliasOptions(v: unknown): v is AliasOptions {
  if (!isRecord(v) || typeof v.can_create !== "boolean") return false;
  const rec = v.recommendation;
  return rec === undefined || (isRecord(rec) && typeof rec.alias === "string");
}
