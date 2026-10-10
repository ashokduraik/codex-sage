/**
 * Fastify hooks for Mongo-backed Idempotency-Key on opted-in routes.
 * Helpers never call reply.send for success; IdempotencyReplay is handled by the wrapper.
 */
import { createHash } from 'node:crypto';
import { ApiError, setIdempotencyErrorHooks } from '../errors.js';
import {
  beginIdempotencyClaim,
  buildIdempotencyRouteLabel,
  completeIdempotencyRecord,
  findActiveIdempotencyRecord,
  IDEMPOTENCY_POLL_INTERVAL_MS,
  IDEMPOTENCY_WAIT_MS,
  releaseIdempotencyClaim,
} from './idempotency.repository.js';

/** Minimum accepted Idempotency-Key length. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

/** Maximum accepted Idempotency-Key length. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Allowed characters for Idempotency-Key values. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Max UTF-8 byte size of a stored replay body. */
export const IDEMPOTENCY_BODY_MAX_BYTES = 65_536;

/** HTTP header name (Fastify lowercases incoming headers). */
export const IDEMPOTENCY_HEADER_NAME = 'idempotency-key';

/**
 * Reads and validates the Idempotency-Key header.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @returns {string} Validated key.
 * @throws {ApiError} IDEMPOTENCY_KEY_REQUIRED or VALIDATION_ERROR.
 */
export function readIdempotencyKey(request) {
  const raw = request.headers[IDEMPOTENCY_HEADER_NAME];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw ApiError.fromCode('IDEMPOTENCY_KEY_REQUIRED');
  }
  const key = raw.trim();
  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'Idempotency-Key',
          message: `must be ${IDEMPOTENCY_KEY_MIN_LENGTH}–${IDEMPOTENCY_KEY_MAX_LENGTH} chars [A-Za-z0-9._-]`,
        },
      ],
    });
  }
  return key;
}

/**
 * Stable SHA-256 hash of the request body used to detect key reuse with a different payload.
 * @param {unknown} body Parsed JSON body (or undefined).
 * @returns {string} Hex digest.
 */
export function hashIdempotencyRequestBody(body) {
  const canonical = JSON.stringify(body ?? null);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Returns UTF-8 byte length of a JSON-serialized value.
 * @param {unknown} value Value to measure.
 * @returns {number}
 */
export function measureJsonBodyBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

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

/**
 * Soft-deletes the request's processing claim when this request owned it.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @returns {Promise<void>}
 */
export async function releaseOwnedIdempotencyClaim(request) {
  const ctx = request.idempotency;
  if (!ctx?.isOwner || !request.principal?.orgId) {
    return;
  }
  await releaseIdempotencyClaim({
    orgId: request.principal.orgId,
    recordId: ctx.recordId,
    updatedBy: request.principal.userId,
  });
  ctx.isOwner = false;
}

/**
 * @typedef {object} IdempotencyRequestContext
 * @property {boolean} isOwner
 * @property {string} recordId
 * @property {string} key
 * @property {string} requestHash
 * @property {string} route
 */

/**
 * preHandler: claim or replay for routes with `requireIdempotencyKey: true`.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @returns {Promise<void>}
 */
export async function idempotencyPreHandler(request) {
  const config = request.routeOptions?.config;
  if (!config || config.requireIdempotencyKey !== true) {
    return;
  }

  const principal = request.principal;
  if (!principal?.orgId || !principal?.userId) {
    throw ApiError.fromCode('UNAUTHENTICATED');
  }

  const key = readIdempotencyKey(request);
  const requestHash = hashIdempotencyRequestBody(request.body);
  const pathTemplate = request.routeOptions?.url ?? request.url;
  const route = buildIdempotencyRouteLabel(request.method, pathTemplate);

  const claim = await beginIdempotencyClaim({
    orgId: principal.orgId,
    userId: principal.userId,
    route,
    key,
    requestHash,
    createdBy: principal.userId,
  });

  if (claim.owned) {
    /** @type {IdempotencyRequestContext} */
    request.idempotency = {
      isOwner: true,
      recordId: String(claim.record._id),
      key,
      requestHash,
      route,
    };
    return;
  }

  const existing = claim.record;
  if (existing.requestHash !== requestHash) {
    throw ApiError.fromCode('IDEMPOTENCY_KEY_REUSE');
  }
  if (existing.recordState === 'completed') {
    throw new IdempotencyReplay(existing.responseStatus, existing.responseBody);
  }

  await waitForIdempotencyTwin({
    orgId: principal.orgId,
    userId: principal.userId,
    route,
    key,
    requestHash,
  });

  /**
   * Waits for a processing twin to complete, then returns a replay or throws in-flight.
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   route: string,
   *   key: string,
   *   requestHash: string,
   * }} query Wait scope.
   * @returns {Promise<never>}
   * @throws {IdempotencyReplay|ApiError}
   */
  async function waitForIdempotencyTwin(query) {
    const deadline = Date.now() + IDEMPOTENCY_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, IDEMPOTENCY_POLL_INTERVAL_MS);
      });
      const record = await findActiveIdempotencyRecord(query);
      if (!record) {
        break;
      }
      if (record.requestHash !== query.requestHash) {
        throw ApiError.fromCode('IDEMPOTENCY_KEY_REUSE');
      }
      if (record.recordState === 'completed') {
        throw new IdempotencyReplay(record.responseStatus, record.responseBody);
      }
    }
    throw ApiError.fromCode('IDEMPOTENCY_IN_FLIGHT');
  }
}

