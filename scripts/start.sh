#!/usr/bin/env bash
# Production-like run: one Fastify process serves /api/v1 and the built SPA.
# Requires a prior frontend build (`npm run build` from the repo root or frontend/).
# Prefixed logs; Ctrl-C / TERM cleanly stops the API.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FRONTEND_DIST="${REPO_ROOT}/frontend/dist"
FRONTEND_INDEX="${FRONTEND_DIST}/index.html"
if [ ! -f "${FRONTEND_INDEX}" ]; then
  logError "frontend/dist/index.html is missing. Run: npm run build"
  exit 1
fi

BACKEND_PID=""
SHUTTING_DOWN=0

cleanup() {
  if [ "${SHUTTING_DOWN}" -eq 1 ]; then
    return 0
  fi
  SHUTTING_DOWN=1
  trap - INT TERM EXIT
  killTree "${BACKEND_PID}"
  wait "${BACKEND_PID}" 2>/dev/null || true
}

onSignal() {
  logInfo "Shutting down..."
  cleanup
  exit 130
}

trap onSignal INT TERM
trap cleanup EXIT

logInfo "Starting production API (serves /api/v1 and frontend/dist)..."

(
  cd "${REPO_ROOT}/backend"
  npm start 2>&1 | prefixStream "backend"
) &
BACKEND_PID=$!

BACKEND_STATUS=0
set +e
wait "${BACKEND_PID}"
BACKEND_STATUS=$?
set -e

SHUTTING_DOWN=1
trap - INT TERM EXIT

if [ "${BACKEND_STATUS}" -ne 0 ]; then
  logError "Backend exited with an error (status=${BACKEND_STATUS})."
  exit 1
fi
