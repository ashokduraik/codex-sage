#!/usr/bin/env bash
# Run backend (tsx watch, port 3000) and frontend (Vite) together for local development.
# Prefixed logs; Ctrl-C / TERM cleanly stops both processes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

BACKEND_PID=""
FRONTEND_PID=""
SHUTTING_DOWN=0

cleanup() {
  if [ "${SHUTTING_DOWN}" -eq 1 ]; then
    return 0
  fi
  SHUTTING_DOWN=1
  trap - INT TERM EXIT
  killTree "${BACKEND_PID}"
  killTree "${FRONTEND_PID}"
  wait "${BACKEND_PID}" 2>/dev/null || true
  wait "${FRONTEND_PID}" 2>/dev/null || true
}

onSignal() {
  logInfo "Shutting down..."
  cleanup
  exit 130
}

trap onSignal INT TERM
trap cleanup EXIT

logInfo "Starting backend (API on :3000) and frontend (Vite; /api proxied to :3000)..."

(
  cd "${REPO_ROOT}/backend"
  npm run dev 2>&1 | prefixStream "backend"
) &
BACKEND_PID=$!

(
  cd "${REPO_ROOT}/frontend"
  npm run dev 2>&1 | prefixStream "frontend"
) &
FRONTEND_PID=$!

BACKEND_STATUS=0
FRONTEND_STATUS=0

# Poll until either child exits, then stop the other.
while true; do
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    set +e
    wait "${BACKEND_PID}"
    BACKEND_STATUS=$?
    set -e
    killTree "${FRONTEND_PID}"
    set +e
    wait "${FRONTEND_PID}"
    FRONTEND_STATUS=$?
    set -e
    break
  fi
  if ! kill -0 "${FRONTEND_PID}" 2>/dev/null; then
    set +e
    wait "${FRONTEND_PID}"
    FRONTEND_STATUS=$?
    set -e
    killTree "${BACKEND_PID}"
    set +e
    wait "${BACKEND_PID}"
    BACKEND_STATUS=$?
    set -e
    break
  fi
  sleep 1
done

SHUTTING_DOWN=1
trap - INT TERM EXIT

if [ "${BACKEND_STATUS}" -ne 0 ] || [ "${FRONTEND_STATUS}" -ne 0 ]; then
  logError "A process exited with an error (backend=${BACKEND_STATUS}, frontend=${FRONTEND_STATUS})."
  exit 1
fi
