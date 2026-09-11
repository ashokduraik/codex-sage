import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Standard API error response body returned for every HTTP error.
 * Provides a predictable shape that clients can safely deserialise.
 */
export interface ApiErrorBody {
  error: {
    /** Machine-readable error code (e.g. `VALIDATION_ERROR`, `NOT_FOUND`). */
    code: string;
    /** Human-readable error description. */
    message: string;
    /** Optional structured detail payload (e.g. field-level validation errors). */
    details?: unknown;
  };
}

/**
 * Domain error class for intentional API errors.
 * Throw this in route handlers instead of a plain `Error` when the failure
 * should map to a specific HTTP status code and machine-readable code.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  /**
   * @param statusCode - HTTP status code to include in the response.
   * @param code - Machine-readable error code (e.g. `VALIDATION_ERROR`).
   * @param message - Human-readable error description.
   * @param details - Optional extra context (e.g. field-level validation details).
   */
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * True when the reply can no longer send a JSON error body (headers already sent
 * or the raw stream was hijacked for SSE).
 *
 * @param reply - Fastify reply under consideration.
 * @returns Whether a JSON error body can still be written.
 */
export function canSendJsonError(reply: FastifyReply): boolean {
  return !reply.sent && !reply.raw.headersSent && !reply.raw.writableEnded;
}

/**
 * Registers a global error handler and a 404 handler on the Fastify instance.
 * Every thrown route error is logged with request context and mapped to
 * {@link ApiErrorBody}.
 * @param app - The Fastify application instance to register handlers on.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    } satisfies ApiErrorBody);
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;
    const isApiError = error instanceof ApiError;
    const code = isApiError
      ? error.code
      : statusCode >= 500
        ? 'INTERNAL_ERROR'
        : 'REQUEST_ERROR';
    const details = isApiError ? error.details : undefined;
    const clientMessage =
      isApiError || statusCode < 500 ? error.message : 'Internal server error';

    const logPayload = {
      err: error,
      reqId: request.id,
      method: request.method,
      url: request.url,
    };

    if (statusCode >= 500) {
      request.log.error(logPayload, 'unhandled server error');
    } else {
      request.log.warn(logPayload, 'request error');
    }

    if (!canSendJsonError(reply)) {
      request.log.warn(
        { reqId: request.id },
        'error after headers sent — skipping JSON error body',
      );
      return;
    }

    return reply.status(statusCode).send({
      error: { code, message: clientMessage, details },
    } satisfies ApiErrorBody);
  });
}
