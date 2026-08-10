// Code-based TanStack Router tree + the app shell: the legacy one-column
// layout — Z logo top-left (a back arrow on detail pages), right-aligned nav
// links with the teal active underline, a centered 58rem main column, and a
// footer holding logout + the color-scheme toggle.

import { useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { css, cx } from "styled-system/css";
import { clearApiKey, getApiKey } from "src/auth";
import { getLogout } from "src/gen";
import { AliasDetailPage } from "src/pages/AliasDetail";
import { AliasesPage } from "src/pages/Aliases";
import { BillingPage } from "src/pages/Billing";
import { LoginPage } from "src/pages/Login";
import { RegisterPage } from "src/pages/Register";
import { SettingsPage } from "src/pages/Settings";
import { Icon, Logo } from "src/ui";

// ── Header nav ───────────────────────────────────────────────────────────────

const navList = css({
  display: "flex",
  alignItems: "center",
  listStyle: "none",
  margin: 0,
  padding: "3rem 3rem 0 3rem",
  "@media (max-width: 650px)": { padding: "1rem" },
});

const navLinkCss = css({
  display: "block",
  padding: "0 0.4rem 1rem 0.4rem",
  color: "navLink",
  textDecoration: "none",
  fontSize: "0.8rem",
  borderBottom: "0.1rem solid transparent",
  _hover: { color: "navLinkActive", borderColor: "hairline" },
});
const navLinkActiveCss = css({
  color: "navLinkActive",
  fontWeight: "bold",
  borderColor: "primary",
  _hover: { borderColor: "primary" },
});

function NavItem({ to, active, children }: { to: string; active: boolean; children: string }) {
  return (
    <li className={css({ marginRight: "2.5rem", _last: { marginRight: 0 } })}>
      <Link to={to} className={cx(navLinkCss, active ? navLinkActiveCss : undefined)}>
        {children}
      </Link>
    </li>
  );
}

function ThemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const isDark = useComputedColorScheme("dark") === "dark";
  return (
    <button
      type="button"
      className={footerLink}
      onClick={() => setColorScheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? "☀ Light" : "☾ Dark"}
    </button>
  );
}

const footerLink = css({
  display: "inline",
  margin: 0,
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  fontSize: "inherit",
  lineHeight: "inherit",
  textDecoration: "none",
  color: "textDim",
  _hover: { color: "navLink" },
});

// ── Shell ────────────────────────────────────────────────────────────────────

function Shell() {
  const navigate = useNavigate();
  const { location } = useRouterState();
  // location.pathname includes the /app basepath; compare against app paths.
  const path = location.pathname.replace(/^\/app(?=\/|$)/, "") || "/";
  const isAuthPage = path === "/login" || path === "/register";
  const isDetailPage = path.startsWith("/aliases/");
  const authed = Boolean(getApiKey());

  const logout = async () => {
    try {
      await getLogout();
    } catch {
      // key may already be dead — local logout proceeds regardless
    }
    clearApiKey();
    void navigate({ to: "/login" });
  };

  return (
    <div
      className={css({
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "bg",
        color: "text",
        fontFamily: "sans",
      })}
    >
      <header>
        <nav
          className={css({
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          })}
        >
          <ul className={navList}>
            <li>
              {isDetailPage ? (
                <Link
                  to="/"
                  aria-label="Back to your aliases"
                  className={css({
                    display: "block",
                    color: "primary",
                    _hover: { color: "primaryHover" },
                  })}
                >
                  <Icon name="arrow-left" size="3rem" />
                </Link>
              ) : (
                <Link to={authed ? "/" : "/login"} aria-label="Zinc">
                  <Logo />
                </Link>
              )}
            </li>
          </ul>
          {authed && !isAuthPage && (
            <ul className={navList}>
              <NavItem to="/" active={path === "/" || isDetailPage}>
                Emails
              </NavItem>
              <NavItem to="/settings" active={path === "/settings"}>
                Settings
              </NavItem>
              <NavItem to="/billing" active={path === "/billing"}>
                Billing
              </NavItem>
            </ul>
          )}
        </nav>
      </header>

      <main className={css({ display: "flex", justifyContent: "center", flex: "1 0 auto" })}>
        <div className={css({ flex: "1 0 100%", maxWidth: "58rem", minWidth: 0 })}>
          <Outlet />
        </div>
      </main>

      <footer
        className={css({
          padding: "0 2rem 2rem 2rem",
          marginTop: "3rem",
          fontSize: "0.8rem",
          lineHeight: "0.8rem",
        })}
      >
        <ul
          className={css({
            display: "flex",
            flexFlow: "row-reverse",
            gap: "1rem",
            listStyle: "none",
            margin: 0,
            padding: 0,
          })}
        >
          {authed && !isAuthPage && (
            <li>
              <button type="button" className={footerLink} onClick={() => void logout()}>
                Log out
              </button>
            </li>
          )}
          <li>
            <ThemeToggle />
          </li>
        </ul>
      </footer>
    </div>
  );
}

// ── Routes ───────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({ component: Shell });

const requireAuth = () => {
  if (!getApiKey()) throw redirect({ to: "/login" });
};

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireAuth,
  component: AliasesPage,
});

const aliasDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/aliases/$aliasId",
  beforeLoad: requireAuth,
  component: AliasDetailPage,
});

const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing",
  beforeLoad: requireAuth,
  component: BillingPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireAuth,
  component: SettingsPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: RegisterPage,
});

export const router = createRouter({
  // The SPA is served under /app behind the reverse proxy; must match
  // rsbuild's server.base / output.assetPrefix (rsbuild.config.ts).
  basepath: "/app",
  routeTree: rootRoute.addChildren([
    indexRoute,
    aliasDetailRoute,
    billingRoute,
    settingsRoute,
    loginRoute,
    registerRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
