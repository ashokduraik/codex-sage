/**
 * DTO shapes for source upload and version list.
 */

/**
 * @typedef {{
 *   sourceVersionId: string,
 *   jobId: string,
 * }} SourceUploadResult
 */

/**
 * @typedef {{
 *   id: string,
 *   origin: 'upload' | 'repository' | string,
 *   versionLifecycle: string,
 *   fileCounts: { accepted: number, skipped: number, excludedFromGraph: number },
 *   jobId: string | null,
 *   commitSha: string | null,
 *   branch: string | null,
 *   createdBy: string | null,
 *   createdAt: string | null,
 * }} SourceVersionDto
 */

/**
 * @typedef {{
 *   items: SourceVersionDto[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }} SourceVersionListPage
 */
