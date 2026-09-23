/**
 * Query parsing for GET /projects/:projectId/search.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import {
  SEARCH_PAGE_SIZE,
  SEARCH_QUERY_MIN_LEN,
  SEARCH_TYPES,
} from './search.constants.js';

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
export function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Parses the `types` query token list.
 * @param {unknown} raw Raw query value.
 * @returns {string[]}
 * @throws {ApiError} When a token is unknown.
 */
export function parseSearchTypes(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [...SEARCH_TYPES];
  }
  const tokens = String(raw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'types', message: 'types must include at least one known token' }],
    });
  }
  const unknown = tokens.filter((token) => !SEARCH_TYPES.includes(token));
  if (unknown.length > 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: unknown.map((token) => ({
        path: 'types',
        message: `unknown type token: ${token}`,
      })),
    });
  }
  return [...new Set(tokens)];
}

/**
 * Clamps search page size to SEARCH_PAGE_SIZE.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampSearchLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return SEARCH_PAGE_SIZE;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return SEARCH_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), SEARCH_PAGE_SIZE);
}

const searchQuerySchema = z.object({
  q: z.string().trim().min(SEARCH_QUERY_MIN_LEN),
  types: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});

/**
 * Parses and validates the search query string.
 * @param {unknown} query Fastify query object.
 * @returns {{ q: string, types: string[], cursor?: string, limit: number }}
 * @throws {ApiError}
 */
export function parseSearchQuery(query) {
  const parsed = searchQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  return {
    q: parsed.data.q,
    types: parseSearchTypes(parsed.data.types),
    cursor: parsed.data.cursor,
    limit: clampSearchLimit(parsed.data.limit),
  };
}
