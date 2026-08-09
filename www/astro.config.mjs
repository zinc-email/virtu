// @ts-check
import { defineConfig } from "astro/config";

// Static marketing site. Zero client JS; plain files served by caddy.
export default defineConfig({
  output: "static",
});
