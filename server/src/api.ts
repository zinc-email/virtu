// api entrypoint (PLAN: one of four — api, mx, submission, deliverd).

import { buildApp } from "./app/server";
import { config } from "./config";

const app = await buildApp();
await app.listen({ port: config.apiPort, host: config.apiHost });
