import fs from "node:fs";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

// In the compose stack the api is reachable by service name; natively it's
// localhost. Same trick as madi. API_PROXY_TARGET overrides both (useful
// when the native api runs on a non-default port, e.g. API_PORT=3101).
const isDocker = fs.existsSync("/.dockerenv");
const apiTarget =
  process.env.API_PROXY_TARGET ?? (isDocker ? "http://api:3000" : "http://localhost:3000");

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: "./src/index.tsx" } },
  html: { title: "virtu" },
  output: { distPath: { root: "dist" } },
  server: {
    port: 9000,
    // Reachable from outside the container in the compose stack.
    host: "0.0.0.0",
    // SPA fallback: every unmatched text/html GET serves the app shell.
    historyApiFallback: {
      rewrites: [{ from: /./, to: "/index.html" }],
    },
    proxy: {
      // The /api prefix is part of the real URL (SimpleLogin-style), so no
      // path rewrite — requests reach Fastify verbatim.
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
