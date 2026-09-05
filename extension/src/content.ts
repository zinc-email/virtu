// Content script: the [Z] button on email fields and its alias menu — the
// legacy inject.js, ported onto the SimpleLogin API. Runs in every frame of
// every http(s) page except the app's own origin. All UI lives in one shadow
// root (content.css), so page styles and ours never touch; API calls go
// through the background worker (messages.ts).

import css from "./content.css" with { type: "text" };
import {
  type ApiReply,
  type BackgroundToContent,
  type ContentToBackground,
  isAliasList,
  isAliasOptions,
  isAliasRow,
} from "./messages.ts";

const EMAIL_HINT = /e-?mail|login|username/i;
const HOSTNAME = location.hostname.toLowerCase().replace(/^www\./, "");
const CACHE_KEY = `aliases:${HOSTNAME}`;

type Fillable = HTMLInputElement | HTMLTextAreaElement;

/** One menu row: an alias already used on this site. */
interface SiteAlias {
  email: string;
  /** Unix seconds; null for the recommendation row, which carries no date. */
  createdAt: number | null;
}

interface SiteAliases {
  rows: SiteAlias[];
  canCreate: boolean;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Background relay

function isApiReply(v: unknown): v is ApiReply {
  return typeof v === "object" && v !== null && "ok" in v && typeof v.ok === "boolean";
}

async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const message: ContentToBackground = { type: "api", method, path, body };
  const reply: unknown = await chrome.runtime.sendMessage(message).catch((e: unknown) => ({
    ok: false,
    status: 0,
    error: e instanceof Error ? e.message : "the extension did not answer",
  }));
  if (!isApiReply(reply)) throw new ApiError(0, "the extension did not answer");
  if (!reply.ok) throw new ApiError(reply.status, reply.error);
  return reply.data;
}

function openApp(route: string): void {
  const message: ContentToBackground = { type: "app.open", route };
  void chrome.runtime.sendMessage(message);
}

// ---------------------------------------------------------------------------
// API calls (server/spec/openapi.json)

async function fetchSiteAliases(): Promise<SiteAliases> {
  const hostname = encodeURIComponent(HOSTNAME);
  const [list, options] = await Promise.all([
    // Aliases minted here carry "Used on <hostname>" in their note (createAlias).
    api("POST", "/v2/aliases?page_id=0", { query: HOSTNAME }),
    // can_create + the latest alias recorded against this hostname (alias_used_on).
    api("GET", `/v5/alias/options?hostname=${hostname}`),
  ]);
  const rows: SiteAlias[] = isAliasList(list)
    ? list.aliases
        .filter((a) => a.enabled)
        .map((a) => ({ email: a.email, createdAt: a.creation_timestamp }))
    : [];
  let canCreate = true;
  if (isAliasOptions(options)) {
    canCreate = options.can_create;
    const recommended = options.recommendation?.alias;
    if (recommended) {
      // Latest one used here goes first (it may predate the note convention).
      const i = rows.findIndex((r) => r.email === recommended);
      const [row] = i >= 0 ? rows.splice(i, 1) : [{ email: recommended, createdAt: null }];
      if (row) rows.unshift(row);
    }
  }
  return { rows, canCreate };
}

async function createAlias(): Promise<SiteAlias> {
  const hostname = encodeURIComponent(HOSTNAME);
  const created = await api("POST", `/alias/random/new?hostname=${hostname}`, {
    note: `Used on ${HOSTNAME}`,
  });
  if (!isAliasRow(created)) throw new ApiError(0, "unexpected reply from the API");
  return { email: created.email, createdAt: created.creation_timestamp };
}

// ---------------------------------------------------------------------------
// Per-site cache, so the menu opens instantly and refreshes behind the scenes

let cache: SiteAlias[] = [];

function isSiteAlias(v: unknown): v is SiteAlias {
  return (
    typeof v === "object" &&
    v !== null &&
    "email" in v &&
    typeof v.email === "string" &&
    "createdAt" in v &&
    (typeof v.createdAt === "number" || v.createdAt === null)
  );
}

