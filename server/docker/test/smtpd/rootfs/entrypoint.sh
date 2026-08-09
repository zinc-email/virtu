#!/bin/sh

# startup scripts
ENTRYPOINT_D=/entrypoint.d
if [ -d "$ENTRYPOINT_D" ]; then
  echo "Running the following entrypoint.d scripts:"
  run-parts --test "$ENTRYPOINT_D"
  run-parts --exit-on-error "$ENTRYPOINT_D"
fi

exec "$@"
