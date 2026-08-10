# CLAUDE.md

Orientation for an agent working in this repo. Rules here override defaults.

## What this is

**virtu-ts** — an email alias/proxy service: users mint a unique address per
sign-up and revoke it when it leaks or gets abused. A Bun + TypeScript rewrite
of a legacy PHP/postfix stack, with a SimpleLogin-compatible API. Open source
(AGPL-3.0).

## Read these first, in order

1. **`PLAN.md`** — the design doc: architecture, the mail pipeline, and the
   settled decisions (numbered; e.g. no milters, in-process mailauth signing,
   VERP bounce scheme, native mobile shells). When generic advice conflicts
   with PLAN.md, **PLAN.md wins**.
2. **`STATE.md`** — the progress ledger: what's built, how it was verified,
   what's stubbed, what's not started, and the upstream workarounds. Keep it
   current as you land work.

## Stack

Bun runtime · one `server/` package with several entrypoints (`api`, `mx`,
`submission`, `deliverd`, and `maild` = all three mail processes in one) ·
Fastify + `fastify-zod-openapi` · Drizzle over Bun's native postgres
(`drizzle-orm/bun-sql`, push-based migrations) · `mailauth` for all
DKIM/ARC/SPF/DMARC (verify and sign, in-process — no milters) · a plain
`outbound_messages` Postgres table as the delivery queue · React SPA (rsbuild
+ TanStack Router/Query + Panda CSS) with a Kubb-generated SDK · Astro static
homepage (`www/`).

**No UI component frameworks in the client.** Mantine was removed and is
banned — everything is semantic HTML styled with Panda CSS: tokens in
`client/panda.config.ts`, primitives in `client/src/ui.tsx`, overlays on
native `<dialog>` in `client/src/overlays.tsx`. Extend the kit, don't add a
component library. Root font-size scales (18px → 24px @1200px); size in
rem/em, never px.

**Dev/prod topology.** A Caddy reverse proxy fronts everything at one origin
with a fixed path split — `/` homepage, `/app/*` SPA, `/api/*` API — identical
in dev and prod. So the SPA is served under `/app`: rsbuild's
`server.base`/`assetPrefix` and TanStack Router's `basepath` are all `/app`
(change them together); the homepage links to the app with absolute `/app/*`
paths. Two Caddyfiles, same path topology:

- **`Caddyfile.dev`** — the dev proxy: reverse_proxy to the live dev servers
  (HMR). `just up` runs the whole stack behind `http://localhost:8080`.
- **`Caddyfile`** — the universal deploy file (madi-style): serves the built
  `www/dist` + `client/dist`, proxies `/api`, host + TLS from env
  (`VIRTU_HOST`, `VIRTU_TLS_*`). One file for `localhost`, `zinc.email`
  (prod), and `lmnop.email` (staging) — each box sets its own `VIRTU_HOST`.
  `docker-compose.serve.yml` builds the frontends and runs it; see README
  "Deploy". Remaining deploy-lane work: mail processes in the serve stack,
  host provisioning, per-box TLS.

We name environments **zinc** (prod) and **lmnop** (staging), never
prod/staging.

## Conventions

- **Naming: concern first, action last** — `db-push`, `format-check`,
  `test-net-up` (not `push-db`), so related recipes/scripts alpha-sort.
  Applies to `bin/` scripts (no extension) and justfile recipes alike.
- **`just` is convenience, not authority.** Recipes are one-liners delegating
  to `bin/` scripts; anything with a loop/conditional/env munging is a
  `bin/` script (`#!/usr/bin/env bash`, `set -euo pipefail`, `chmod +x`). If a
  recipe grows past one line, extract it.
- **No Bun workspaces.** Each of `server/`, `client/`, `www/` owns its own
  `package.json` + lockfile; the root holds only biome + lefthook. Run
  `bun install` per package. Server↔client couple only through the committed
  `server/spec/openapi.json`, never a code import.
- **Formatter is Biome** (`just format-write`); **linter is per-package
  ESLint**. Pre-commit runs biome on staged files — install once per machine
  with `bunx lefthook install`. Worktrees need the root `bun install` or the
  hook silently no-ops.
