/**
 * Test fixtures for identity `code` and extra roles that seed no longer creates.
 */
import { createOrganization } from '../src/modules/masters/organizations.js';
import { createRoleInRepo, ensureAdminRole, findRoleByCode } from '../src/modules/masters/roles.js';

/**
 * Derives an uppercase identity code from an org slug.
 * @param {string} slug Org slug.
 * @returns {string}
 */
export function codeFromSlug(slug) {
  return String(slug)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Creates an organization with a unique `code` (from slug when omitted).
 * @param {{
 *   name: string,
 *   slug: string,
 *   code?: string,
 *   config?: object,
 *   createdBy?: import('mongoose').Types.ObjectId | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 * }} input Org fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createTestOrganization(input, options = {}) {
  return createOrganization(
    {
      ...input,
      code: input.code ?? codeFromSlug(input.slug),
    },
    options,
  );
}

/** Extra roles tests still assign; stored permissions only — not a seed map. */
const EXTRA_TEST_ROLES = Object.freeze([
  Object.freeze({
    code: 'PROJECT_ADMIN',
    name: 'Project Admin',
    permissions: Object.freeze([
      'org.view',
      'projects.view',
      'knowledge.view',
      'knowledge.browse',
      'sources.preview',
      'chat.ask',
      'conversations.view',
      'conversations.search',
      'conversations.archive',
      'search.run',
      'notifications.view',
      'sources.upload',
      'projects.create',
      'projects.update',
      'projects.delete',
      'repos.connect',
      'knowledge.trigger',
    ]),
  }),
  Object.freeze({
    code: 'MEMBER',
    name: 'Member',
    permissions: Object.freeze([
      'org.view',
      'projects.view',
      'knowledge.view',
      'knowledge.browse',
      'sources.preview',
      'chat.ask',
      'conversations.view',
      'conversations.search',
      'conversations.archive',
      'search.run',
      'notifications.view',
      'sources.upload',
    ]),
  }),
  Object.freeze({
    code: 'VIEWER',
    name: 'Viewer',
    permissions: Object.freeze([
      'org.view',
      'projects.view',
      'knowledge.view',
      'knowledge.browse',
      'sources.preview',
      'chat.ask',
      'conversations.view',
      'conversations.search',
      'search.run',
      'notifications.view',
    ]),
  }),
]);

/**
 * Ensures ADMIN plus optional extra roles tests still assign (Member / Viewer / Project Admin).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<{
 *   roles: import('mongoose').Document[],
 *   createdCount: number,
 *   admin: import('mongoose').Document | null,
 *   projectAdmin: import('mongoose').Document | null,
 *   member: import('mongoose').Document | null,
 *   viewer: import('mongoose').Document | null,
 * }>}
 */
export async function ensureTestRoles(orgId, options = {}) {
  const { role: admin, created } = await ensureAdminRole(orgId, options);
  /** @type {import('mongoose').Document[]} */
  const extras = [];
  let extraCreated = 0;
  for (const definition of EXTRA_TEST_ROLES) {
    let role = await findRoleByCode(orgId, definition.code, options);
    if (!role) {
      role = await createRoleInRepo(
        orgId,
        {
          code: definition.code,
          name: definition.name,
          permissions: definition.permissions,
          createdBy: null,
          updatedBy: null,
        },
        options,
      );
      extraCreated += 1;
    }
    extras.push(role);
  }
  return {
    roles: [admin, ...extras].filter(Boolean),
    createdCount: (created ? 1 : 0) + extraCreated,
    admin,
    projectAdmin: extras[0] ?? null,
    member: extras[1] ?? null,
    viewer: extras[2] ?? null,
  };
}

let userCodeSequence = 0;

/**
 * Next unique user `code` for a test insert.
 * @returns {string}
 */
export function nextTestUserCode() {
  userCodeSequence += 1;
  return `U${userCodeSequence}`;
}
