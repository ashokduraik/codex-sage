import { describe, it, expect } from 'vitest';
import {
  ERROR_CATALOG,
  MONGO_UNAVAILABLE_CODE,
  allowsErrorDetails,
  getCatalogEntry,
  isKnownErrorCode,
} from './errorCatalog.js';

const VALID_CLASSES = new Set([
  'user',
  'authorization',
  'source',
  'repository',
  'processing',
  'knowledge',
  'system',
  'temporary',
]);
const VALID_RETRY = new Set(['temporary', 'permanent', 'user_action_required']);

describe('ERROR_CATALOG', () => {
  it('has unique keys and a complete entry for each code', () => {
    const keys = Object.keys(ERROR_CATALOG);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(VALID_CLASSES.has(entry.class)).toBe(true);
      expect(entry.httpStatus).toBeGreaterThanOrEqual(400);
      expect(entry.httpStatus).toBeLessThanOrEqual(599);
      expect(VALID_RETRY.has(entry.retryability)).toBe(true);
      expect(entry.message.length).toBeGreaterThan(0);
      expect(entry.message.toLowerCase()).not.toContain('password');
      expect(entry.message).not.toMatch(/https?:\/\//i);
      expect(entry.message).not.toMatch(/[/\\][\w.-]+\.\w+/);
    }
  });

  it('registers required temporary knowledge and accounting codes', () => {
    expect(ERROR_CATALOG.KNOWLEDGE_UNAVAILABLE.retryability).toBe('temporary');
    expect(ERROR_CATALOG.CONTEXT_ACCOUNTING_UNAVAILABLE.retryability).toBe('temporary');
    expect(ERROR_CATALOG[MONGO_UNAVAILABLE_CODE].httpStatus).toBe(503);
  });

  it('allows details only for VALIDATION_ERROR and RATE_LIMITED', () => {
    expect(allowsErrorDetails('VALIDATION_ERROR')).toBe(true);
    expect(allowsErrorDetails('RATE_LIMITED')).toBe(true);
    expect(allowsErrorDetails('NOT_FOUND')).toBe(false);
    expect(allowsErrorDetails('UNKNOWN')).toBe(false);
  });
});

describe('getCatalogEntry / isKnownErrorCode', () => {
  it('returns the entry for a known code', () => {
    expect(isKnownErrorCode('NOT_FOUND')).toBe(true);
    expect(getCatalogEntry('NOT_FOUND')).toMatchObject({
      class: 'user',
      httpStatus: 404,
    });
  });

  it('returns undefined for an unknown code', () => {
    expect(isKnownErrorCode('NOPE')).toBe(false);
    expect(getCatalogEntry('NOPE')).toBeUndefined();
  });
});
