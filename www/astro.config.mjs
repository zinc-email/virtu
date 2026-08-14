// @ts-check
import { defineConfig } from "astro/config";

// Static marketing site. Zero client JS; plain files served by caddy in prod.
// In dev it runs behind the same reverse proxy at / (see the root Caddyfile),
// so bind all interfaces and accept the proxied Host header.
export default defineConfig({
  output: "static",
  // Astro's HTML compressor drops whitespace-only text nodes, including the
  // significant ones — where the formatter wrapped a line between an inline
  // element and its surrounding prose it produced "our <a>app</a>or <a>...",
  // "and you can<strong>revoke...". Not worth a few hundred bytes on a
  // 7-page static site.
  compressHTML: false,
  server: { host: true },
  vite: { server: { allowedHosts: true } },
});
