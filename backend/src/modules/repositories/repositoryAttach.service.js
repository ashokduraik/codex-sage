/**
 * Attach, branch patch, credential replace/revoke, and re-test orchestration.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent } from '../audit/index.js';
import {
  countSourceVersions,
} from '../sources/index.js';
import {
  findProjectById,
  mapProjectToDto,
  transitionLifecycle,
  updateProjectSourceConfig,
} from '../projects/index.js';
import { probeRepository } from './repositoryProbe.service.js';
import { REPO_BRANCH_LIST_LIMIT } from './providers/githubProbe.js';
import {
  findActiveConnection,
  insertConnection,
  softDeleteConnectionAndCredentials,
  updateConnection,
} from './repositories.repository.js';
import {
  decryptConnectionToken,
  replaceEncryptedCredential,
  storeEncryptedCredential,
} from './repositoryCredential.service.js';

const ATTACH_FROM = Object.freeze(['connecting_repository', 'awaiting_source']);

/**
 * Maps a connection document to the public DTO (no secrets).
 * @param {object} connection Lean or mongoose doc.
 * @returns {object}
 */
export function mapConnectionToDto(connection) {
  return {
    id: String(connection._id),
    provider: connection.provider,
    hostKind: connection.hostKind,
    baseUrl: connection.baseUrl ?? null,
    repository: {
      fullName: connection.repositoryFullName,
      webUrl: connection.repositoryWebUrl,
      visibility: connection.visibility ?? null,
    },
    selectedBranch: connection.selectedBranch,
    defaultBranch: connection.defaultBranchAtAttach,
    connectionStatus: connection.connectionStatus,
    connectionStatusReasonCode: connection.connectionStatusReasonCode ?? null,
    lastSuccessfulProbeAt: connection.lastSuccessfulProbeAt
      ? new Date(connection.lastSuccessfulProbeAt).toISOString()
      : null,
    attachedAt: connection.attachedAt
      ? new Date(connection.attachedAt).toISOString()
      : null,
  };
}

/**
 * Attaches a repository after a successful probe.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   repositoryUrl: string,
 *   selectedBranch: string,
 *   accessToken?: string | null,
 *   correlationId?: string | null,
 *   log?: object,
 *   probeRepository?: typeof probeRepository,
 *   findActiveConnection?: typeof findActiveConnection,
 *   insertConnection?: typeof insertConnection,
 * }} input Attach inputs.
 * @returns {Promise<{ connection: object, project: object }>}
 */
export async function attachRepository(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }
  const existing = await (input.findActiveConnection ?? findActiveConnection)(
    input.orgId,
    input.projectId,
  );
  if (existing) {
    throw ApiError.fromCode('CONFLICT');
  }
  if (!ATTACH_FROM.includes(project.lifecycleStatus)) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION');
  }

  const probe = await (input.probeRepository ?? probeRepository)({
    repositoryUrl: input.repositoryUrl,
    accessToken: input.accessToken,
  });
  if (probe.probeStatus !== 'connected') {
    throw ApiError.fromCode('CONNECTION_NOT_VERIFIED');
  }
  assertSelectedBranch(input.selectedBranch, probe);

  const connectionId = new mongoose.Types.ObjectId();
  const now = new Date();
  let connection;
  try {
    connection = await (input.insertConnection ?? insertConnection)({
      _id: connectionId,
      orgId: input.orgId,
      projectId: input.projectId,
      provider: probe.provider,
      hostKind: probe.hostKind,
      baseUrl: probe.baseUrl,
      repositoryFullName: probe.repository.fullName,
      repositoryWebUrl: probe.repository.webUrl ?? input.repositoryUrl,
      visibility: probe.repository.visibility ?? null,
      selectedBranch: input.selectedBranch,
      defaultBranchAtAttach: probe.defaultBranch,
      connectionStatus: 'connected',
      connectionStatusReasonCode: null,
      attachedBy: input.actorUserId,
      attachedAt: now,
      lastSuccessfulProbeAt: now,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
      throw ApiError.fromCode('CONFLICT');
    }
    throw err;
  }

  if (input.accessToken) {
    const stored = await storeEncryptedCredential({
      orgId: input.orgId,
      projectId: input.projectId,
      connectionId: String(connectionId),
      accessToken: input.accessToken,
      createdBy: input.actorUserId,
    });
    await updateConnection({
      orgId: input.orgId,
      connectionId: String(connectionId),
      set: { credentialId: stored.credentialId },
    });
    connection.credentialId = stored.credentialId;
  }

  await updateProjectSourceConfig(input.orgId, input.projectId, {
    repositoryConnectionId: String(connectionId),
    sourceType: 'repository',
    updatedBy: input.actorUserId,
  });

  const updatedProject = await transitionLifecycle({
    orgId: input.orgId,
    projectId: input.projectId,
    from: project.lifecycleStatus,
    to: 'source_received',
    source: 'api',
    actorUserId: input.actorUserId,
    reasonCode: 'repository_attached',
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'repository.connected',
      resourceType: 'repository',
      resourceId: String(connectionId),
      result: 'success',
      correlationId: input.correlationId ?? 'repository',
      context: {
        projectId: input.projectId,
        provider: probe.provider,
        branch: input.selectedBranch,
        repositoryFullName: probe.repository.fullName,
      },
    },
    { log: input.log },
  );

  return {
    connection: mapConnectionToDto(connection),
    project: {
      lifecycleStatus: updatedProject.lifecycleStatus,
      sourceConfig: mapProjectToDto(updatedProject).sourceConfig,
    },
  };
}

