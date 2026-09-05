// Per-page document <head>. Today that is the title — "Page — Zinc", the
// homepage's convention — so the tab and every history entry (the back
// button's menu) name the page. Called once per page component with the
// words its heading already uses; detail pages pass the entity (undefined
// until it loads → the bare brand).
//
// Options object on purpose: the app is behind a login, so search engines
// never see it and there is no description/OG story here (the Astro homepage
// carries that per page). If a field is ever needed — a theme-color per
// section, a robots hint for a public page — it lands here without touching
// the call sites.
import { useEffect } from "react";

const BRAND = "Zinc";

export interface Head {
  /** Page name; undefined while an entity is still loading. */
  title: string | undefined;
}

export function useHead({ title }: Head) {
  useEffect(() => {
    document.title = title ? `${title} — ${BRAND}` : BRAND;
  }, [title]);
}
