// Background service worker: the context-menu items and the API relay for
// the content script (messages.ts). Nothing here keeps state — MV3 workers
// are killed when idle, so every handler reads what it needs from storage.

import { apiFetch } from "./api.ts";
import type { BackgroundToContent, ContentToBackground } from "./messages.ts";

const MENU_FILL = "virtuFill";
const MENU_SHOW = "virtuShow";

// Chrome keeps menu items across worker restarts and errors on a duplicate
// id, so (re)create them from a clean slate on install/update.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_FILL,
      title: "Fill with a Zinc alias",
      contexts: ["editable"],
    });
    chrome.contextMenus.create({
      id: MENU_SHOW,
      title: "Show the Zinc button here",
      contexts: ["editable"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  const message: BackgroundToContent | null =
    info.menuItemId === MENU_FILL
      ? { type: "menu.fill" }
      : info.menuItemId === MENU_SHOW
        ? { type: "menu.show" }
        : null;
  if (!message) return;
  // Only the frame that was right-clicked knows which field it was.
  const frameId = info.frameId ?? 0;
  chrome.tabs.sendMessage(tab.id, message, { frameId }).catch((err: unknown) => {
    // No content script in this frame (chrome:// pages, the store, PDFs…).
    console.debug("virtu: no content script to receive", message.type, err);
  });
});

function isContentMessage(v: unknown): v is ContentToBackground {
  return typeof v === "object" && v !== null && "type" in v && typeof v.type === "string";
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isContentMessage(message)) return false;
  switch (message.type) {
    case "api":
      void apiFetch(message.method, message.path, message.body).then(sendResponse);
      return true; // async reply
    case "app.open": {
      const url = chrome.runtime.getURL(
        `app/index.html${message.route ? `#${message.route}` : ""}`,
      );
      void chrome.tabs.create({ url }).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
});
