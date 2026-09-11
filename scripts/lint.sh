#!/usr/bin/env bash
# Run eslint and tsc --noEmit in backend and frontend.
# Runs all checks even if one fails; exits non-zero if any failed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FAILED=0

for app in ${APPS}; do
  logInfo "Linting ${app}..."
  set +e
  runInApp "${app}" lint
  LINT_STATUS=$?
  set -e
  if [ "${LINT_STATUS}" -ne 0 ]; then
    logError "${app} lint failed (exit ${LINT_STATUS})."
    FAILED=1
  else
    logInfo "${app} lint passed."
  fi

  logInfo "Typechecking ${app}..."
  set +e
  runInApp "${app}" typecheck
  TYPE_STATUS=$?
  set -e
  if [ "${TYPE_STATUS}" -ne 0 ]; then
    logError "${app} typecheck failed (exit ${TYPE_STATUS})."
    FAILED=1
  else
    logInfo "${app} typecheck passed."
  fi
done

if [ "${FAILED}" -ne 0 ]; then
  logError "One or more lint/typecheck steps failed."
  exit 1
fi

logInfo "All lint and typecheck steps passed."