- **Avoid `as` casts — type it properly instead.** A cast is an unchecked
  claim; it's exactly where drift sneaks back past the type-safety spine. Fix
  the types (generics, narrowing, discriminated unions, the generated SDK
  types) rather than assert over them. Reach for `as` only when the language
  genuinely leaves no alternative, and in tests only where a library's types
  force it (e.g. stubbing a DOM global) — and justify each one with a nearby
  comment. **Never** silence an error with `as any` / `as unknown as T` that
  correct typing would resolve.

## Test tiers (by filename suffix)

- `*.unit.test.ts` — pure, no DB/network/docker. `just test-unit`.
- `*.int.test.ts` — Fastify routes via `app.inject()` against the dockerized
  Postgres. `just up && just db push`, then `just test-int`. Parallel-safe by
  unique-data-per-test; no truncation.
- `*.story.test.ts` — end-to-end mail through the **simulated internet**
  (fake DNS + peer MTAs, `docker-compose.test.yml`). `just test-net-up`, then
  `just test-story`; `just test-net-logs` to watch the mail pipeline,
  `just test-net-down` to tear down. Messages are located by an
  `X-Virtu-Test-Id` header in Maildir — no resets, run in any order.
- `*.dom.test.tsx` (client) — real React pages rendered in happy-dom, driving
  the **running stack over real HTTP** (transport is *not* mocked; happy-dom's
  document origin is the API). `just up && just db push`, then
  `just test-client`. Parallel-safe by unique-data-per-test, like the int tier.
  When a test needs something only the server can produce (the emailed
  activation code today; DNS zone edits for custom domains later) it invokes a
  `bin/` tool over a **process boundary** via `client/test/tooling.ts` — never a
  client→server code import or a client DB reach-in. Harness:
  `client/test/{happydom,setup,render,tooling}.ts` + `client/bunfig.toml`.

`just check` = format + both typechecks (regenerates the SDK) + unit tests;
green here means CI passes. The int/story/dom tiers need docker and run
separately (like `just test-int`), so they're **not** in `just check` or CI.

## Code-gen pipeline (one direction) — the type-safety spine

Drizzle schema → drizzle-zod insert/select shapes → route Zod schemas →
OpenAPI spec → Kubb SDK → client. One definition per fact, flowing outward; a
DB column rename surfaces as a client compile error. See PLAN.md "The
type-safety spine" for the full rationale. **Never edit generated code or start
downstream with a stale spec.**

1. Change `server/src/db/schema.ts`, `routes/`, or response schemas.
2. `bin/openapi-gen` writes `server/spec/openapi.json` (**committed artifact**).
3. `cd client && bun run kubb` regenerates `client/src/gen` (gitignored).
4. Update the client against the new SDK. `just gen` chains 2–3.

`server/src/db/schema.ts` is the coordination point — changes there ripple
everywhere, so review them; everything else is additive.

## Local login (dev)

Registration requires an emailed 6-digit code, and the dev stack runs no
`deliverd`, so codes sit in the queue. Shortcuts:

- `just user-create [email] [password]` — register + activate + login, prints
  the API key (defaults `wes@qmail.com` / `password1234`). Idempotent.
- `just login-code <email>` — newest emailed code for an address (also mailbox
  verification).

## Don't-break list

- **Bun server-side STARTTLS bridge** (`server/src/smtp/server.ts`,
  `upgradeServerSocket`) — a loopback `tls.Server` workaround for a Bun bug
  (server `TLSSocket` upgrades don't complete; fixed upstream in PR #34598,
  unreleased as of 1.3.14). Don't "simplify" it away until a Bun release ships
  the fix; then swap to native and run `bun test server/src/smtp`.
- **Bun `node:dns` TXT flattening** (`server/src/pipeline/dnsTxt.ts`) — a
  wire-format TXT client, because Bun's `node:dns` merges multi-string TXT
  records and DKIM keys span several strings. Use it for TXT lookups, not
  `node:dns`.
- `server/.env` is gitignored (holds Stripe test keys). `server/.env.example`
  documents every var.

## Where things live

Mail: `server/src/{smtp,mailauth,mail,pipeline,queue}/` + `src/*.ts`
entrypoints. API + committed spec: `server/src/routes/`, `server/spec/`.
Simulated internet: `docker-compose.test.yml`, `server/docker/test/`, harness
+ stories in `server/test/`. Client: `client/src/`. Homepage: `www/`.