async function loadCache(): Promise<void> {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const rows = stored[CACHE_KEY];
  if (Array.isArray(rows) && rows.every(isSiteAlias)) cache = rows;
}

function saveCache(): void {
  void chrome.storage.local.set({ [CACHE_KEY]: cache });
}

// ---------------------------------------------------------------------------
// Fields

function isFillable(el: unknown): el is Fillable {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function isEmailInput(el: unknown): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  if (type === "email") return true;
  if (type !== "text") return false;
  return [el.name, el.placeholder, el.id, el.className, el.title, el.autocomplete].some((v) =>
    EMAIL_HINT.test(v),
  );
}

// Set the value the way a keystroke would, so frameworks that mirror the
// field into state (React's value tracker, Vue, …) see the change.
function fill(el: Fillable, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function timeAgo(ts: number | null): string {
  if (ts === null) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// ---------------------------------------------------------------------------
// UI: one floating button + one menu, attached to whichever field is active

let host: HTMLDivElement | null = null;
let button: HTMLButtonElement;
let menu: HTMLDivElement;
let target: Fillable | null = null;
let menuOpen = false;
let openSeq = 0; // invalidates a fetch whose menu was closed meanwhile
let lastRightClicked: Fillable | null = null;

function ensureUi(): void {
  if (host) return;
  host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = css
    .replace("__BUTTON__", chrome.runtime.getURL("images/button.png"))
    .replace("__BUTTON_LOADING__", chrome.runtime.getURL("images/button-loading.png"));
  button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  button.title = "Protect your email address with Zinc";
  button.hidden = true;
  // Keep the field focused through the click; act on click only.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => (menuOpen ? closeMenu() : void openMenu()));
  menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;
  root.append(style, button, menu);
  document.documentElement.append(host);
}

function buttonSize(rect: DOMRect): number {
  return rect.height >= 36 ? 24 : rect.height >= 18 ? 16 : 12;
}

function place(): void {
  if (!target || !host) return;
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    button.hidden = true;
    return;
  }
  const size = buttonSize(rect);
  const pad = (rect.height - size) / 2;
  button.style.width = `${size}px`;
  button.style.height = `${size}px`;
  button.style.top = `${rect.top + pad}px`;
  button.style.left = `${rect.right - pad - size}px`;
  button.hidden = false;
  if (menuOpen) {
    const gap = 6;
    const left = Math.max(
      8,
      Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8),
    );
    const below = rect.bottom + gap;
    const fitsBelow = below + menu.offsetHeight <= innerHeight;
    const top =
      fitsBelow || rect.top - gap - menu.offsetHeight < 0
        ? below
        : rect.top - gap - menu.offsetHeight;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }
}

function attach(el: Fillable): void {
  ensureUi();
  target = el;
  place();
}

function detach(): void {
  if (menuOpen || !host) return;
  target = null;
  button.hidden = true;
}

function setLoading(on: boolean): void {
  button.classList.toggle("loading", on);
}

type MenuState =
  | { kind: "loading" }
  | { kind: "list"; rows: SiteAlias[]; canCreate: boolean }
  | { kind: "error"; message: string; loginNeeded: boolean };

function item(text: string, className: string, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `item ${className}`;
  b.textContent = text;
  if (onClick) b.addEventListener("click", onClick);
  else b.disabled = true;
  return b;
}

function render(state: MenuState): void {
  menu.replaceChildren();
  switch (state.kind) {
    case "loading": {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Loading…";
      menu.append(note);
      break;
    }
    case "list": {
      const list = document.createElement("div");
      list.className = "list";
      for (const row of state.rows) {
        const b = item("", "alias", () => useAlias(row));
        const email = document.createElement("span");
        email.className = "email";
        email.textContent = row.email;
        const date = document.createElement("span");
        date.className = "date";
        date.textContent = timeAgo(row.createdAt);
        b.append(email, date);
        list.append(b);
      }
      menu.append(list);
      menu.append(
        state.canCreate
          ? item(`New alias for ${HOSTNAME}`, "create", () => void mintAndFill())
          : item("Alias limit reached — upgrade in the app", "create"),
      );
      break;
    }
    case "error": {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = state.message;
      menu.append(note);
      menu.append(
        state.loginNeeded
          ? item("Sign in to Zinc…", "create", () => {
              openApp("/login");
              closeMenu();
            })
          : item("Try again", "create", () => void openMenu()),
      );
      break;
    }
  }
  place();
}

