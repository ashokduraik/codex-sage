/**
 * Fastify hooks for Mongo-backed Idempotency-Key on opted-in routes.
 * Helpers never call reply.send for success; IdempotencyReplay is handled by the wrapper.
 */
import { ApiError } from '../errors.js';
import {
  IDEMPOTENCY_BODY_MAX_BYTES,
  IDEMPOTENCY_POLL_INTERVAL_MS,
  IDEMPOTENCY_WAIT_MS,
} from './idempotency.constants.js';
import {
  beginIdempotencyClaim,
  buildIdempotencyRouteLabel,
  completeIdempotencyRecord,
  findActiveIdempotencyRecord,
  releaseIdempotencyClaim,
} from './idempotency.repository.js';
import {
  hashIdempotencyRequestBody,
  measureJsonBodyBytes,
  readIdempotencyKey,
} from './idempotencyKey.js';
import { IdempotencyReplay } from './idempotencyReplay.js';
import { setIdempotencyErrorHooks } from './idempotencyErrorHooks.js';
import { releaseOwnedIdempotencyClaim } from './idempotencyRelease.js';

/**
 * @typedef {object} IdempotencyRequestContext
 * @property {boolean} isOwner
 * @property {string} recordId
 * @property {string} key
 * @property {string} requestHash
 * @property {string} route
 */

/**
 * Sleeps for the given duration.
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
    await sleep(IDEMPOTENCY_POLL_INTERVAL_MS);
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

/**
 * Extracts a resource id from a typical create DTO when present.
 * @param {unknown} body Response body.
 * @returns {string | null}
 */
function extractResourceId(body) {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = /** @type {{ id?: unknown }} */ (body).id;
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }
  return null;
}

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

  await completeIdempotencyRecord({
    orgId: request.principal.orgId,
    recordId: ctx.recordId,
    responseStatus: statusCode,
    responseBody: body,
    resourceId: extractResourceId(body),
    updatedBy: request.principal.userId,
  });
  ctx.isOwner = false;
  return payload;
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
