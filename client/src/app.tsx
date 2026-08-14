// Code-based TanStack Router tree + the app shell: the legacy one-column
// layout — Z logo top-left (a back arrow on detail pages), right-aligned nav
// links with the teal active underline, a centered 58rem main column, and a
// footer holding logout + the color-scheme toggle.

import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useCanGoBack,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { clearApiKey, getApiKey } from "src/auth";
import { getColorScheme, setColorScheme } from "src/colorScheme";
import { getLogout, useGetUserInfo } from "src/gen";
import { AdminOverviewPage } from "src/pages/AdminOverview";
import { AdminQueuePage } from "src/pages/AdminQueue";
import { AdminQueueMessagePage } from "src/pages/AdminQueueMessage";
import { AliasDetailPage } from "src/pages/AliasDetail";
import { AliasesPage } from "src/pages/Aliases";
import { AliasNewPage } from "src/pages/AliasNew";
import { BillingPage } from "src/pages/Billing";
import { DomainDetailPage } from "src/pages/DomainDetail";
import { DomainsPage } from "src/pages/Domains";
import { LoginPage } from "src/pages/Login";
import { MailboxDetailPage } from "src/pages/MailboxDetail";
import { MailboxesPage } from "src/pages/Mailboxes";
import { NotFoundPage } from "src/pages/NotFound";
import { SettingsPage } from "src/pages/Settings";
import { Drawer } from "src/overlays";
import { Icon, Logo } from "src/ui";

// ── Header nav ───────────────────────────────────────────────────────────────
// Below 1000px the inline links can't fit (5 items + logo + padding needs
// ~830px at the 18px root) — they collapse into a hamburger + drawer.

const NAV_ITEMS = [
  { to: "/", label: "Emails" },
  { to: "/mailboxes", label: "Mailboxes" },
  { to: "/domains", label: "Domains" },
  { to: "/settings", label: "Settings" },
  { to: "/billing", label: "Account" },
];

// Appended for operators only (user_info.is_admin — the server enforces
// regardless; hiding it is cosmetics, not security).
const ADMIN_NAV_ITEM = { to: "/admin", label: "Admin" };

