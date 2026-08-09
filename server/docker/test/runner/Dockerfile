# Test-runner image for the simulated internet (wave 2).
#
# oven/bun plus bind9-dnsutils: the story-test fixtures publish DKIM TXT
# records into the fake BIND's dynamic zones via `nsupdate`, and the test
# networks are `internal: true` — no way to apt-get at runtime — so the tool
# must be baked in at build time (builds run on the host with real network).
FROM oven/bun:1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bind9-dnsutils \
  && rm -rf /var/lib/apt/lists/*
