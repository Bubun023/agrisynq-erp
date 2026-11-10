#!/usr/bin/env bash
# Rebuilds a THROWAWAY Postgres (Docker), applies migrations 001..N and runs the SQL tests.
# Never point this at a real Supabase project - it drops and recreates the "fl" database.
#   bash supabase/tests/run_db_tests.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1                       # Git Bash on Windows: stop it rewriting /paths
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations"
# docker.exe needs native paths on Windows (Git Bash); cygpath is absent elsewhere
w() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
C=fl-pg

# create the container if missing, start it if it exists but is stopped (e.g. after a Docker restart)
if docker inspect "$C" >/dev/null 2>&1; then
  [ "$(docker inspect -f '{{.State.Running}}' "$C")" = "true" ] || docker start "$C" >/dev/null
else
  docker run -d --name "$C" -e POSTGRES_PASSWORD=pw postgres:16-alpine >/dev/null
fi
# ready = it really answers a query (pg_isready can say yes while the image's first-run init server is still up)
ready() { docker exec "$C" psql -U postgres -tAc "select 1" >/dev/null 2>&1; }
for _ in $(seq 1 90); do ready && break; sleep 1; done
# a brand-new postgres image answers from a temporary init server, shuts it down, then starts the real one: wait for that to finish
for _ in $(seq 1 90); do docker logs "$C" 2>&1 | grep -q "PostgreSQL init process complete" && break; sleep 1; done
for _ in $(seq 1 90); do ready && break; sleep 1; done
ready || { echo "Postgres container '$C' did not become ready"; docker ps -a --filter "name=$C" || true; docker logs "$C" 2>&1 | tail -30 || true; exit 1; }

docker exec "$C" psql -U postgres -q -c "DROP DATABASE IF EXISTS fl WITH (FORCE)" -c "CREATE DATABASE fl"
docker cp "$(w "$HERE/supabase_stub.sql")" "$C:/stub.sql" >/dev/null
docker exec "$C" psql -U postgres -d fl -v ON_ERROR_STOP=1 -q -f /stub.sql >/dev/null

for f in "$MIG"/0*.sql; do
  docker cp "$(w "$f")" "$C:/m.sql" >/dev/null
  if ! out=$(docker exec "$C" psql -U postgres -d fl -v ON_ERROR_STOP=1 -q -1 -f /m.sql 2>&1); then
    echo "MIGRATION FAILED: $(basename "$f")"; echo "$out" | grep -iE "error|detail|context" | head -5; exit 1
  fi
  echo "ok   $(basename "$f")"
done

for t in "$HERE"/e2e_*.sql; do
  docker cp "$(w "$t")" "$C:/t.sql" >/dev/null
  docker exec "$C" psql -U postgres -d fl -v ON_ERROR_STOP=1 -q -f /t.sql 2>&1 | grep -E "ERROR|FAIL|PASSED|ok  " | sed 's/psql:[^ ]* NOTICE:  //'
done