/**
 * Returns the active connection DTO or 404.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<{ connection: object }>}
 */
export async function getRepositoryConnection(orgId, projectId) {
  const connection = await findActiveConnection(orgId, projectId);
  if (!connection) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  return { connection: mapConnectionToDto(connection) };
}

/**
 * Updates the selected branch after a live probe.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   selectedBranch: string,
 *   correlationId?: string | null,
 *   log?: object,
 *   probeRepository?: typeof probeRepository,
 *   updateConnection?: typeof updateConnection,
 * }} input Patch inputs.
 * @returns {Promise<{ connection: object }>}
 */
export async function patchRepositoryBranch(input) {
  const connection = await requireActiveConnection(input.orgId, input.projectId);
  const token = connection.credentialId
    ? await decryptConnectionToken({
        orgId: input.orgId,
        projectId: input.projectId,
        credentialId: String(connection.credentialId),
      })
    : null;
  const probe = await (input.probeRepository ?? probeRepository)({
    repositoryUrl: connection.repositoryWebUrl,
    accessToken: token,
  });
  if (probe.probeStatus !== 'connected') {
    await updateConnection({
      orgId: input.orgId,
      connectionId: String(connection._id),
      set: {
        connectionStatus: probe.probeStatus,
        connectionStatusReasonCode: probe.reason?.code ?? null,
        updatedBy: input.actorUserId,
      },
    });
    throw ApiError.fromCode('CONNECTION_NOT_VERIFIED');
  }
  assertSelectedBranch(input.selectedBranch, probe);
  const persistConnection = input.updateConnection ?? updateConnection;
  const updated = await persistConnection({
    orgId: input.orgId,
    connectionId: String(connection._id),
    set: {
      selectedBranch: input.selectedBranch,
      branchChangedAt: new Date(),
      connectionStatus: 'connected',
      connectionStatusReasonCode: null,
      lastSuccessfulProbeAt: new Date(),
      updatedBy: input.actorUserId,
    },
  });
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'repository.branch_changed',
      resourceType: 'repository',
      resourceId: String(connection._id),
      result: 'success',
      correlationId: input.correlationId ?? 'repository',
      context: {
        projectId: input.projectId,
        branch: input.selectedBranch,
      },
    },
    { log: input.log },
  );
  return { connection: mapConnectionToDto(updated) };
}

/**
 * Replaces the stored PAT and optionally re-probes.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   accessToken: string,
 *   correlationId?: string | null,
 *   log?: object,
 *   probeRepository?: typeof probeRepository,
 *   updateConnection?: typeof updateConnection,
 * }} input Replace inputs.
 * @returns {Promise<{ connection: object, connectionStatus: string }>}
 */
