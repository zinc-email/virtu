# ----------------------------------------------------------------------------
# justfile — project-wide command shortcuts
#
# Shortcuts only, never authority. Recipes must stay one-liners — any
# many-line logic belongs in a `bin/` script that the recipe delegates to.
#
# Entirely optional: a teammate without `just` installed must still be able
# to run any routine task by invoking the underlying script directly. No CI
# step or Dockerfile depends on `just` being present.
#
# Naming: concern first, action last (e.g. `db-push`, `format-check`, not
# `push-db` / `check-format`) so related recipes alpha-sort together.
# ----------------------------------------------------------------------------

set dotenv-load := true
set positional-arguments := true

# List all the commands
list:
  just --list

# ----------------------------------------------------------------------------
# Dev stack — daily-driver lifecycle for the local Docker Compose services
# ----------------------------------------------------------------------------

# Start the dev stack (db, api, client)
up *args="-d --wait":
  bin/compose up {{args}}

# Stop the dev stack
down:
  bin/compose down

# View docker logs
logs *args="-f":
  bin/compose logs {{args}}

# ----------------------------------------------------------------------------
# Serve preview — local prod-like stack (docker-compose.serve.yml under its
# own compose project: self-signed cert, won't touch dev, mail listeners on
# loopback high ports)
# ----------------------------------------------------------------------------

# Build + start the prod-like preview -> https://localhost:8443 (curl -k)
preview *args="--build -d":
  bin/compose -p virtu-serve -f docker-compose.serve.yml up {{args}}

# Tear down the preview stack
preview-down *args="":
  bin/compose -p virtu-serve -f docker-compose.serve.yml down {{args}}

# Preview stack logs
preview-logs *args="-f":
  bin/compose -p virtu-serve -f docker-compose.serve.yml logs {{args}}

# ----------------------------------------------------------------------------
# Database — Drizzle Kit (push-based migrations)
# ----------------------------------------------------------------------------

# Drizzle Kit inside the stack (`just db push` — prompts on lossy SQL, wants a TTY).
db *args="--help":
  bin/server-run bun drizzle-kit {{args}}

# ----------------------------------------------------------------------------
# Build & code-gen — OpenAPI spec, generated client SDK
# ----------------------------------------------------------------------------

# Regenerate the committed OpenAPI spec AND the client SDK (in that order)
gen:
  bin/gen

# Regenerate only server/spec/openapi.json (committed artifact)
openapi-gen:
  bin/openapi-gen

# ----------------------------------------------------------------------------
# Tests — tiers by filename suffix (madi RFC 0003 convention)
# ----------------------------------------------------------------------------

# Pure-function tests only. No DB, no docker.
test-unit *args="":
  cd server && bun test unit.test {{args}}

# Fastify routes via app.inject() against the dockerized postgres.
# Requires `just up` + `just db push` first. See bin/test-int.
test-int *args="":
  bin/test-int {{args}}

# Client DOM tests (*.dom.test.tsx): real React pages driving the running
# stack over HTTP. Requires `just up` + `just db push` first. See bin/test-client.
test-client *args="":
  bin/test-client {{args}}

# Bridge contract tests (*.contract.test.ts): the real client shell seam
# driven through each shell's real shim (mobile/*/contract/). Pure bun — no
# JDK, Xcode, SDK, docker, or device. Also part of `just check`.
test-contract *args="":
  bun test mobile {{args}}

# Start the simulated internet (fake DNS, peer MTAs, test-runner).
# Fully isolated from the dev stack; no published host ports.
test-net-up:
  docker compose -f docker-compose.test.yml up -d --build --wait

# Tear down the simulated internet, including the shared mail spool.
test-net-down:
  docker compose -f docker-compose.test.yml down -v

# Story tests (*.story.test.ts), run inside the simulated internet's
# test-runner container. Requires `just test-net-up` first.
test-story *args="":
  docker compose -f docker-compose.test.yml exec test-runner bun test story.test {{args}}

# Logs from the simulated internet (default: follow the mail service —
# its pipeline log lines are the fastest story-debug tool).
test-net-logs *args="-f mail":
  docker compose -f docker-compose.test.yml logs {{args}}

# Service status for the simulated internet.
test-net-ps:
  docker compose -f docker-compose.test.yml ps

# ----------------------------------------------------------------------------
# Dev users — local login ergonomics (requires the dev stack)
# ----------------------------------------------------------------------------

# Run a dev user through the passwordless login flow; prints the API key.
user-create email="wes@qmail.com":
  bin/user-create {{email}}

# Seed a dev OPERATOR: user-create + the admin flag (default ops@qmail.com).
operator-create email="ops@qmail.com":
  bin/operator-create {{email}}

# Print the newest emailed verification code for an address (from the queue).
login-code email:
  bin/login-code {{email}}

# ----------------------------------------------------------------------------
# Ops — queue + admin break-glass (direct DB; work with the API down)
# ----------------------------------------------------------------------------

# Grant the admin flag to a user (mints the FIRST admin — see PLAN Lane K).
admin-grant email:
  bin/admin-grant {{email}}

# Clear the admin flag on a user.
admin-revoke email:
  bin/admin-revoke {{email}}

# DSN the originator, then fail the row ("bounced by operator") — polite drop.
queue-bounce +ids:
  bin/queue-bounce {{ids}}

# Hard-delete terminal rows (failed/sent) ahead of retention.
queue-delete +ids:
  bin/queue-delete {{ids}}

# Drop queue rows: pending/sending -> failed ("dropped by operator"). Silent.
queue-drop +ids:
  bin/queue-drop {{ids}}

# List outbound_messages rows, newest first (optional status filter).
queue-list *args="":
  bin/queue-list {{args}}

# Requeue failed rows for immediate re-attempt (tries reset).
queue-requeue +ids:
  bin/queue-requeue {{ids}}

# Queue counts by status + oldest pending age.
queue-stats:
  bin/queue-stats

# ----------------------------------------------------------------------------
# Homepage — static marketing site (Astro, www/)
# ----------------------------------------------------------------------------

# Build the static homepage into www/dist/
www-build:
  cd www && bun install && bun run build

# Astro dev server for the homepage
www-dev:
  cd www && bun run dev

# ----------------------------------------------------------------------------
# Checks — format, typecheck, and the CI gauntlet
# ----------------------------------------------------------------------------

# Run every check CI runs — format-check, typecheck, unit tests. See bin/check.
check *args="":
  bin/check {{args}}

# Verify repo formatting with Biome. Non-zero exit on drift.
format-check:
  bin/format-check

# Apply Biome formatting fixes across the repo in place.
format-write:
  bin/format-write

# Run `tsc --noEmit` across server + client. See bin/typecheck.
typecheck:
  bin/typecheck
