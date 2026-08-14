// API key storage. SimpleLogin-style clients hold a long-lived api_key from
// POST /auth/login and send it on every request in the Authentication header
// (see src/api/client.ts).

import { shellClearApiKey, shellStoreApiKey } from "./shell";

const STORAGE_KEY = "virtu.apiKey";

export function getApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

// Inside a mobile shell the key is mirrored to Keychain/Keystore so the
// native share/autofill extensions can call the API too (src/shell.md).

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
  shellStoreApiKey(key);
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
  shellClearApiKey();
}