function errorState(e: unknown): MenuState {
  if (e instanceof ApiError && e.status === 401) {
    return { kind: "error", message: "Sign in to use your Zinc aliases here.", loginNeeded: true };
  }
  const message = e instanceof Error ? e.message : "Zinc is temporarily unavailable.";
  return { kind: "error", message, loginNeeded: false };
}

function useAlias(row: SiteAlias): void {
  if (target) fill(target, row.email);
  closeMenu();
  detach();
}

async function openMenu(): Promise<void> {
  if (!target) return;
  const seq = ++openSeq;
  menuOpen = true;
  menu.hidden = false;
  render(cache.length ? { kind: "list", rows: cache, canCreate: true } : { kind: "loading" });
  try {
    const site = await fetchSiteAliases();
    cache = site.rows;
    saveCache();
    if (seq === openSeq && menuOpen) render({ kind: "list", ...site });
  } catch (e) {
    if (seq === openSeq && menuOpen) render(errorState(e));
  }
}

function closeMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  menu.hidden = true;
  if (target && document.activeElement !== target) detach();
}

async function mintAndFill(): Promise<void> {
  if (!target) return;
  const seq = ++openSeq;
  setLoading(true);
  try {
    const row = await createAlias();
    cache = [row, ...cache.filter((r) => r.email !== row.email)];
    saveCache();
    useAlias(row);
  } catch (e) {
    if (seq === openSeq) {
      menuOpen = true;
      menu.hidden = false;
      render(errorState(e));
    }
  } finally {
    setLoading(false);
  }
}

/** Context menu "fill": reuse the latest alias for this site, else mint one. */
async function fillFromContextMenu(el: Fillable): Promise<void> {
  attach(el);
  const seq = ++openSeq;
  setLoading(true);
  try {
    const site = await fetchSiteAliases();
    const row = site.rows[0] ?? (await createAlias());
    cache = [row, ...site.rows.filter((r) => r.email !== row.email)];
    saveCache();
    useAlias(row);
  } catch (e) {
    if (seq === openSeq) {
      menuOpen = true;
      menu.hidden = false;
      render(errorState(e));
    }
  } finally {
    setLoading(false);
  }
}

function contextTarget(): Fillable | null {
  if (lastRightClicked) return lastRightClicked;
  return isFillable(document.activeElement) ? document.activeElement : null;
}

function isBackgroundMessage(v: unknown): v is BackgroundToContent {
  return typeof v === "object" && v !== null && "type" in v && typeof v.type === "string";
}

// ---------------------------------------------------------------------------

function init(): void {
  void loadCache();

  document.addEventListener(
    "focusin",
    (e) => {
      if (isEmailInput(e.target)) attach(e.target);
    },
    true,
  );
  document.addEventListener("focusout", () => detach(), true);
  document.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);

  document.addEventListener(
    "mousedown",
    (e) => {
      lastRightClicked = e.button === 2 && isFillable(e.target) ? e.target : null;
      if (menuOpen && host && !e.composedPath().includes(host)) closeMenu();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && menuOpen) closeMenu();
    },
    true,
  );

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isBackgroundMessage(message)) return false;
    const el = contextTarget();
    if (el) {
      if (message.type === "menu.fill") void fillFromContextMenu(el);
      else {
        attach(el);
        void openMenu();
      }
    }
    sendResponse({ ok: true });
    return false;
  });
}

// The app itself needs no button on its own fields.
if (location.origin !== VIRTU_API_ORIGIN) init();
