/**
 * Unit tests for URI rewrite safety of the integration harness.
 */
import { describe, expect, it } from 'vitest';
import { rewriteMongoUriForTests, TEST_DATABASE_NAME } from './mongoHarness.js';

describe('rewriteMongoUriForTests', () => {
  it('substitutes the database path with codex_sage_test', () => {
    const rewritten = rewriteMongoUriForTests('mongodb://127.0.0.1:27017/codex_sage?replicaSet=rs0');
    const parsed = new URL(rewritten);
    expect(parsed.pathname).toBe(`/${TEST_DATABASE_NAME}`);
    expect(parsed.searchParams.get('replicaSet')).toBe('rs0');
  });

  it('keeps an already-correct test database name', () => {
    const rewritten = rewriteMongoUriForTests('mongodb://127.0.0.1:27017/codex_sage_test?replicaSet=rs0');
    expect(new URL(rewritten).pathname).toBe(`/${TEST_DATABASE_NAME}`);
  });

  it('rejects an empty URI', () => {
    expect(() => rewriteMongoUriForTests('')).toThrow(/MONGODB_URI/);
  });

  it('rejects an unparseable URI', () => {
    expect(() => rewriteMongoUriForTests('not a uri')).toThrow(/valid URL/);
  });
});