const navList = css({
  display: "flex",
  alignItems: "center",
  listStyle: "none",
  margin: 0,
  padding: "3rem 3rem 0 3rem",
  "@media (max-width: 900px)": { padding: "1.5rem 1.5rem 0 1.5rem" },
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

/** Which nav item a path belongs to (details roll up to their section). */
function activeNavItem(path: string): string {
  if (path === "/" || path.startsWith("/aliases")) return "/";
  if (path.startsWith("/mailboxes")) return "/mailboxes";
  if (path.startsWith("/domains")) return "/domains";
  if (path.startsWith("/settings")) return "/settings";
  if (path.startsWith("/billing")) return "/billing";
  if (path.startsWith("/admin")) return "/admin";
  return "";
}

// The collapsed menu: same items, stacked with room to tap. Log out is NOT a
// nav item — it sits with the theme toggle in a quiet meta section pinned to
// the bottom, where it can't be fat-fingered.
function MobileMenu({
  opened,
  onClose,
  path,
  items,
  onLogout,
}: {
  opened: boolean;
  onClose: () => void;
  path: string;
  items: typeof NAV_ITEMS;
  onLogout: () => void;
}) {
  const active = activeNavItem(path);
  const itemCss = css({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "0.9rem 0.2rem",
    color: "navLink",
    textDecoration: "none",
    fontSize: "1rem",
    background: "none",
    border: "none",
    borderBottom: "1px solid token(colors.border)",
    cursor: "pointer",
    fontFamily: "sans",
    _hover: { color: "navLinkActive" },
  });
  return (
    <Drawer opened={opened} onClose={onClose} title={<Logo size="2.2rem" />}>
      <div
        className={css({
          display: "flex",
          flexDirection: "column",
          // Fill the drawer below its header (padding 1.5rem+2rem, logo
          // 2.2rem + 1.5rem margin) so the meta section pins to the bottom.
          minHeight: "calc(100dvh - 7.2rem)",
        })}
      >
        <nav>
          <ul className={css({ listStyle: "none", margin: 0, padding: 0 })}>
            {items.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  onClick={onClose}
                  className={cx(
                    itemCss,
                    item.to === active
                      ? css({ color: "navLinkActive", fontWeight: "bold", borderColor: "primary" })
                      : undefined,
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ul
          className={css({
            listStyle: "none",
            margin: 0,
            marginTop: "auto",
            padding: "2rem 0 0 0",
            display: "flex",
            gap: "1.5rem",
            fontSize: "0.8rem",
            lineHeight: "0.8rem",
          })}
        >
          <li>
            <button
              type="button"
              className={footerLink}
              onClick={() => {
                onClose();
                onLogout();
              }}
            >
              Log out
            </button>
          </li>
          <li>
            <ThemeToggle />
          </li>
        </ul>
      </div>
    </Drawer>
  );
}

function ThemeToggle() {
  const [scheme, setScheme] = useState(getColorScheme);
  const isDark = scheme === "dark";
  const flip = () => {
    const next = isDark ? "light" : "dark";
    setColorScheme(next);
    setScheme(next);
  };
  return (
    <button
      type="button"
      className={footerLink}
      onClick={flip}
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
  const routerInstance = useRouter();
  const canGoBack = useCanGoBack();
  const { location } = useRouterState();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  // location.pathname includes the /app basepath; compare against app paths.
  const path = location.pathname.replace(/^\/app(?=\/|$)/, "") || "/";
  // /register only survives as a redirect into /login (legacy links).
  const isAuthPage = path === "/login" || path === "/register";
  const isAliasDetail = path.startsWith("/aliases/");
  const isDomainDetail = path.startsWith("/domains/");
  const isMailboxDetail = path.startsWith("/mailboxes/");
  const isAdminQueueDetail = path.startsWith("/admin/queue/");
  // Detail pages swap the logo for the big back arrow. Admin pages chain:
  // message -> queue -> overview.
  const backTo = isAliasDetail
    ? "/"
    : isDomainDetail
      ? "/domains"
      : isMailboxDetail
        ? "/mailboxes"
        : isAdminQueueDetail
          ? "/admin/queue"
          : path === "/admin/queue"
            ? "/admin"
            : null;
  const authed = Boolean(getApiKey());
  const active = activeNavItem(path);
  // The Admin nav item exists only for operators. One cached fetch per
  // session; while it loads (or for everyone else) the nav is the plain set.
  const userInfo = useGetUserInfo({ query: { enabled: authed && !isAuthPage } });
  const navItems = userInfo.data?.is_admin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  const logout = async () => {
    try {
      await getLogout();
    } catch {
      // key may already be dead — local logout proceeds regardless
    }
    clearApiKey();
    // The cache is the previous account's data (user_info incl. is_admin,
    // aliases, settings …) — without this, whoever logs in next on this tab
    // briefly renders it before their own refetches land.
    queryClient.clear();
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
        // Backstop: a stray wide element must never give the PAGE a
        // horizontal scrollbar.
        overflowX: "clip",
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
              {backTo !== null ? (
                // A real history back (when there's an in-app entry) so
                // scroll restoration returns to where the index was left;
                // deep links fall back to a plain link to the index.
                canGoBack ? (
                  <button
                    type="button"
                    aria-label="Back"
                    onClick={() => routerInstance.history.back()}
                    className={css({
                      display: "block",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      color: "primary",
                      _hover: { color: "primaryHover" },
                    })}
                  >
                    <Icon name="arrow-left" size="3rem" />
                  </button>
                ) : (
                  <Link
                    to={backTo}
                    aria-label="Back"
                    className={css({
                      display: "block",
                      color: "primary",
                      _hover: { color: "primaryHover" },
                    })}
                  >
                    <Icon name="arrow-left" size="3rem" />
                  </Link>
                )
              ) : (
                <Link to={authed ? "/" : "/login"} aria-label="Zinc">
                  <Logo />
                </Link>
              )}
            </li>
          </ul>
          {authed && !isAuthPage && (
            <>
              <ul
                className={cx(navList, css({ "@media (max-width: 1000px)": { display: "none" } }))}
              >
                {navItems.map((item) => (
                  <NavItem key={item.to} to={item.to} active={item.to === active}>
                    {item.label}
                  </NavItem>
                ))}
              </ul>
              <button
                type="button"
                aria-label="Menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
                className={css({
                  display: "none",
                  "@media (max-width: 1000px)": { display: "block" },
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "navLink",
                  padding: "1rem",
                  marginRight: "0.5rem",
                  _hover: { color: "navLinkActive" },
                })}
              >
                <Icon name="bars" size="1.4rem" />
              </button>
            </>
          )}
        </nav>
      </header>

      <MobileMenu
        opened={menuOpen}
        onClose={() => setMenuOpen(false)}
        path={path}
        items={navItems}
        onLogout={() => void logout()}
      />

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

const requireAuth = ({ location }: { location: { href: string } }) => {
  // Remember where the visitor was headed; the login page returns them there
  // after the code round-trip (the legacy intendedLocation behavior).
  if (!getApiKey()) throw redirect({ to: "/login", search: { redirect: location.href } });
};

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireAuth,
  component: AliasesPage,
});

// Static /aliases/new outranks the $aliasId param route (TanStack ranks
// static segments above dynamic ones regardless of declaration order).
const aliasNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/aliases/new",
  beforeLoad: requireAuth,
  component: AliasNewPage,
});

const aliasDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/aliases/$aliasId",
  beforeLoad: requireAuth,
  component: AliasDetailPage,
});

const mailboxesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mailboxes",
  beforeLoad: requireAuth,
  component: MailboxesPage,
});

const mailboxDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mailboxes/$mailboxId",
  beforeLoad: requireAuth,
  component: MailboxDetailPage,
});

const domainsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/domains",
  beforeLoad: requireAuth,
  component: DomainsPage,
});

const domainDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/domains/$domainId",
  beforeLoad: requireAuth,
  component: DomainDetailPage,
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

// Admin section (operators only). requireAuth guards key presence like every
// page; the admin check itself is server-side — each page renders the 403 as
// a not-authorized state, so deep-linking non-admins leaks nothing.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: requireAuth,
  component: AdminOverviewPage,
});

const QUEUE_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type QueueStatusFilter = (typeof QUEUE_STATUSES)[number];

const adminQueueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/queue",
  beforeLoad: requireAuth,
  validateSearch: (search: Record<string, unknown>): { status?: QueueStatusFilter } => ({
    status: QUEUE_STATUSES.find((s) => s === search.status),
  }),
  component: AdminQueuePage,
});

const adminQueueMessageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/queue/$messageId",
  beforeLoad: requireAuth,
  component: AdminQueueMessagePage,
});

interface LoginSearch {
  /** Prefill from the www homepage CTA (GET /app/login?email=…). */
  email?: string;
  /** Where a guarded page wanted to go (full href incl. the /app basepath). */
  redirect?: string;
  /** "expired" when the api client bounced a dead key here. */
  reason?: string;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

// Post-login the redirect is handed to window.location.assign, so it must be a
// same-origin URL inside the /app basepath — otherwise ?redirect=https://evil…
// turns the login page into an open redirect (credible phishing from a trusted
// origin). Reject anything that resolves off-origin or outside /app; return a
// safe RELATIVE path (assign resolves it against our origin, no double-prefix).
const safeRedirect = (v: unknown): string | undefined => {
  if (typeof v !== "string" || v === "") return undefined;
  try {
    const url = new URL(v, window.location.origin);
    if (url.origin !== window.location.origin) return undefined;
    if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return undefined;
    return url.pathname + url.search + url.hash;
  } catch {
    return undefined;
  }
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    email: str(search.email),
    redirect: safeRedirect(search.redirect),
    reason: str(search.reason),
  }),
  component: LoginPage,
});

// Legacy entrypoint (old www forms and bookmarks): login and signup are the
// same flow now, so /register just forwards its ?email= along.
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: (search: Record<string, unknown>): { email?: string } => ({
    email: str(search.email),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/login", search: { email: search.email } });
  },
});

export const router = createRouter({
  // The SPA is served under /app behind the reverse proxy; must match
  // rsbuild's server.base / output.assetPrefix (rsbuild.config.ts).
  basepath: "/app",
  // Going back to an index page lands where you left off, not at the top.
  scrollRestoration: true,
  // Styled 404 — and the admin pages render this same component on a 403,
  // so a non-admin deep-linking /admin can't distinguish it from a bogus
  // URL (see pages/NotFound.tsx).
  defaultNotFoundComponent: NotFoundPage,
  routeTree: rootRoute.addChildren([
    indexRoute,
    aliasNewRoute,
    aliasDetailRoute,
    mailboxesRoute,
    mailboxDetailRoute,
    domainsRoute,
    domainDetailRoute,
    billingRoute,
    settingsRoute,
    adminRoute,
    adminQueueRoute,
    adminQueueMessageRoute,
    loginRoute,
    registerRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