/**
 * onSend: persist the successful response for the claim owner.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @param {import('fastify').FastifyReply} reply Reply (status only; not passed to helpers).
 * @param {unknown} payload Response payload.
 * @returns {Promise<unknown>}
 */
export async function idempotencyOnSend(request, reply, payload) {
  const ctx = request.idempotency;
  if (!ctx?.isOwner) {
    return payload;
  }

  const statusCode = reply.statusCode;
  if (statusCode < 200 || statusCode >= 300) {
    return payload;
  }

  const body = parseOnSendPayload(payload);
  if (measureJsonBodyBytes(body) > IDEMPOTENCY_BODY_MAX_BYTES) {
    await releaseIdempotencyClaim({
      orgId: request.principal.orgId,
      recordId: ctx.recordId,
      updatedBy: request.principal.userId,
    });
    throw ApiError.fromCode('INTERNAL_ERROR', {
      message: 'Idempotency response body exceeds storage cap.',
    });
  }

  const resourceId = body && typeof body === 'object' && typeof body.id === 'string' && body.id.length > 0 ? body.id : null;
  await completeIdempotencyRecord({
    orgId: request.principal.orgId,
    recordId: ctx.recordId,
    responseStatus: statusCode,
    responseBody: body,
    resourceId,
    updatedBy: request.principal.userId,
  });
  ctx.isOwner = false;
  return payload;

  /**
   * Parses an onSend payload into a JSON value when possible.
   * @param {unknown} payload Fastify onSend payload.
   * @returns {unknown}
   */
  function parseOnSendPayload(payload) {
    if (payload === undefined || payload === null || payload === '') {
      return null;
    }
    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload);
      } catch {
        return payload;
      }
    }
    if (Buffer.isBuffer(payload)) {
      try {
        return JSON.parse(payload.toString('utf8'));
      } catch {
        return payload.toString('utf8');
      }
    }
    return payload;
  }
}

/**
 * Registers idempotency preHandler and onSend hooks, and wires error-handler hooks.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export function registerIdempotency(app) {
  setIdempotencyErrorHooks({
    isReplayError: (error) => error instanceof IdempotencyReplay,
    releaseOwnedClaim: releaseOwnedIdempotencyClaim,
  });
  app.decorateRequest('idempotency', null);
  app.addHook('preHandler', idempotencyPreHandler);
  app.addHook('onSend', idempotencyOnSend);
}
