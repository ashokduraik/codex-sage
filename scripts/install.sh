#!/usr/bin/env bash
# Install root tooling (when not already in the npm install lifecycle), then
# backend and frontend.
# Uses npm ci when package-lock.json exists; falls back to npm install otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

installApp() {
  local app="$1"
  local app_dir="${REPO_ROOT}/${app}"

  if [ ! -d "${app_dir}" ]; then
    logError "App directory not found: ${app_dir}"
    exit 1
  fi

  logInfo "Installing ${app}..."
  (
    cd "${app_dir}"
    if [ -f package-lock.json ]; then
      npm ci
    else
      logWarn "${app}/package-lock.json is missing; falling back to npm install."
      npm install
    fi
  )
  logInfo "${app} install complete."
}

# Skip when this script is already the npm "install" lifecycle at repo root
# (root deps were just installed; re-entering npm install would recurse).
installRoot() {
  if [ "${npm_lifecycle_event:-}" = "install" ]; then
    return 0
  fi

  logInfo "Installing root..."
  (
    cd "${REPO_ROOT}"
    if [ -f package-lock.json ]; then
      npm ci --ignore-scripts
    else
      logWarn "package-lock.json is missing; falling back to npm install."
      npm install --ignore-scripts
    fi
    npx husky
  )
  logInfo "Root install complete."
}

installRoot

for app in ${APPS}; do
  installApp "${app}"
done

logInfo "All installs complete."
