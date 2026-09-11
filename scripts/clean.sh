#!/usr/bin/env bash
# Remove node_modules, dist, and coverage in backend and frontend.
# Prompts for confirmation unless --yes is passed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

ASSUME_YES=0
for arg in "$@"; do
  case "${arg}" in
    --yes|-y)
      ASSUME_YES=1
      ;;
    *)
      logError "Unknown argument: ${arg}"
      logInfo "Usage: $(basename "$0") [--yes]"
      exit 1
      ;;
  esac
done

if [ "${ASSUME_YES}" -ne 1 ]; then
  printf 'This will delete node_modules, dist, and coverage in backend and frontend.\n'
  printf 'Continue? [y/N] '
  read -r answer
  case "${answer}" in
    y|Y|yes|YES)
      ;;
    *)
      logInfo "Aborted."
      exit 0
      ;;
  esac
fi

for app in ${APPS}; do
  app_dir="${REPO_ROOT}/${app}"
  logInfo "Cleaning ${app}..."
  rm -rf "${app_dir}/node_modules" "${app_dir}/dist" "${app_dir}/coverage"
  logInfo "${app} cleaned."
done

logInfo "Clean complete."
