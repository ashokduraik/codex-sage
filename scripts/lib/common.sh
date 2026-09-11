#!/usr/bin/env bash
# Shared helpers for root scripts. Source this file; do not execute it.
# Compatible with Bash 3.2 (macOS default).

# Resolve the repository root from this file's location (scripts/lib/common.sh).
# Use a private name so sourcing does not overwrite the caller's SCRIPT_DIR.
_COMMON_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${_COMMON_LIB_DIR}/../.." && pwd)"

# Apps operated on by every root script (order matters for sequential runs).
APPS="backend frontend"

# Minimum Node major version enforced by setup.sh.
REQUIRED_NODE_MAJOR=26

logInfo() {
  printf '%s\n' "$*"
}

logError() {
  printf 'ERROR: %s\n' "$*" >&2
}

logWarn() {
  printf 'WARN: %s\n' "$*" >&2
}

# Run an npm script inside one app directory.
# Usage: runInApp <app> <npm-script> [extra npm args...]
runInApp() {
  local app="$1"
  local npm_script="$2"
  shift 2
  (
    cd "${REPO_ROOT}/${app}"
    npm run "${npm_script}" -- "$@"
  )
}

# Prefix each line of stdin with [label].
prefixStream() {
  local label="$1"
  while IFS= read -r line || [ -n "${line}" ]; do
    printf '[%s] %s\n' "${label}" "${line}"
  done
}

# Recursively terminate a process and its descendants (npm → node → vite/tsx).
killTree() {
  local pid="$1"
  local child
  if [ -z "${pid}" ]; then
    return 0
  fi
  for child in $(pgrep -P "${pid}" 2>/dev/null || true); do
    killTree "${child}"
  done
  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
  fi
}
