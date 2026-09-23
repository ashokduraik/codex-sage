/**
 * Source version DTO helpers for the list API.
 */

/**
 * Formats a date as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

/**
 * Maps a SourceVersion document to the list DTO.
 * @param {object} version SourceVersion document or lean object.
 * @returns {object}
 */
export function mapSourceVersionToListDto(version) {
  const counts = version.fileCounts ?? {};
  return {
    id: String(version._id ?? version.id),
    origin: version.origin,
    versionLifecycle: version.versionLifecycle,
    fileCounts: {
      accepted: counts.accepted ?? 0,
      skipped: counts.skipped ?? 0,
      excludedFromGraph: counts.excludedFromGraph ?? 0,
    },
    jobId: version.jobId ? String(version.jobId) : null,
    commitSha: version.commitSha ?? null,
    branch: version.branch ?? null,
    createdBy: version.createdBy ? String(version.createdBy) : null,
    createdAt: toIsoOrNull(version.createdAt),
  };
}
