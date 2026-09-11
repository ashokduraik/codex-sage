/**
 * Unit tests for the audit context sanitizer.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CONTEXT_MAX_BYTES,
  AUDIT_CONTEXT_MAX_VALUE_CHARS,
  AUDIT_USER_AGENT_MAX_CHARS,
  sanitizeAuditContext,
  sanitizeUserAgent,
} from './audit.sanitizer.js';

describe('sanitizeAuditContext', () => {
  it('redacts every forbidden key substring and keeps the key', () => {
    const sanitized = sanitizeAuditContext({
      password: 'secret-value',
      resetToken: 'tok',
      apiSecret: 'x',
      dbCredential: 'y',
      Authorization: 'Bearer z',
      apiKey: 'k',
      privateKey: 'pk',
      sessionCookie: 'c',
      passwordHash: 'h',
      reason: 'ok',
    });
    expect(sanitized.password).toBe('[redacted]');
    expect(sanitized.resetToken).toBe('[redacted]');
    expect(sanitized.apiSecret).toBe('[redacted]');
    expect(sanitized.dbCredential).toBe('[redacted]');
    expect(sanitized.Authorization).toBe('[redacted]');
    expect(sanitized.apiKey).toBe('[redacted]');
    expect(sanitized.privateKey).toBe('[redacted]');
    expect(sanitized.sessionCookie).toBe('[redacted]');
    expect(sanitized.passwordHash).toBe('[redacted]');
    expect(sanitized.reason).toBe('ok');
  });

  it('drops nested objects and functions and marks contextTruncated', () => {
    const sanitized = sanitizeAuditContext({
      ok: 1,
      nested: { a: 1 },
      fn: () => 1,
    });
    expect(sanitized.ok).toBe(1);
    expect(sanitized.nested).toBeUndefined();
    expect(sanitized.fn).toBeUndefined();
    expect(sanitized.contextTruncated).toBe(true);
  });

  it('truncates over-long strings and sets contextTruncated', () => {
    const long = 'x'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS + 20);
    const sanitized = sanitizeAuditContext({ path: long });
    expect(sanitized.path).toHaveLength(AUDIT_CONTEXT_MAX_VALUE_CHARS);
    expect(sanitized.contextTruncated).toBe(true);
  });

  it('keeps depth-1 scalar arrays and drops invalid items', () => {
    const sanitized = sanitizeAuditContext({
      ids: ['a', 2, true, { bad: true }],
    });
    expect(sanitized.ids).toEqual(['a', 2, true]);
    expect(sanitized.contextTruncated).toBe(true);
  });

  it('returns undefined for non-object context', () => {
    expect(sanitizeAuditContext(null)).toBeUndefined();
    expect(sanitizeAuditContext(['a'])).toBeUndefined();
    expect(sanitizeAuditContext('x')).toBeUndefined();
  });

  it('skips empty keys and enforces the serialized byte cap', () => {
    const huge = {
      a: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      b: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      c: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      d: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      e: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      f: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      g: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      h: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      i: 'y'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS),
      '': 'ignored-empty-key',
    };
    const sanitized = sanitizeAuditContext(huge);
    expect(sanitized.contextTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(sanitized), 'utf8')).toBeLessThanOrEqual(
      AUDIT_CONTEXT_MAX_BYTES,
    );
  });

  it('truncates long strings inside scalar arrays', () => {
    const long = 'z'.repeat(AUDIT_CONTEXT_MAX_VALUE_CHARS + 5);
    const sanitized = sanitizeAuditContext({ paths: [long, 'ok'] });
    expect(sanitized.paths[0]).toHaveLength(AUDIT_CONTEXT_MAX_VALUE_CHARS);
    expect(sanitized.paths[1]).toBe('ok');
    expect(sanitized.contextTruncated).toBe(true);
  });
});

describe('sanitizeUserAgent', () => {
  it('truncates long user agents', () => {
    const long = 'Mozilla/'.repeat(100);
    const sanitized = sanitizeUserAgent(long);
    expect(sanitized).toHaveLength(AUDIT_USER_AGENT_MAX_CHARS);
  });

  it('returns undefined for empty values', () => {
    expect(sanitizeUserAgent('')).toBeUndefined();
    expect(sanitizeUserAgent(undefined)).toBeUndefined();
  });
});
