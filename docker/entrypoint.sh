#!/bin/sh
# The container's start: refresh the skill link and the learning folder (TEACH_DEMO=1 adds the demo topics to an empty
# one), then run the server. Any other command runs instead, e.g. `docker compose run --rm teach claude` to log in.
set -e
if [ $# -eq 0 ]; then
  node /app/cli.mjs setup --no-service --no-command $([ "${TEACH_DEMO:-}" = 1 ] && echo --demo)
  exec node /app/cli.mjs serve
fi
exec "$@"
