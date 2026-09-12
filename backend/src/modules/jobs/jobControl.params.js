/**
 * Shared param parsing for job control routes.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';

const jobIdParamsSchema = z.object({
  jobId: z.string().min(1),
});

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
      path: issue.path.join('.') || 'params',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Parses and validates `:jobId` route params.
 * @param {unknown} params Fastify request.params.
 * @returns {{ jobId: string }}
 * @throws {ApiError} VALIDATION_ERROR when invalid.
 */
export function parseJobControlParams(params) {
  const parsed = jobIdParamsSchema.safeParse(params ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  return parsed.data;
}
