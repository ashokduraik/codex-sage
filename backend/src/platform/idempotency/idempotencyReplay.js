/**
 * Typed signal that the route should replay a stored successful response.
 * Handled by the idempotency error-handler wrapper — not an ApiError envelope.
 */
export class IdempotencyReplay extends Error {
  /**
   * @param {number} responseStatus Stored HTTP status.
   * @param {unknown} responseBody Stored JSON body to send.
   */
  constructor(responseStatus, responseBody) {
    super('Idempotency replay');
    this.name = 'IdempotencyReplay';
    this.responseStatus = responseStatus;
    this.responseBody = responseBody;
  }
}
