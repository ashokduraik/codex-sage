/**
 * knowledge/repositories.js — merged resource file.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { RepositoryConnection } from '../../models/repositoryConnection.model.js';
import { resolveRepositoryCrypto } from '../../platform/config.js';
import { assertOrgId, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { decryptSecret, encryptSecret } from '../../platform/secretCrypto.js';
import { recordAuditEvent } from '../access/index.js';
import {
  findProjectById,
  mapProjectToDto,
  transitionLifecycle,
  updateProjectSourceConfig,
} from '../masters/index.js';
import { enqueueManualRepositorySync } from './repoSync.js';
import { probeRepository, REPO_BRANCH_LIST_LIMIT } from './repositories.helper.js';
import { countSourceVersions } from './sources.js';
import mongoose from 'mongoose';
import { z } from 'zod';

// --- from repositories/repositories.repository.js ---
/**
 * Tenant-scoped persistence for repository connections and credentials.
 */
/**
 * Lists active connections whose next sync is due.
 * @param {Date} [now] Clock (tests inject).
 * @returns {Promise<object[]>}
 */
export async function listDueConnections(now = new Date()) {
  return RepositoryConnection.find({
    status: ROW_STATUS_ACTIVE,
    nextDueAt: { $lte: now },
    connectionStatus: { $in: ['connected', 'authentication_required', 'unreachable'] },
  })
    .lean()
    .exec();
}

/**
 * Finds the active connection for a project.
 * @param {string | import('mongoose').Types.ObjectId} orgId Tenant id.
 * @param {string | import('mongoose').Types.ObjectId} projectId Project id.
 * @returns {Promise<object | null>}
 */
