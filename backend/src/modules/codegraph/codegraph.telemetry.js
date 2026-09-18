/**
 * Disable CodeGraph telemetry and filesystem auto-watch before library use.
 * Values must never differ by environment — set in-process only (not .env).
 */

/** Process-env keys that turn CodeGraph telemetry off. */
export const CODEGRAPH_TELEMETRY_ENV_KEYS = Object.freeze(['CODEGRAPH_TELEMETRY', 'DO_NOT_TRACK']);

let telemetryConfigured = false;

/**
 * Sets CODEGRAPH_TELEMETRY=0 and DO_NOT_TRACK=1 on process.env (idempotent).
 * Call before the first dynamic import of `@colbymchenry/codegraph`.
 * Mutates process.env deliberately — CodeGraph only honors these keys when set
 * before load; this is not application config loading (see env-config.mdc).
 * @returns {void}
 */
export function configureCodegraphTelemetryOff() {
  /* eslint-disable no-restricted-properties -- CodeGraph reads these env keys at import time */
  process.env.CODEGRAPH_TELEMETRY = '0';
  process.env.DO_NOT_TRACK = '1';
  /* eslint-enable no-restricted-properties */
  telemetryConfigured = true;
}

/**
 * Returns whether configureCodegraphTelemetryOff has run in this process.
 * @returns {boolean}
 */
export function isCodegraphTelemetryConfigured() {
  return telemetryConfigured;
}

/**
 * Test helper — clears the configured flag (does not restore prior env values).
 * @returns {void}
 */
export function resetCodegraphTelemetryConfiguredFlag() {
  telemetryConfigured = false;
}
