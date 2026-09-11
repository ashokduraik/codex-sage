#!/usr/bin/env bash
# Run production builds: backend (node dist/index.js) and frontend (vite preview).
# Requires a prior npm run build. Prefixed logs; Ctrl-C / TERM cleanly stops both.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

requireDist() {
  local app="$1"
  local dist_dir="${REPO_ROOT}/${app}/dist"
  if [ ! -d "${dist_dir}" ]; then
    logError "${app}/dist is missing. Run: npm run build"
    exit 1
  fi
}

requireDist "backend"
requireDist "frontend"

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

logInfo "Starting production servers (backend npm start, frontend vite preview)..."

(
  cd "${REPO_ROOT}/backend"
  npm start 2>&1 | prefixStream "backend"
) &
BACKEND_PID=$!

(
  cd "${REPO_ROOT}/frontend"
  npm run preview 2>&1 | prefixStream "frontend"
) &
FRONTEND_PID=$!

BACKEND_STATUS=0
FRONTEND_STATUS=0

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
