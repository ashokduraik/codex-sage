/**
 * Every domain ObjectId path must name its Mongoose model via `ref`.
 */
import { describe, expect, it } from 'vitest';
import { AuditEvent } from '../../src/models/audit.model.js';
import { Conversation } from '../../src/models/conversations.model.js';
import { DocumentSection } from '../../src/models/documentSection.model.js';
import { IdempotencyRecord } from '../../src/models/idempotency.model.js';
import { Job } from '../../src/models/job.model.js';
import { KnowledgeVersion } from '../../src/models/knowledgeVersion.model.js';
import { Message } from '../../src/models/messages.model.js';
import { Organization } from '../../src/models/organization.model.js';
import { ProjectJobLock } from '../../src/models/projectJobLock.model.js';
import { Project } from '../../src/models/projects.model.js';
import { RepositoryConnection } from '../../src/models/repositoryConnection.model.js';
import { Role } from '../../src/models/role.model.js';
import { LoginSession } from '../../src/models/loginSession.model.js';
import { SourceChangeSummary } from '../../src/models/sourceChangeSummary.model.js';
import { SourceFile } from '../../src/models/sourceFile.model.js';
import { SourceVersion } from '../../src/models/sourceVersion.model.js';
import { User } from '../../src/models/user.model.js';

/** Paths that store an ObjectId that is not a single Mongoose document. */
const OBJECT_ID_PATHS_WITHOUT_REF = Object.freeze(new Set(['IdempotencyRecord.resourceId', 'SourceFile.gridFsId']));

/**
 * Walks a schema and returns every ObjectId path with its `ref` (if any).
 * @param {import('mongoose').Schema} schema Schema to inspect.
 * @param {string} [prefix] Nested path prefix.
 * @returns {{ path: string, ref: string | undefined }[]}
 */
function listObjectIdPaths(schema, prefix = '') {
  const paths = [];
  for (const [name, schemaType] of Object.entries(schema.paths)) {
    if (name === '_id' || name === 'id' || name === '__v') {
      continue;
    }
    const fullPath = `${prefix}${name}`;
    if (schemaType.instance === 'ObjectID') {
      paths.push({ path: fullPath, ref: schemaType.options?.ref });
    }
    if (schemaType.schema) {
      paths.push(...listObjectIdPaths(schemaType.schema, `${fullPath}.`));
    }
    if (schemaType.caster?.instance === 'ObjectID') {
      paths.push({
        path: fullPath,
        ref: schemaType.caster.options?.ref ?? schemaType.options?.ref,
      });
    }
  }
  return paths;
}

const DOMAIN_MODELS = Object.freeze([
  AuditEvent,
  Conversation,
  DocumentSection,
  IdempotencyRecord,
  Job,
  KnowledgeVersion,
  Message,
  Organization,
  Project,
  ProjectJobLock,
  RepositoryConnection,
  Role,
  LoginSession,
  SourceChangeSummary,
  SourceFile,
  SourceVersion,
  User,
]);

describe('ObjectId refs on domain models', () => {
  it('sets ref to a model name on every domain ObjectId path', () => {
    const missingRefs = [];
    for (const model of DOMAIN_MODELS) {
      for (const field of listObjectIdPaths(model.schema)) {
        const key = `${model.modelName}.${field.path}`;
        if (OBJECT_ID_PATHS_WITHOUT_REF.has(key)) {
          expect(field.ref, `${key} must omit ref`).toBeUndefined();
          continue;
        }
        if (typeof field.ref !== 'string' || field.ref.length === 0) {
          missingRefs.push(key);
        }
      }
    }
    expect(missingRefs).toEqual([]);
  });

  it('points well-known foreign keys at the owning model', () => {
    expect(Job.schema.path('projectId').options.ref).toBe('Project');
    expect(Job.schema.path('sourceVersionId').options.ref).toBe('SourceVersion');
    expect(User.schema.path('roleIds').options.ref).toBe('Role');
    expect(Project.schema.path('sourceConfig').schema.path('repositoryConnectionId').options.ref).toBe('RepositoryConnection');
    expect(Project.schema.path('members').schema.path('userId').options.ref).toBe('User');
    expect(Project.schema.path('members').schema.path('roleId').options.ref).toBe('Role');
    expect(Project.schema.path('members').schema.path('addedByUserId').options.ref).toBe('User');
    expect(User.schema.path('orgId').options.ref).toBe('Organization');
    expect(User.schema.path('createdBy').options.ref).toBe('User');
    expect(Organization.schema.path('orgId')).toBeUndefined();
  });
});
