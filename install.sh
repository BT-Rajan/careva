#!/usr/bin/env bash
#
# install.sh — build / start / stop / restart / update Careva (frontend + API) under PM2.
#
# Usage:
#   ./install.sh setup      First-time build: install deps, generate prisma client, build both apps
#   ./install.sh start      pm2 start (or resurrect) both processes
#   ./install.sh stop       pm2 stop both processes
#   ./install.sh restart    pm2 restart both processes (hard restart, brief downtime)
#   ./install.sh reload     pm2 reload API (zero-downtime; frontend is static so it just restarts)
#   ./install.sh status     pm2 status for careva-api / careva-frontend
#   ./install.sh logs       pm2 logs (tail) for both processes
#   ./install.sh update     git pull + reinstall changed deps + rebuild + restart
#   ./install.sh db:push    Manual helper — runs `prisma db push` (schema -> DB). NOT run automatically.
#
# Config (env vars, all optional):
#   FRONTEND_MODE=pm2|nginx   Default: pm2. Set to "nginx" if Nginx serves the built
#                             `build/` folder directly — install.sh will then skip
#                             starting a pm2 "serve" process for the frontend.
#   FRONTEND_PORT=3000        Port for `serve` when FRONTEND_MODE=pm2.
#
# This script never touches the database (no migrate/push) except via the explicit
# `db:push` subcommand, which you run by hand. See the printed DB setup steps below.

set -euo pipefail

# --- resolve paths -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

API_DIR="$SCRIPT_DIR/api"
FRONTEND_MODE="${FRONTEND_MODE:-pm2}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
API_APP_NAME="careva-api"
FRONTEND_APP_NAME="careva-frontend"

# --- helpers -------------------------------------------------------------
log()  { echo -e "\033[1;34m[install.sh]\033[0m $*"; }
warn() { echo -e "\033[1;33m[install.sh]\033[0m $*"; }
err()  { echo -e "\033[1;31m[install.sh]\033[0m $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "'$1' is required but not installed."; exit 1; }
}

check_env_files() {
  local missing=0
  if [ ! -f "$SCRIPT_DIR/.env" ]; then
    err "Missing $SCRIPT_DIR/.env (frontend). Copy .env.example -> .env and fill it in."
    missing=1
  fi
  if [ ! -f "$API_DIR/.env" ]; then
    err "Missing $API_DIR/.env (backend). Copy api/.env.example -> api/.env and fill it in."
    missing=1
  fi
  [ "$missing" -eq 1 ] && exit 1
  return 0
}

pm2_ecosystem_check() {
  require_cmd pm2
}

# --- subcommands -----------------------------------------------------------

cmd_setup() {
  require_cmd node
  require_cmd npm
  pm2_ecosystem_check
  check_env_files

  log "Installing API dependencies..."
  (cd "$API_DIR" && npm ci)

  log "Generating Prisma client..."
  (cd "$API_DIR" && npx prisma generate)

  log "Building API (tsc)..."
  (cd "$API_DIR" && npm run build)

  log "Installing frontend dependencies..."
  npm ci

  log "Building frontend (react-scripts build)..."
  npm run build

  if [ "$FRONTEND_MODE" = "pm2" ]; then
    if ! command -v serve >/dev/null 2>&1; then
      log "Installing 'serve' globally (used to serve the frontend build under pm2)..."
      npm install -g serve
    fi
  fi

  log "Setup complete. Run './install.sh start' to bring up both processes under pm2."
  warn "Reminder: the database schema is NOT touched by this script. See DB setup steps (run './install.sh' with no args, or scroll up) before first start."
}

cmd_start() {
  pm2_ecosystem_check
  check_env_files

  if ! pm2 describe "$API_APP_NAME" >/dev/null 2>&1; then
    log "Starting $API_APP_NAME under pm2..."
    (cd "$API_DIR" && pm2 start dist/server.js --name "$API_APP_NAME")
  else
    log "$API_APP_NAME already registered in pm2 — starting it..."
    pm2 start "$API_APP_NAME"
  fi

  if [ "$FRONTEND_MODE" = "pm2" ]; then
    if ! pm2 describe "$FRONTEND_APP_NAME" >/dev/null 2>&1; then
      log "Starting $FRONTEND_APP_NAME under pm2 (serve -s build -l $FRONTEND_PORT)..."
      pm2 start "serve -s build -l $FRONTEND_PORT" --name "$FRONTEND_APP_NAME"
    else
      log "$FRONTEND_APP_NAME already registered in pm2 — starting it..."
      pm2 start "$FRONTEND_APP_NAME"
    fi
  else
    log "FRONTEND_MODE=nginx — skipping pm2 frontend process (Nginx is expected to serve build/)."
  fi

  pm2 save
  log "Started. 'pm2 startup' once (if not already done) to enable auto-start on reboot."
}

cmd_stop() {
  pm2_ecosystem_check
  pm2 stop "$API_APP_NAME" 2>/dev/null || warn "$API_APP_NAME not running."
  if [ "$FRONTEND_MODE" = "pm2" ]; then
    pm2 stop "$FRONTEND_APP_NAME" 2>/dev/null || warn "$FRONTEND_APP_NAME not running."
  fi
}

cmd_restart() {
  pm2_ecosystem_check
  pm2 restart "$API_APP_NAME"
  if [ "$FRONTEND_MODE" = "pm2" ]; then
    pm2 restart "$FRONTEND_APP_NAME"
  fi
}

cmd_reload() {
  pm2_ecosystem_check
  log "Zero-downtime reload of $API_APP_NAME..."
  pm2 reload "$API_APP_NAME"
  if [ "$FRONTEND_MODE" = "pm2" ]; then
    log "Frontend is static — 'reload' behaves like 'restart' for $FRONTEND_APP_NAME."
    pm2 restart "$FRONTEND_APP_NAME"
  fi
}

cmd_status() {
  pm2_ecosystem_check
  pm2 status
}

cmd_logs() {
  pm2_ecosystem_check
  if [ "$FRONTEND_MODE" = "pm2" ]; then
    pm2 logs "$API_APP_NAME" "$FRONTEND_APP_NAME"
  else
    pm2 logs "$API_APP_NAME"
  fi
}

cmd_update() {
  require_cmd git
  pm2_ecosystem_check
  check_env_files

  log "Pulling latest code..."
  git pull

  log "Reinstalling API dependencies (if changed)..."
  (cd "$API_DIR" && npm ci)

  log "Regenerating Prisma client..."
  (cd "$API_DIR" && npx prisma generate)

  log "Rebuilding API..."
  (cd "$API_DIR" && npm run build)

  log "Reinstalling frontend dependencies (if changed)..."
  npm ci

  log "Rebuilding frontend..."
  npm run build

  cmd_restart
  log "Update complete."
  warn "If the Prisma schema changed in this update, run './install.sh db:push' manually (review the diff first!)."
}

cmd_db_push() {
  require_cmd node
  check_env_files
  warn "This will push the current Prisma schema to the database configured in api/.env (DATABASE_URL)."
  warn "This is a manual, deliberate action — not run automatically by any other command."
  read -r -p "Continue? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    (cd "$API_DIR" && npx prisma db push)
  else
    log "Cancelled."
  fi
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

# --- dispatch ----------------------------------------------------------------
case "${1:-}" in
  setup)    cmd_setup ;;
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  reload)   cmd_reload ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  update)   cmd_update ;;
  db:push)  cmd_db_push ;;
  *)        usage; exit 1 ;;
esac
