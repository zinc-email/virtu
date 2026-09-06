// Render helper for client DOM tests: mounts a page component inside the real
// providers (React Query) and a memory router. The router carries stub "/"
// and "/login" destinations so in-app navigation resolves and a test can
// assert "the app navigated here" by finding the marker text.
//
// Transport is NOT mocked — the SDK's relative /api calls hit the running stack
// (happy-dom's document origin is the API; see test/happydom.ts).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { FunctionComponent } from "react";

export const HOME_MARKER = "stub:home";
export const LOGIN_MARKER = "stub:login";

// Mirror the app's router basepath (src/app.tsx) so tests exercise the same
// routing config the SPA runs under at /app.
const BASE = "/app";

/**
 * Render `Component` mounted at `path` (default "/login") with the app's
 * providers and a memory router under the /app basepath. `search` (e.g.
 * "?email=x") seeds the initial URL query. `extraRoutes` registers additional
 * real pages the flow navigates to (e.g. a detail page). Returns the RTL
 * utils plus router.
 */
export function renderPage(
  Component: FunctionComponent,
  path = "/login",
  search = "",
  extraRoutes: { path: string; component: FunctionComponent }[] = [],
) {
  const rootRoute = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path, component: Component }),
    ...extraRoutes.map((r) =>
      createRoute({ getParentRoute: () => rootRoute, path: r.path, component: r.component }),
    ),
  ];
  if (path !== "/") {
    routes.push(
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <div>{HOME_MARKER}</div>,
      }),
    );
  }
  if (path !== "/login") {
    routes.push(
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/login",
        component: () => <div>{LOGIN_MARKER}</div>,
      }),
    );
  }
  const router = createRouter({
    basepath: BASE,
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [`${BASE}${path}${search}`] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, ...utils };
}

/**
 * Wait until `query` returns null — "the element went away". Use this, never
 * `waitFor(() => expect(query()).toBeNull())`: Bun's expect pretty-prints a
 * failing `received`, and a happy-dom element serializes to thousands of
 * lines, so each 50ms retry burns ~4s of CPU. The event loop (and the HTTP
 * response the test is waiting on) stalls until the timeout.
 */
export async function waitForGone(query: () => Element | null, timeout = 15_000): Promise<void> {
  await waitFor(
    () => {
      if (query() !== null) throw new Error("element is still on the page");
    },
    { timeout },
  );
}
