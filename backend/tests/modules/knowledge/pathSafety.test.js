/**
 * Unit tests for archive path normalization and zip-slip guards.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import {
  assertSafeArchivePath,
  createDuplicatePathGuard,
  isUnsafeArchivePath,
  normalizeArchivePath,
} from '../../../src/modules/knowledge/uploads.js';

describe('normalizeArchivePath', () => {
  it('converts backslashes and strips leading ./', () => {
    expect(normalizeArchivePath('src\\a.js')).toBe('src/a.js');
    expect(normalizeArchivePath('./src/a.js')).toBe('src/a.js');
  });

  it('returns empty for non-strings and strips trailing slashes', () => {
    expect(normalizeArchivePath(/** @type {never} */ (null))).toBe('');
    expect(normalizeArchivePath('src/dir/')).toBe('src/dir');
  });
});

describe('isUnsafeArchivePath / assertSafeArchivePath', () => {
  it('rejects absolute, drive-letter, and parent-segment paths', () => {
    expect(isUnsafeArchivePath('')).toBe(true);
    expect(isUnsafeArchivePath('/abs/path.js')).toBe(true);
    expect(isUnsafeArchivePath('C:/Windows/x.js')).toBe(true);
    expect(isUnsafeArchivePath('../secret')).toBe(true);
    expect(isUnsafeArchivePath('a/../../b')).toBe(true);
    expect(isUnsafeArchivePath('src/a.js')).toBe(false);
  });

  it('throws SOURCE_ZIP_SLIP for unsafe paths', () => {
    expect(() => assertSafeArchivePath('../x')).toThrow(ApiError);
    try {
      assertSafeArchivePath('/etc/passwd');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(/** @type {ApiError} */ (error).code).toBe('SOURCE_ZIP_SLIP');
    }
  });
});

describe('createDuplicatePathGuard', () => {
  it('throws SOURCE_ZIP_SLIP when the same normalized path is seen twice', () => {
    const guard = createDuplicatePathGuard();
    guard.remember('src/a.js');
    expect(() => guard.remember('src/a.js')).toThrow(ApiError);
    try {
      const again = createDuplicatePathGuard();
      again.remember('src/a.js');
      again.remember('src/a.js');
    } catch (error) {
      expect(/** @type {ApiError} */ (error).code).toBe('SOURCE_ZIP_SLIP');
    }
  });
});
