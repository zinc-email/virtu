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
# Database — Drizzle Kit (push-based migrations)
# ----------------------------------------------------------------------------

# Drizzle Kit shortcut (e.g. `just db push`). Runs natively against the
# compose db's published port (localhost:5432).
db *args="--help":
  cd server && bun drizzle-kit "$@"

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
