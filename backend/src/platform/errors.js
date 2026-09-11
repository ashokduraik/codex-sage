/**
 * Domain error class for intentional API errors.
 * Throw this in route handlers instead of a plain `Error` when the failure
 * should map to a specific HTTP status code and machine-readable code.
 */
export class ApiError extends Error {
    statusCode;
    code;
    details;
    /**
     * @param statusCode - HTTP status code to include in the response.
     * @param code - Machine-readable error code (e.g. `VALIDATION_ERROR`).
     * @param message - Human-readable error description.
     * @param details - Optional extra context (e.g. field-level validation details).
     */
    constructor(statusCode, code, message, details) {
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
export function canSendJsonError(reply) {
    return !reply.sent && !reply.raw.headersSent && !reply.raw.writableEnded;
}
/**
 * Registers a global error handler and a 404 handler on the Fastify instance.
 * Every thrown route error is logged with request context and mapped to
 * {@link ApiErrorBody}.
 * @param app - The Fastify application instance to register handlers on.
 */
export function registerErrorHandler(app) {
    app.setNotFoundHandler((_request, reply) => {
        return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: 'Route not found' },
        });
    });
    app.setErrorHandler((error, request, reply) => {
        const statusCode = error.statusCode ?? 500;
        const isApiError = error instanceof ApiError;
        const code = isApiError
            ? error.code
            : statusCode >= 500
                ? 'INTERNAL_ERROR'
                : 'REQUEST_ERROR';
        const details = isApiError ? error.details : undefined;
        const clientMessage = isApiError || statusCode < 500 ? error.message : 'Internal server error';
        const logPayload = {
            err: error,
            reqId: request.id,
            method: request.method,
            url: request.url,
        };
        if (statusCode >= 500) {
            request.log.error(logPayload, 'unhandled server error');
        }
        else {
            request.log.warn(logPayload, 'request error');
        }
        if (!canSendJsonError(reply)) {
            request.log.warn({ reqId: request.id }, 'error after headers sent — skipping JSON error body');
            return;
        }
        return reply.status(statusCode).send({
            error: { code, message: clientMessage, details },
        });
    });
}
