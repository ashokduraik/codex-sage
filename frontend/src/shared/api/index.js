/**
 * Public surface for the frontend API client. Features import from here only.
 */
export { API_BASE_URL, resolveApiBaseUrl } from './apiConfig.js';
export {
  ApiError,
  CORRELATION_ID_HEADER,
  RequestAbortedError,
  apiErrorFromNetworkFailure,
  apiErrorFromResponse,
  isRequestAbortedError,
  parseRetryAfterSeconds,
  resolveRetryAfterSeconds,
} from './ApiError.js';
export {
  clearSession,
  getAccessToken,
  setAccessToken,
  subscribeSessionCleared,
} from './apiSession.js';
export { apiRequest } from './apiRequest.js';
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  readCsrfTokenFromCookie,
  refreshAccessToken,
} from './refreshClient.js';
export { ERROR_CODE_MESSAGES, getErrorMessageEntry } from './errorMessages.js';
