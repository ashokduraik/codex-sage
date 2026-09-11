#!/usr/bin/env bash
# One-time bootstrap: verify Node >= 26, copy missing .env files, then install deps.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

requireNodeVersion() {
  if ! command -v node >/dev/null 2>&1; then
    logError "node is not installed. Install Node.js >= ${REQUIRED_NODE_MAJOR} and retry."
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    logError "npm is not installed. Install npm (bundled with Node.js) and retry."
    exit 1
  fi

  local node_version
  node_version="$(node -v)"
  # Strip leading "v" and take major component (e.g. v26.5.0 -> 26).
  local major
  major="${node_version#v}"
  major="${major%%.*}"

  if [ "${major}" -lt "${REQUIRED_NODE_MAJOR}" ]; then
    logError "Node ${node_version} detected; this project requires Node >= ${REQUIRED_NODE_MAJOR}."
    exit 1
  fi

  logInfo "Node ${node_version} (ok, >= ${REQUIRED_NODE_MAJOR})"
  logInfo "npm $(npm -v)"
}

bootstrapEnvFiles() {
  local app
  for app in ${APPS}; do
    local example="${REPO_ROOT}/${app}/.env.example"
    local env_file="${REPO_ROOT}/${app}/.env"
    if [ ! -f "${example}" ]; then
      logWarn "${app}/.env.example is missing; skipping env bootstrap for ${app}."
      continue
    fi
    if [ -f "${env_file}" ]; then
      logInfo "${app}/.env already exists; leaving it unchanged."
    else
      cp "${example}" "${env_file}"
      logInfo "Created ${app}/.env from .env.example"
    fi
  done
}

requireNodeVersion
bootstrapEnvFiles
logInfo "Installing dependencies..."
bash "${SCRIPT_DIR}/install.sh"
logInfo "Setup complete. Run: npm run dev"
