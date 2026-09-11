#!/usr/bin/env bash
# Build backend (tsup) and frontend (vite build). Sequential; fail fast.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

for app in ${APPS}; do
  logInfo "Building ${app}..."
  runInApp "${app}" build
  logInfo "${app} build complete."
done

logInfo "All builds complete."
