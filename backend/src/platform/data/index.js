/**
 * Public surface for shared data-layer helpers.
 */
import { ApiError } from '../errors.js';

export {
  ROW_STATUS_ACTIVE,
  ROW_STATUS_DELETED,
  ROW_STATUS_VALUES,
  INCLUDE_DELETED_OPTION,
  assertOrgId,
  createBaseSchema,
  includeDeleted,
  softDelete,
} from './baseSchema.js';

/**
 * Encodes a keyset cursor as a URL-safe string.
 * @param {{ t: string, i: string }} payload ISO timestamp `t` and ObjectId hex `i`.
 * @returns {string} Base64url-encoded cursor.
 */
export function encodeCursor(payload) {
  if (
    typeof payload?.t !== 'string' ||
    payload.t.length === 0 ||
    typeof payload?.i !== 'string' ||
    payload.i.length === 0
  ) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  return Buffer.from(JSON.stringify({ t: payload.t, i: payload.i }), 'utf8').toString(
    'base64url',
  );
}

/**
 * Decodes a keyset cursor string.
 * @param {string} cursor Opaque cursor from a previous page.
 * @returns {{ t: string, i: string }} Timestamp and ObjectId hex.
 * @throws {ApiError} INVALID_CURSOR when the payload is malformed.
 */
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.t !== 'string' ||
      parsed.t.length === 0 ||
      typeof parsed?.i !== 'string' ||
      parsed.i.length === 0
    ) {
      throw ApiError.fromCode('INVALID_CURSOR');
    }
    return { t: parsed.t, i: parsed.i };
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    throw ApiError.fromCode('INVALID_CURSOR');
  }
}

/**
 * Syncs declared indexes for each model (create missing, drop obsolete).
 * @param {import('mongoose').Model[]} models Models whose schemas declare indexes.
 * @returns {Promise<void>}
 */
export async function syncSchemaIndexes(models) {
  if (!Array.isArray(models)) {
    throw new TypeError('syncSchemaIndexes expects an array of models');
  }
  for (const model of models) {
    if (!model || typeof model.syncIndexes !== 'function') {
      throw new TypeError('syncSchemaIndexes received a non-model entry');
    }
    await model.syncIndexes();
  }
}
