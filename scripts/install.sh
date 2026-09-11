#!/usr/bin/env bash
# Install dependencies in backend and frontend.
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

for app in ${APPS}; do
  installApp "${app}"
done

logInfo "All installs complete."
