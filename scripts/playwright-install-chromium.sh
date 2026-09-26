#!/usr/bin/env bash
# Install Playwright Chromium + Chrome Headless Shell without cdn.playwright.dev.
# That host times out from some networks; Google's CFT bucket does not.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

BROWSERS_JSON="${REPO_ROOT}/node_modules/playwright-core/browsers.json"
if [ ! -f "${BROWSERS_JSON}" ]; then
  logError "playwright-core is not installed. Run npm install at the repo root."
  exit 1
fi

OS_NAME="$(uname -s)"
ARCH="$(uname -m)"
if [ "${OS_NAME}" = "Darwin" ] && [ "${ARCH}" = "arm64" ]; then
  PLATFORM="mac-arm64"
elif [ "${OS_NAME}" = "Darwin" ]; then
  PLATFORM="mac-x64"
elif [ "${OS_NAME}" = "Linux" ]; then
  PLATFORM="linux64"
else
  logError "Unsupported platform ${OS_NAME} ${ARCH}. Use: npx playwright install chromium"
  exit 1
fi

if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH}"
elif [ "${OS_NAME}" = "Darwin" ]; then
  CACHE_DIR="${HOME}/Library/Caches/ms-playwright"
else
  CACHE_DIR="${HOME}/.cache/ms-playwright"
fi

# Install one Chrome for Testing zip into the Playwright cache directory.
# Usage: installCftArtifact <browsers.json name> <cache dir prefix> <zip basename without .zip>
installCftArtifact() {
  local browser_name="$1"
  local cache_prefix="$2"
  local archive_stem="$3"
  local version
  local revision
  local target_dir
  local archive
  local download_url
  local workdir

  version="$(node -p "require('${BROWSERS_JSON}').browsers.find((browser) => browser.name === '${browser_name}').browserVersion")"
  revision="$(node -p "require('${BROWSERS_JSON}').browsers.find((browser) => browser.name === '${browser_name}').revision")"
  target_dir="${CACHE_DIR}/${cache_prefix}-${revision}"
  archive="${archive_stem}.zip"
  download_url="https://storage.googleapis.com/chrome-for-testing-public/${version}/${PLATFORM}/${archive}"

  if [ -f "${target_dir}/INSTALLATION_COMPLETE" ]; then
    logInfo "${browser_name} ${version} (r${revision}) already installed at ${target_dir}"
    return 0
  fi

  workdir="$(mktemp -d "${TMPDIR:-/tmp}/pw-${cache_prefix}.XXXXXX")"
  logInfo "Downloading ${browser_name} ${version} from ${download_url}"
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 --max-time 600 \
    --output "${workdir}/${archive}" "${download_url}"

  mkdir -p "${target_dir}"
  logInfo "Extracting to ${target_dir}"
  unzip -q -o "${workdir}/${archive}" -d "${target_dir}"
  if [ "${OS_NAME}" = "Darwin" ]; then
    xattr -cr "${target_dir}" 2>/dev/null || true
  fi
  : >"${target_dir}/INSTALLATION_COMPLETE"
  : >"${target_dir}/DEPENDENCIES_VALIDATED"
  rm -rf "${workdir}"
  logInfo "Installed ${browser_name} ${version} (r${revision})"
}

installCftArtifact chromium chromium "chrome-${PLATFORM}"
installCftArtifact chromium-headless-shell chromium_headless_shell "chrome-headless-shell-${PLATFORM}"
