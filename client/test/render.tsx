// Render helper for client DOM tests: mounts a page component inside the real
// providers (Mantine + React Query) and a memory router. The router carries
// stub "/" and "/login" destinations so in-app navigation resolves and a test
// can assert "the app navigated here" by finding the marker text.
//
// Transport is NOT mocked — the SDK's relative /api calls hit the running stack
// (happy-dom's document origin is the API; see test/happydom.ts).

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { FunctionComponent } from "react";
import { theme } from "src/theme";

export const HOME_MARKER = "stub:home";
export const LOGIN_MARKER = "stub:login";

/**
 * Render `Component` mounted at `path` (default "/register") with the app's
 * providers and a memory router. Returns the RTL utils plus the test router.
 */
export function renderPage(Component: FunctionComponent, path = "/register") {
  const rootRoute = createRootRoute();
  const routes = [createRoute({ getParentRoute: () => rootRoute, path, component: Component })];
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
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <MantineProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { router, queryClient, ...utils };
}
