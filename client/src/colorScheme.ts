// Light/dark scheme, self-owned (no UI framework): the scheme lives as a
// data-color-scheme attribute on <html> — Panda's `_light` condition keys off
// it — plus the CSS color-scheme property so native widgets (select popups,
// scrollbars) follow. Persisted in localStorage; dark is the default look.

export type ColorScheme = "dark" | "light";

const KEY = "virtu.colorScheme";

export function getColorScheme(): ColorScheme {
  return localStorage.getItem(KEY) === "light" ? "light" : "dark";
}

function apply(scheme: ColorScheme): void {
  document.documentElement.dataset.colorScheme = scheme;
  document.documentElement.style.colorScheme = scheme;
}

/** Stamp the persisted scheme on <html>; call once before first render. */
export function initColorScheme(): void {
  apply(getColorScheme());
}

export function setColorScheme(scheme: ColorScheme): void {
  localStorage.setItem(KEY, scheme);
  apply(scheme);
}