export async function findActiveConnection(orgId, projectId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(String(projectId))) {
    return null;
  }
  return RepositoryConnection.findOne({
    orgId,
    projectId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Inserts a connection row.
 * @param {object} fields Connection fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function insertConnection(fields, options = {}) {
  assertOrgId(fields.orgId);
  const doc = new RepositoryConnection(fields);
  if (options.session) {
    await doc.save({ session: options.session });
  } else {
    await doc.save();
  }
  return doc;
}

/**
 * Points a connection at a credential and optional probe metadata.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   connectionId: string | import('mongoose').Types.ObjectId,
 *   set: Record<string, unknown>,
 * }} input Update.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<object | null>}
 */
export async function updateConnection(input, options = {}) {
  assertOrgId(input.orgId);
  const query = RepositoryConnection.findOneAndUpdate(
    { _id: input.connectionId, orgId: input.orgId, status: ROW_STATUS_ACTIVE },
    { $set: { ...input.set, updatedAt: new Date() } },
    { returnDocument: 'after', lean: true },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Soft-deletes the active connection. Nested credential is left as-is.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   connectionId: string | import('mongoose').Types.ObjectId,
 * }} input Scope.
 * @returns {Promise<void>}
 */
export async function softDeleteConnection(input) {
  assertOrgId(input.orgId);
  const now = new Date();
  await RepositoryConnection.updateOne(
    {
      _id: input.connectionId,
      orgId: input.orgId,
      projectId: input.projectId,
      status: ROW_STATUS_ACTIVE,
    },
    { $set: { status: ROW_STATUS_DELETED, updatedAt: now } },
  ).exec();
}

// --- from repositories/repositoryCredential.service.js ---
/**
 * Encrypt / decrypt / replace repository credentials. Decrypt only in memory.
 */
/**
 * Encrypts a PAT into the nested credential shape. Never logs plaintext.
 * @param {string} accessToken Raw PAT.
 * @returns {{
 *   ciphertext: string,
 *   iv: string,
 *   authTag: string,
 *   keyId: string,
 *   credentialKind: string,
 *   lastValidatedAt: Date,
 *   revokedAt: null,
 * }}
 */
function buildEncryptedCredential(accessToken) {
  const crypto = resolveRepositoryCrypto();
  const sealed = encryptSecret(accessToken, crypto.encryptionKey, crypto.keyId);
  return {
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    keyId: sealed.keyId,
    credentialKind: 'pat',
    lastValidatedAt: new Date(),
    revokedAt: null,
  };
}

/**
 * Encrypts a PAT and overwrites `connection.credential`.
 * @param {{
 *   orgId: string,
 *   connectionId: string,
 *   accessToken: string,
 *   createdBy: string,
 * }} input Fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<object | null>}
 */
export async function storeEncryptedCredential(input, options = {}) {
  return updateConnection(
    {
      orgId: input.orgId,
      connectionId: input.connectionId,
      set: {
        credential: buildEncryptedCredential(input.accessToken),
        updatedBy: input.createdBy,
      },
    },
    options,
  );
}

/**
 * Decrypts a nested credential. Never logs the plaintext.
 * @param {object | null | undefined} credential Nested credential on a connection.
 * @returns {Promise<string>}
 */
export async function decryptConnectionToken(credential) {
  if (!credential) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  try {
    const crypto = resolveRepositoryCrypto();
    return decryptSecret(
      {
        ciphertext: credential.ciphertext,
        iv: credential.iv,
        authTag: credential.authTag,
      },
      crypto.encryptionKey,
    );
  } catch {
    throw ApiError.fromCode('CREDENTIAL_DECRYPT_FAILED');
  }
}

/**
 * Overwrites the nested credential on an existing connection.
 * @param {{
 *   orgId: string,
 *   connectionId: string,
 *   accessToken: string,
 *   actorUserId: string,
 * }} input Replace fields.
 * @returns {Promise<object | null>}
 */
export async function replaceEncryptedCredential(input) {
  return storeEncryptedCredential({
    orgId: input.orgId,
    connectionId: input.connectionId,
    accessToken: input.accessToken,
    createdBy: input.actorUserId,
  });
}

// --- from repositories/repositoryAttach.service.js ---
/**
 * Attach, branch patch, credential replace/revoke, and re-test orchestration.
 */
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
    lastSyncedCommitSha: connection.lastSyncedCommitSha ?? null,
    lastSyncedAt: connection.lastSyncedAt
      ? new Date(connection.lastSyncedAt).toISOString()
      : null,
    nextDueAt: connection.nextDueAt ? new Date(connection.nextDueAt).toISOString() : null,
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
      nextDueAt: now,
      lastSyncedCommitSha: null,
      lastSyncedAt: null,
      lastSyncJobId: null,
      lastSyncErrorCode: null,
      credential: input.accessToken ? buildEncryptedCredential(input.accessToken) : null,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
      throw ApiError.fromCode('CONFLICT');
    }
    throw err;
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
  const token = connection.credential
    ? await decryptConnectionToken(connection.credential)
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
      lastSyncedCommitSha: null,
      nextDueAt: new Date(),
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
    connectionId: String(connection._id),
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
  await softDeleteConnection({
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
  const token = connection.credential
    ? await decryptConnectionToken(connection.credential)
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

// --- from repositories/repositories.routes.js ---
/**
 * Repository HTTP routes under `/api/v1`.
 */
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

/**
 * Registers repository routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function repositoryRoutes(app) {
  app.post(
    '/projects/:projectId/repositories/probe',
    {
      config: {
        routeAccess: 'authenticated',
      },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      const parsed = probeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      const result = await probeRepository({
        repositoryUrl: parsed.data.repositoryUrl,
        accessToken: parsed.data.accessToken,
      });
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/projects/:projectId/repositories',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      const parsed = attachBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      const result = await attachRepository({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        repositoryUrl: parsed.data.repositoryUrl,
        selectedBranch: parsed.data.selectedBranch,
        accessToken: parsed.data.accessToken,
        correlationId: request.id,
        log: request.log,
      });
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/projects/:projectId/repositories/sync',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      const result = await enqueueManualRepositorySync({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        correlationId: request.id,
        log: request.log,
      });
      return reply.code(202).send(result);
    },
  );

  app.get(
    '/projects/:projectId/repositories/connection',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission(['projects.view', 'repos.connect'], {
        mode: 'any',
      }),
    },
    async (request) => {
      return getRepositoryConnection(
        request.projectScope.orgId,
        request.projectScope.projectId,
      );
    },
  );

  app.patch(
    '/projects/:projectId/repositories/connection/branch',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request) => {
      const parsed = patchBranchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      return patchRepositoryBranch({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        selectedBranch: parsed.data.selectedBranch,
        correlationId: request.id,
        log: request.log,
      });
    },
  );

  app.post(
    '/projects/:projectId/repositories/credentials/replace',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request) => {
      const parsed = replaceCredentialBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: mapRepositoryZodDetails(parsed.error),
        });
      }
      return replaceRepositoryCredential({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        accessToken: parsed.data.accessToken,
        correlationId: request.id,
        log: request.log,
      });
    },
  );

  app.post(
    '/projects/:projectId/repositories/credentials/revoke',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request, reply) => {
      await revokeRepositoryCredential({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        correlationId: request.id,
        log: request.log,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/projects/:projectId/repositories/connection/re-test',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('repos.connect'),
    },
    async (request) => {
      return retestRepositoryConnection({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
      });
    },
  );
}

export { RepositoryConnection };
export const REPOSITORY_MODELS = Object.freeze([RepositoryConnection]);

export {
  probeRepository,
  resolveRepositoryUrl,
  mapAnonymousLookupStatus,
  mapAuthenticatedLookupStatus,
  mapOutboundThrown,
  outboundGet,
  REPO_PROBE_TIMEOUT_MS,
  REPO_BRANCH_LIST_LIMIT,
  REPO_README_MAX_BYTES,
} from './repositories.helper.js';
