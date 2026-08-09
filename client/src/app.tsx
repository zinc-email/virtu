// Code-based TanStack Router tree: "/" (authed shell) + "/login". The shell
// is the single centered column (max-width 58rem) from the legacy design.

import { Box } from "@mantine/core";
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { getApiKey } from "src/auth";
import { AliasesPage } from "src/pages/Aliases";
import { BillingPage } from "src/pages/Billing";
import { LoginPage } from "src/pages/Login";

function Shell() {
  return (
    <Box maw="58rem" mx="auto" px="1rem">
      <Outlet />
    </Box>
  );
}

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    if (!getApiKey()) throw redirect({ to: "/login" });
  },
  component: AliasesPage,
});

const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing",
  beforeLoad: () => {
    if (!getApiKey()) throw redirect({ to: "/login" });
  },
  component: BillingPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, billingRoute, loginRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
