/**
 * Job-event message shape checks used by tests only.
 */

/**
 * @param {string} message Candidate message.
 * @returns {boolean}
 */
export function messageContainsObjectIdShape(message) {
  return /\b[a-f0-9]{24}\b/i.test(message);
}

/**
 * @param {string} message Candidate message.
 * @returns {boolean}
 */
export function messageContainsAbsolutePath(message) {
  return /(^|\s)(\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(message);
}

/**
 * @param {string} message Candidate message.
 * @returns {boolean}
 */
export function messageContainsRawErrorFragment(message) {
  return /\bError:\s/i.test(message) || /\bat\s+\S+\s+\(/.test(message);
}
