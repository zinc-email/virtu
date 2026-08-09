// API key storage. SimpleLogin-style clients hold a long-lived api_key from
// POST /auth/login and send it on every request in the Authentication header
// (see src/api/client.ts).

const STORAGE_KEY = "virtu.apiKey";

export function getApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
