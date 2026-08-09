import fs from "node:fs";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

// In the compose stack the api is reachable by service name; natively it's
// localhost. Same trick as madi.
const isDocker = fs.existsSync("/.dockerenv");
const apiTarget = isDocker ? "http://api:3000" : "http://localhost:3000";

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
