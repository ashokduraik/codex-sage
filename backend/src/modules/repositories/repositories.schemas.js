/**
 * Zod request schemas for repository probe and attach routes.
 */
import { z } from 'zod';

export const probeBodySchema = z
  .object({
    repositoryUrl: z.string().trim().min(1).max(2048),
    accessToken: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const attachBodySchema = z
  .object({
    repositoryUrl: z.string().trim().min(1).max(2048),
    selectedBranch: z.string().trim().min(1).max(512),
    accessToken: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const patchBranchBodySchema = z
  .object({
    selectedBranch: z.string().trim().min(1).max(512),
  })
  .strict();

export const replaceCredentialBodySchema = z
  .object({
    accessToken: z.string().min(1).max(4096),
  })
  .strict();

/**
 * Maps zod issues to VALIDATION_ERROR details without echoing secrets.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
export function mapRepositoryZodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (path.includes('accessToken')) {
      details.push({ path: 'accessToken', message: 'invalid' });
      continue;
    }
    details.push({ path, message: issue.message });
  }
  return details;
}
