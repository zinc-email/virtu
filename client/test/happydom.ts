// Bun-test preload: install a DOM so React can render (bun test is headless).
// Runs first (see bunfig.toml) so window/document exist before any test module
// — including @testing-library/react — is evaluated.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Point the document at the API origin so the SDK's relative `/api/...` calls
// resolve to the real Fastify server (same-origin — no proxy, no CORS). The
// client DOM tier is a real-transport tier: it drives the running stack, like
// the int/story tiers. Override with API_TEST_ORIGIN.
const apiOrigin = process.env.API_TEST_ORIGIN ?? "http://localhost:3000";
GlobalRegistrator.register({ url: apiOrigin });

// Mantine reads matchMedia (color scheme) and some components observe resize.
// happy-dom doesn't implement either; stub the shapes we touch so a render
// doesn't throw. Harmless if happy-dom later gains them.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }) as unknown as MediaQueryList;
}

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
