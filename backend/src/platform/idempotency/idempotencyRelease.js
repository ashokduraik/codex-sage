/**
 * Releases an owned in-flight idempotency claim (used after request failures).
 */
import { releaseIdempotencyClaim } from './idempotency.repository.js';

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