export async function replaceRepositoryCredential(input) {
  const connection = await requireActiveConnection(input.orgId, input.projectId);
  const probe = await (input.probeRepository ?? probeRepository)({
    repositoryUrl: connection.repositoryWebUrl,
    accessToken: input.accessToken,
  });
  await replaceEncryptedCredential({
    orgId: input.orgId,
    projectId: input.projectId,
    connectionId: String(connection._id),
    previousCredentialId: connection.credentialId
      ? String(connection.credentialId)
      : null,
    accessToken: input.accessToken,
    actorUserId: input.actorUserId,
  });
  const status = probe.probeStatus === 'connected' ? 'connected' : probe.probeStatus;
  const persistConnection = input.updateConnection ?? updateConnection;
  const updated = await persistConnection({
    orgId: input.orgId,
    connectionId: String(connection._id),
    set: {
      connectionStatus: status,
      connectionStatusReasonCode: probe.reason?.code ?? null,
      lastSuccessfulProbeAt: status === 'connected' ? new Date() : connection.lastSuccessfulProbeAt,
      updatedBy: input.actorUserId,
    },
  });
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'repository.credential_replaced',
      resourceType: 'repository',
      resourceId: String(connection._id),
      result: 'success',
      correlationId: input.correlationId ?? 'repository',
      context: { projectId: input.projectId, connectionStatus: status },
    },
    { log: input.log },
  );
  return {
    connection: mapConnectionToDto(updated),
    connectionStatus: status,
  };
}

/**
 * Soft-detaches the repository and clears the project pointer.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   correlationId?: string | null,
 *   log?: object,
 * }} input Revoke inputs.
 * @returns {Promise<void>}
 */
export async function revokeRepositoryCredential(input) {
  const connection = await requireActiveConnection(input.orgId, input.projectId);
  await softDeleteConnectionAndCredentials({
    orgId: input.orgId,
    projectId: input.projectId,
    connectionId: String(connection._id),
  });
  await updateProjectSourceConfig(input.orgId, input.projectId, {
    repositoryConnectionId: null,
    sourceType: 'repository',
    updatedBy: input.actorUserId,
  });
  const versions = await countSourceVersions(input.orgId, input.projectId);
  const project = await findProjectById(input.orgId, input.projectId);
  if (project?.lifecycleStatus === 'source_received' && versions === 0) {
    await transitionLifecycle({
      orgId: input.orgId,
      projectId: input.projectId,
      from: 'source_received',
      to: 'connecting_repository',
      source: 'api',
      actorUserId: input.actorUserId,
      reasonCode: 'repository_revoked',
    });
  }
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'repository.credential_revoked',
      resourceType: 'repository',
      resourceId: String(connection._id),
      result: 'success',
      correlationId: input.correlationId ?? 'repository',
      context: { projectId: input.projectId },
    },
    { log: input.log },
  );
}

/**
 * Re-tests the stored credential without changing lifecycle.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   probeRepository?: typeof probeRepository,
 * }} input Re-test inputs.
 * @returns {Promise<{ connectionStatus: string, reason?: object }>}
 */
export async function retestRepositoryConnection(input) {
  const connection = await requireActiveConnection(input.orgId, input.projectId);
  const token = connection.credentialId
    ? await decryptConnectionToken({
        orgId: input.orgId,
        projectId: input.projectId,
        credentialId: String(connection.credentialId),
      })
    : null;
  const probe = await (input.probeRepository ?? probeRepository)({
    repositoryUrl: connection.repositoryWebUrl,
    accessToken: token,
  });
  await updateConnection({
    orgId: input.orgId,
    connectionId: String(connection._id),
    set: {
      connectionStatus: probe.probeStatus,
      connectionStatusReasonCode: probe.reason?.code ?? null,
      lastSuccessfulProbeAt:
        probe.probeStatus === 'connected' ? new Date() : connection.lastSuccessfulProbeAt,
      updatedBy: input.actorUserId,
    },
  });
  /** @type {{ connectionStatus: string, reason?: object }} */
  const result = { connectionStatus: probe.probeStatus };
  if (probe.reason) {
    result.reason = probe.reason;
  }
  return result;
}

/**
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<object>}
 */
async function requireActiveConnection(orgId, projectId) {
  const connection = await findActiveConnection(orgId, projectId);
  if (!connection) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  return connection;
}

/**
 * @param {string} selectedBranch Branch name.
 * @param {object} probe Connected probe DTO.
 */
function assertSelectedBranch(selectedBranch, probe) {
  const branches = Array.isArray(probe.branches) ? probe.branches : [];
  if (branches.includes(selectedBranch)) {
    return;
  }
  if (probe.branchesTruncated && selectedBranch === probe.defaultBranch) {
    return;
  }
  if (branches.length >= REPO_BRANCH_LIST_LIMIT && selectedBranch === probe.defaultBranch) {
    return;
  }
  throw ApiError.fromCode('VALIDATION_ERROR', {
    details: [{ path: 'selectedBranch', message: 'Branch is not in the probe result.' }],
  });
}

