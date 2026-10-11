/**
 * Audit action catalog unit tests.
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_RESOURCE_TYPES, AUDIT_ACTIONS, isKnownAuditAction } from '../../../src/modules/access/audit.js';

describe('audit.actions', () => {
  it('exposes the curated action list', () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'user.create',
        'user.update',
        'user.email_changed',
        'user.activate',
        'user.deactivate',
        'user.remove',
        'user.roles_changed',
        'user.password_changed',
        'user.password_set_by_admin',
        'role.create',
        'role.update',
        'role.remove',
        'membership.update',
        'authz.denied',
        'project.create',
        'project.update',
        'project.settings_changed',
        'project.archive',
        'project.restore',
        'project.delete',
        'project.member_added',
        'project.member_removed',
        'job.retry',
        'job.cancel',
        'source.upload',
        'knowledge.completed',
        'knowledge.failed',
        'repository.connected',
        'repository.branch_changed',
        'repository.credential_replaced',
        'repository.credential_revoked',
        'repository.sync_triggered',
        'conversation.created',
        'conversation.archived',
        'conversation.restored',
        'conversation.deleted',
        'conversation.title_changed',
      ]),
    );
    expect(AUDIT_ACTIONS).toHaveLength(Object.keys(AUDIT_ACTION_RESOURCE_TYPES).length);
  });

  it('recognizes known actions and rejects unknowns', () => {
    expect(isKnownAuditAction('user.password_changed')).toBe(true);
    expect(isKnownAuditAction('user.create')).toBe(true);
    expect(isKnownAuditAction('project.create')).toBe(true);
    expect(isKnownAuditAction('source.upload')).toBe(true);
    expect(isKnownAuditAction('repository.connected')).toBe(true);
    expect(isKnownAuditAction('not.a.real.action')).toBe(false);
  });

  it('pairs each action with a resource type', () => {
    expect(AUDIT_ACTION_RESOURCE_TYPES['user.password_changed']).toBe('user');
    expect(AUDIT_ACTION_RESOURCE_TYPES['role.create']).toBe('role');
    expect(AUDIT_ACTION_RESOURCE_TYPES['membership.update']).toBe('membership');
    expect(AUDIT_ACTION_RESOURCE_TYPES['authz.denied']).toBe('route');
    expect(AUDIT_ACTION_RESOURCE_TYPES['project.create']).toBe('project');
    expect(AUDIT_ACTION_RESOURCE_TYPES['job.retry']).toBe('job');
    expect(AUDIT_ACTION_RESOURCE_TYPES['job.cancel']).toBe('job');
    expect(AUDIT_ACTION_RESOURCE_TYPES['source.upload']).toBe('source');
    expect(AUDIT_ACTION_RESOURCE_TYPES['knowledge.completed']).toBe('knowledge');
    expect(AUDIT_ACTION_RESOURCE_TYPES['knowledge.failed']).toBe('knowledge');
    expect(AUDIT_ACTION_RESOURCE_TYPES['repository.connected']).toBe('repository');
    expect(AUDIT_ACTION_RESOURCE_TYPES['repository.branch_changed']).toBe('repository');
    expect(AUDIT_ACTION_RESOURCE_TYPES['repository.credential_replaced']).toBe('repository');
    expect(AUDIT_ACTION_RESOURCE_TYPES['repository.credential_revoked']).toBe('repository');
    expect(AUDIT_ACTION_RESOURCE_TYPES['repository.sync_triggered']).toBe('repository');
    expect(AUDIT_ACTION_RESOURCE_TYPES['conversation.created']).toBe('conversation');
    expect(AUDIT_ACTION_RESOURCE_TYPES['conversation.title_changed']).toBe('conversation');
  });
});
