#!/usr/bin/env bash
# Local Supabase-compatible dev stack for FertiLedger ERP (separate ports from any other Supabase project).
#   bash supabase/local/stack.sh up      start everything, apply migrations on first run, write .env.development.local
#   bash supabase/local/stack.sh migrate re-apply ALL migrations to a fresh public schema (destroys local data)
#   bash supabase/local/stack.sh apply <file.sql>...   apply new migration file(s) to the running DB and reload the API
#   bash supabase/local/stack.sh seed    create the demo company + admin user (admin@fertiledger.test / Admin#12345)
#   bash supabase/local/stack.sh down    stop containers (data kept);  `reset` also deletes the data volume
# Requires Docker Desktop running. DEV ONLY.
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
w() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
DC=(docker compose -f "$(w "$HERE/docker-compose.yml")" -p fertiledger)
DB=fl-local-db
psqlx() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

wait_db() { for _ in $(seq 1 60); do docker exec "$DB" pg_isready -U postgres -h localhost >/dev/null 2>&1 && return 0; sleep 2; done; echo "database did not start"; exit 1; }

apply_migrations() {
  echo "applying migrations (as the non-superuser postgres role, like Supabase)..."
  for f in "$ROOT"/supabase/migrations/0*.sql; do
    docker cp "$(w "$f")" "$DB:/m.sql" >/dev/null
    if ! out=$(docker exec "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -1 -f /m.sql 2>&1); then
      echo "MIGRATION FAILED: $(basename "$f")"; echo "$out" | head -8; exit 1
    fi
    echo "  ok $(basename "$f")"
  done
}

case "${1:-up}" in
  up)
    "${DC[@]}" up -d db
    wait_db
    # reserved roles can only be changed by the real superuser
    docker exec -i "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER USER authenticator WITH PASSWORD 'postgres';
ALTER USER supabase_auth_admin WITH PASSWORD 'postgres';
SQL
    "${DC[@]}" up -d auth
    for _ in $(seq 1 60); do
      [ "$(docker exec "$DB" psql -U postgres -At -c "select to_regclass('auth.users') is not null and exists(select 1 from auth.schema_migrations)" 2>/dev/null)" = "t" ] && break; sleep 2
    done
    if [ "$(docker exec "$DB" psql -U postgres -At -c "select to_regclass('public.tenants') is not null")" != "t" ]; then apply_migrations; fi
    "${DC[@]}" up -d rest kong
    node "$(w "$HERE/gen-keys.mjs")" --write >/dev/null
    for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:55321/auth/v1/health && break; sleep 2; done
    echo "stack is up:  API http://127.0.0.1:55321   Postgres 127.0.0.1:55322   (env written to .env.development.local)"
    ;;
  migrate)
    psqlx -d postgres -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;"
    apply_migrations
    docker kill -s SIGUSR1 fl-local-rest >/dev/null 2>&1 || true
    ;;
  apply)   # apply one migration file (or all not-yet-applied ones named on the command line) to the running DB
    shift
    for f in "$@"; do
      docker cp "$(w "$f")" "$DB:/m.sql" >/dev/null
      docker exec "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -1 -f /m.sql && echo "  ok $(basename "$f")"
    done
    docker kill -s SIGUSR1 fl-local-rest >/dev/null 2>&1 || true
    ;;
  seed)
    node "$(w "$HERE/seed.mjs")"
    ;;
  down)  "${DC[@]}" stop ;;
  reset) "${DC[@]}" down -v ;;
  *) echo "usage: stack.sh up|migrate|seed|down|reset"; exit 1 ;;
esac
