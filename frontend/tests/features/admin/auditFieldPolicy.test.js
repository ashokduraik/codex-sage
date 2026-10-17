import { describe, expect, it } from 'vitest';
import { isSecretShapedAuditContextKey, selectRenderableAuditContext } from '@/features/admin/AdminAudit.jsx';

describe('isSecretShapedAuditContextKey', () => {
  it('rejects password, token, secret, credential, and authorization substrings', () => {
    expect(isSecretShapedAuditContextKey('password')).toBe(true);
    expect(isSecretShapedAuditContextKey('refreshToken')).toBe(true);
    expect(isSecretShapedAuditContextKey('client_secret')).toBe(true);
    expect(isSecretShapedAuditContextKey('dbCredential')).toBe(true);
    expect(isSecretShapedAuditContextKey('Authorization')).toBe(true);
  });

  it('rejects bare key tokens without false-positive on permissionKey', () => {
    expect(isSecretShapedAuditContextKey('key')).toBe(true);
    expect(isSecretShapedAuditContextKey('api_key')).toBe(true);
    expect(isSecretShapedAuditContextKey('permissionKey')).toBe(false);
  });

  it('rejects empty keys as secret-shaped', () => {
    expect(isSecretShapedAuditContextKey('')).toBe(true);
  });
});

describe('selectRenderableAuditContext', () => {
  it('returns only allowlisted scalar keys', () => {
    expect(
      selectRenderableAuditContext({
        previousStatus: 'active',
        nextStatus: 'disabled',
        unknownField: 'x',
        nested: { a: 1 },
      }),
    ).toEqual([
      { key: 'previousStatus', value: 'active' },
      { key: 'nextStatus', value: 'disabled' },
    ]);
  });

  it('never returns secret-shaped keys even when present on the allowlist shape', () => {
    const rows = selectRenderableAuditContext({
      previousStatus: 'active',
      password: 'hunter2',
      token: 'abc',
      secret: 's',
      credential: 'c',
      roleIds: ['r1'],
    });
    const keys = rows.map((row) => row.key);
    expect(keys).toEqual(['previousStatus', 'roleIds']);
    expect(JSON.stringify(rows)).not.toContain('hunter2');
    expect(JSON.stringify(rows)).not.toContain('abc');
  });

  it('drops nested payloads and empty inputs', () => {
    expect(selectRenderableAuditContext(null)).toEqual([]);
    expect(selectRenderableAuditContext('x')).toEqual([]);
    expect(selectRenderableAuditContext([{ a: 1 }])).toEqual([]);
    expect(
      selectRenderableAuditContext({
        roleIds: [{ id: 'r1' }, 'r2'],
        previousStatus: null,
      }),
    ).toEqual([{ key: 'roleIds', value: ['r2'] }]);
  });

  it('keeps permissionKey and contextTruncated when allowlisted', () => {
    expect(
      selectRenderableAuditContext({
        permissionKey: 'audit.view',
        contextTruncated: true,
        route: '/masters/users/list',
        method: 'GET',
      }),
    ).toEqual([
      { key: 'permissionKey', value: 'audit.view' },
      { key: 'contextTruncated', value: true },
      { key: 'route', value: '/masters/users/list' },
      { key: 'method', value: 'GET' },
    ]);
  });

  it('skips empty scalar arrays on allowlisted keys', () => {
    expect(selectRenderableAuditContext({ roleIds: [{ id: 'x' }] })).toEqual([]);
  });
});
