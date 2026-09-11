/**
 * Domain error class and global Fastify error / not-found handlers.
 * Every client-facing JSON error is catalog-driven and carries a correlation reference.
 */
import {
  allowsErrorDetails,
  ERROR_CATALOG,
  getCatalogEntry,
  isKnownErrorCode,
} from './errorCatalog.js';
import {
  isIdempotencyReplayError,
  releaseIdempotencyClaimOnError,
} from './idempotency/idempotencyErrorHooks.js';

/**
 * Intentional API error. Prefer {@link ApiError.fromCode} so status/class stay catalog-aligned.
 */
export class ApiError extends Error {
  /**
   * @param {number} statusCode HTTP status (should match the catalog entry).
   * @param {string} code Machine-readable catalog code.
   * @param {string} message Human-readable description.
   * @param {unknown} [details] Optional non-sensitive structured details.
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /**
   * Builds an ApiError from a catalog code (status and default message from the catalog).
   * @param {string} code Catalog error code.
   * @param {{ message?: string, details?: unknown }} [options] Optional overrides.
   * @returns {ApiError}
   * @throws {Error} When `code` is not in the catalog (programming defect).
   */
  static fromCode(code, options = {}) {
    const entry = getCatalogEntry(code);
    if (!entry) {
      throw new Error(`Unknown error code: ${code}`);
    }
    return new ApiError(
      entry.httpStatus,
      code,
      options.message ?? entry.message,
      options.details,
    );
  }
}

/**
 * True when the reply can no longer send a JSON error body (headers already sent
 * or the raw stream was hijacked for SSE).
 *
 * @param {{ sent?: boolean, raw?: { headersSent?: boolean, writableEnded?: boolean } }} reply
 * @returns {boolean}
 */
export function canSendJsonError(reply) {
  return !reply.sent && !reply.raw?.headersSent && !reply.raw?.writableEnded;
}

/**
 * Resolves a thrown value to a catalog code and whether the code was unknown.
 * @param {unknown} error Thrown value.
 * @returns {{ code: string, unknownCode: boolean }}
 */
function resolveErrorCode(error) {
  if (error instanceof ApiError) {
    if (isKnownErrorCode(error.code)) {
      return { code: error.code, unknownCode: false };
    }
    return { code: 'INTERNAL_ERROR', unknownCode: true };
  }

  const statusFromError =
    typeof error === 'object' &&
    error !== null &&
    typeof /** @type {{ statusCode?: unknown }} */ (error).statusCode === 'number'
      ? /** @type {{ statusCode: number }} */ (error).statusCode
      : undefined;

  if (statusFromError === 404) {
    return { code: 'NOT_FOUND', unknownCode: false };
  }
  if (statusFromError !== undefined && statusFromError >= 400 && statusFromError < 500) {
    return { code: 'VALIDATION_ERROR', unknownCode: false };
  }
  return { code: 'INTERNAL_ERROR', unknownCode: false };
}

/**
 * Maps a thrown value to a catalog-backed client error body.
 *
 * @param {unknown} error Thrown value.
 * @param {string} reference Correlation id for this request.
 * @returns {{ statusCode: number, body: { error: object }, unknownCode: boolean, isServerError: boolean }}
 */
export function buildErrorEnvelope(error, reference) {
  const { code, unknownCode } = resolveErrorCode(error);
  const entry = getCatalogEntry(code) ?? ERROR_CATALOG.INTERNAL_ERROR;
  const isApiError = error instanceof ApiError;

  // Unexpected failures and unknown codes always use the stable INTERNAL_ERROR body.
  const forceInternal = unknownCode || (!isApiError && code === 'INTERNAL_ERROR');
  const resolvedCode = forceInternal ? 'INTERNAL_ERROR' : code;
  const resolvedEntry = forceInternal ? ERROR_CATALOG.INTERNAL_ERROR : entry;
  const statusCode = forceInternal
    ? 500
    : isApiError
      ? error.statusCode
      : resolvedEntry.httpStatus;

  let message = resolvedEntry.message;
  if (isApiError && !forceInternal && statusCode < 500) {
    message = error.message;
  } else if (isApiError && !forceInternal && resolvedCode !== 'INTERNAL_ERROR') {
    // Known catalog 5xx (e.g. KNOWLEDGE_UNAVAILABLE) keep their catalog/API message.
    message = error.message || resolvedEntry.message;
  } else if (forceInternal || resolvedCode === 'INTERNAL_ERROR') {
    message = ERROR_CATALOG.INTERNAL_ERROR.message;
  }

  /** @type {{ code: string, class: string, retryability: string, message: string, reference: string, details?: unknown }} */
  const errorBody = {
    code: resolvedCode,
    class: resolvedEntry.class,
    retryability: resolvedEntry.retryability,
    message,
    reference,
  };

  if (allowsErrorDetails(resolvedCode) && isApiError && error.details !== undefined) {
    errorBody.details = error.details;
  }

  return {
    statusCode,
    body: { error: errorBody },
    unknownCode,
    isServerError: statusCode >= 500,
  };
}

/**
 * Registers a global error handler and a 404 handler on the Fastify instance.
 * @param {import('fastify').FastifyInstance} app Fastify application instance.
 * @param {{
 *   trySpaFallback?: (
 *     request: import('fastify').FastifyRequest,
 *     reply: import('fastify').FastifyReply,
 *   ) => unknown,
 * }} [options] Optional SPA fallback; return a reply to short-circuit the JSON 404.
 */
export function registerErrorHandler(app, options = {}) {
  app.setNotFoundHandler(
    {
      // Not-found runs through preHandlers; keep it public so RBAC does not turn 404 into 403.
      config: { routeAccess: 'public' },
    },
    (request, reply) => {
      if (typeof options.trySpaFallback === 'function') {
        const spaResult = options.trySpaFallback(request, reply);
        if (spaResult !== undefined) {
          return spaResult;
        }
      }
      const entry = ERROR_CATALOG.NOT_FOUND;
      return reply.status(entry.httpStatus).send({
        error: {
          code: 'NOT_FOUND',
          class: entry.class,
          retryability: entry.retryability,
          message: entry.message,
          reference: request.id,
        },
      });
    },
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (isIdempotencyReplayError(error)) {
      if (!canSendJsonError(reply)) {
        request.log.error(
          { reqId: request.id },
          'idempotency replay after headers sent — skipping body',
        );
        return;
      }
      const replay = /** @type {{ responseStatus: number, responseBody: unknown }} */ (error);
      return reply.status(replay.responseStatus).send(replay.responseBody);
    }

    try {
      await releaseIdempotencyClaimOnError(request);
    } catch (releaseErr) {
      request.log.warn({ err: releaseErr }, 'failed to release idempotency claim');
    }

    const reference = request.id;
    const mapped = buildErrorEnvelope(error, reference);

    if (mapped.unknownCode) {
      request.log.error(
        {
          err: error,
          reqId: reference,
          defectCode: error instanceof ApiError ? error.code : undefined,
        },
        'error code missing from catalog — serving INTERNAL_ERROR',
      );
    }

    const logPayload = {
      err: error,
      reqId: reference,
      method: request.method,
      url: request.url,
    };

    if (mapped.isServerError) {
      request.log.error(logPayload, 'unhandled server error');
    } else {
      request.log.warn(logPayload, 'request error');
    }

    if (!canSendJsonError(reply)) {
      request.log.error(
        { reqId: reference },
        'error after headers sent — skipping JSON error body',
      );
      return;
    }

    return reply.status(mapped.statusCode).send(mapped.body);
  });
}
