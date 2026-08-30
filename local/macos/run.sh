#!/bin/bash
# MetaMCP native launcher (LaunchAgent com.bryanlabs.metamcp).
# Mirrors docker-entrypoint.sh for native macOS use: load root .env, wait for
# Postgres, apply migrations (idempotent), then run the backend (port 12009)
# and frontend (port 12008) under a small supervisor.
set -u

# Allow an isolated Node runtime test without changing the system `node` link.
# Production defaults to Homebrew; INF-474 can prepend an official Node bundle.
NODE_DIR="${METAMCP_NODE_DIR:-/opt/homebrew/bin}"
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
echo "node runtime: $(command -v node) $(node --version)"

REPO="/Users/danb/code/github.com/Umbrella-IT-Group/metamcp"
ENV_FILE="$REPO/.env"
PNPM="/Users/danb/Library/Application Support/metamcp/node_modules/.bin/pnpm"

# --- Load root .env verbatim -------------------------------------------------
# We deliberately do NOT use `source`/`set -a`: several BOOTSTRAP_* values are
# JSON containing spaces, which bash word-splits when sourced. This loop keeps
# everything after the first `=` byte-for-byte, matching how the repo's own
# `db:migrate` (dotenv-cli) parses this same file.
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: env file not found: $ENV_FILE" >&2
  exit 1
fi
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  key=${line%%=*}
  val=${line#*=}
  export "$key=$val"
done < "$ENV_FILE"

# --- Wait for Postgres -------------------------------------------------------
tries=0
until pg_isready -h "${POSTGRES_HOST:-localhost}" -p "${POSTGRES_PORT:-5432}" \
        -U "${POSTGRES_USER:-metamcp}" -d "${POSTGRES_DB:-metamcp}" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "FATAL: Postgres not ready after 60 attempts" >&2
    exit 1
  fi
  echo "waiting for postgres... ($tries)"
  sleep 2
done
echo "postgres ready"

# --- Apply migrations (idempotent) ------------------------------------------
echo "running migrations..."
if ! ( cd "$REPO/apps/backend" && "$PNPM" run db:migrate ); then
  echo "FATAL: migrations failed" >&2
  exit 1
fi

# --- Start backend (listens on hardcoded 12009) ------------------------------
echo "starting backend on 12009..."
( cd "$REPO/apps/backend" && PORT=12009 exec node dist/index.js ) &
BPID=$!

# --- Start frontend (Next.js on 12008, loopback only) ------------------------
# Bind 127.0.0.1 explicitly (-H) so the client-facing proxy is not exposed on
# all interfaces. Invoke the Next binary directly to avoid pnpm arg-forwarding.
echo "starting frontend on 127.0.0.1:12008..."
( cd "$REPO/apps/frontend" && exec ./node_modules/.bin/next start -H 127.0.0.1 -p 12008 ) &
FPID=$!

shutdown() {
  echo "shutting down (backend=$BPID frontend=$FPID)..."
  kill -TERM "$BPID" "$FPID" 2>/dev/null || true
  for _ in $(seq 1 50); do
    if ! kill -0 "$BPID" 2>/dev/null && ! kill -0 "$FPID" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  kill -KILL "$BPID" "$FPID" 2>/dev/null || true
  wait "$BPID" 2>/dev/null || true
  wait "$FPID" 2>/dev/null || true
}
trap 'shutdown; exit 0' TERM INT

# --- Supervise: if either child dies, tear down so launchd restarts us -------
while kill -0 "$BPID" 2>/dev/null && kill -0 "$FPID" 2>/dev/null; do
  sleep 5
done
echo "a child process exited; tearing down so launchd can restart the service"
shutdown
exit 1
