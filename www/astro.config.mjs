// @ts-check
import { defineConfig } from "astro/config";

// Static marketing site. Zero client JS; plain files served by caddy in prod.
// In dev it runs behind the same reverse proxy at / (see the root Caddyfile),
// so bind all interfaces and accept the proxied Host header.
export default defineConfig({
  output: "static",
  server: { host: true },
  vite: { server: { allowedHosts: true } },
});
