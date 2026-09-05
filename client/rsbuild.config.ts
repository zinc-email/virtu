import fs from "node:fs";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

// In the compose stack the api is reachable by service name; natively it's
// localhost. Same trick as madi. API_PROXY_TARGET overrides both (useful
// when the native api runs on a non-default port, e.g. API_PORT=3101).
const isDocker = fs.existsSync("/.dockerenv");
const apiTarget =
  process.env.API_PROXY_TARGET ?? (isDocker ? "http://api:3000" : "http://localhost:3000");

// The SPA is mounted at /app behind the reverse proxy (www owns / for the
// static homepage). server.base makes the dev server serve — and dev.assetPrefix
// resolve assets — under /app; output.assetPrefix does the same for the prod
// build. TanStack Router's basepath (src/app.tsx) must match.
const BASE = "/app";

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: "./src/index.tsx" } },
  // Pre-hydration fallback; each page sets its own title (src/head.ts).
  html: { title: "Zinc" },
  output: { distPath: { root: "dist" }, assetPrefix: `${BASE}/` },
  // Prefix dev asset URLs too, so <script>/<link> in the shell resolve under
  // /app at the unified origin (not / , which the proxy routes to the homepage).
  // The HMR WebSocket also lives under the base: every client request stays
  // inside /app/*, so the reverse proxy needs exactly one route for the SPA.
  dev: { assetPrefix: `${BASE}/`, client: { path: `${BASE}/rsbuild-hmr` } },
  server: {
    base: BASE,
    port: 9000,
    // Reachable from outside the container in the compose stack.
    host: "0.0.0.0",
    // SPA fallback: unmatched GETs under the base serve the app shell.
    historyApiFallback: true,
    proxy: {
      // The /api prefix is part of the real URL (SimpleLogin-style), so no
      // path rewrite — requests reach Fastify verbatim. (At the unified origin
      // Caddy owns /api; this proxy only serves direct :9000 access.)
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
