/**
 * In-memory access-token holder. Kept outside React so reads do not need a render.
 */

/** @type {string | null} */
let accessToken = null;

/** @type {Set<() => void>} */
const sessionClearedSubscribers = new Set();

/**
 * Stores the current Bearer access token.
 * @param {string | null} token Access token, or null to clear without notifying.
 */
export function setAccessToken(token) {
  accessToken = token;
}

/**
 * Returns the current access token, or null when none is set.
 * @returns {string | null}
 */
export function getAccessToken() {
  return accessToken;
}

/**
 * Clears the access token and notifies session-cleared subscribers once.
 */
export function clearSession() {
  accessToken = null;
  for (const listener of sessionClearedSubscribers) {
    listener();
  }
}

/**
 * Subscribes to session-loss notifications (Phase 14 AuthContext).
 * @param {() => void} listener Called when `clearSession` runs.
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeSessionCleared(listener) {
  sessionClearedSubscribers.add(listener);
  return () => {
    sessionClearedSubscribers.delete(listener);
  };
}

/**
 * Test helper: resets token and subscribers without notifying.
 */
export function resetApiSessionForTests() {
  accessToken = null;
  sessionClearedSubscribers.clear();
}
