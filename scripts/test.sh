#!/usr/bin/env bash
# Run Vitest (with coverage) in backend and frontend.
# Runs both even if the first fails; exits non-zero if any failed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FAILED=0

for app in ${APPS}; do
  logInfo "Testing ${app}..."
  set +e
  runInApp "${app}" test
  STATUS=$?
  set -e
  if [ "${STATUS}" -ne 0 ]; then
    logError "${app} tests failed (exit ${STATUS})."
    FAILED=1
  else
    logInfo "${app} tests passed."
  fi
done

if [ "${FAILED}" -ne 0 ]; then
  logError "One or more test suites failed."
  exit 1
fi

logInfo "All tests passed."
