/**
 * Probe and attach DTO shapes (Phase 30 / 31).
 */

/**
 * @typedef {'connected' | 'authentication_required' | 'access_denied' | 'not_found' | 'unreachable'} ProbeStatus
 */

/**
 * @typedef {{
 *   fullName: string,
 *   webUrl?: string | null,
 *   visibility?: string | null,
 *   description?: string | null,
 * }} ProbeRepository
 */

/**
 * @typedef {{
 *   probeStatus: ProbeStatus | string,
 *   provider?: 'github' | 'gitlab' | string,
 *   hostKind?: string,
 *   baseUrl?: string | null,
 *   repository?: ProbeRepository,
 *   defaultBranch?: string,
 *   branches?: string[],
 *   branchesTruncated?: boolean,
 *   tokenUsed?: boolean,
 *   reason?: { code?: string, message?: string },
 * }} RepositoryProbeDto
 */

/**
 * @typedef {{
 *   id: string,
 *   provider: string,
 *   hostKind: string,
 *   baseUrl: string | null,
 *   repository: { fullName: string, webUrl?: string | null, visibility?: string | null },
 *   selectedBranch: string,
 *   defaultBranch: string,
 *   connectionStatus: string,
 *   connectionStatusReasonCode?: string | null,
 *   lastSuccessfulProbeAt?: string | null,
 *   attachedAt?: string | null,
 *   lastSyncedCommitSha?: string | null,
 *   lastSyncedAt?: string | null,
 *   nextDueAt?: string | null,
 * }} RepositoryConnectionDto
 */

/**
 * @typedef {{
 *   connection: RepositoryConnectionDto,
 *   project?: object,
 * }} RepositoryAttachResult
 */
