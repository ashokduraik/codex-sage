import { afterEach, describe, expect, it } from 'vitest';
import {
  clearJobHandlersForTests,
  getJobHandler,
  isJobTypeRegistered,
  listRegisteredJobTypes,
  registerJobHandler,
} from './handlerRegistry.js';

describe('handlerRegistry', () => {
  afterEach(() => {
    clearJobHandlersForTests();
  });

  it('registers a handler and lists its type', () => {
    const run = async () => ({ result: 'completed' });
    registerJobHandler({ type: 'worker_smoke', exclusiveScope: 'none', run });
    expect(isJobTypeRegistered('worker_smoke')).toBe(true);
    expect(listRegisteredJobTypes()).toEqual(['worker_smoke']);
    expect(getJobHandler('worker_smoke')?.run).toBe(run);
  });

  it('rejects a duplicate type', () => {
    const run = async () => ({ result: 'completed' });
    registerJobHandler({ type: 'ingest', exclusiveScope: 'project', run });
    expect(() =>
      registerJobHandler({ type: 'ingest', exclusiveScope: 'project', run }),
    ).toThrow(/already registered/);
  });

  it('reports an unknown type without throwing', () => {
    expect(isJobTypeRegistered('missing')).toBe(false);
    expect(getJobHandler('missing')).toBeUndefined();
  });

  it('rejects invalid registrations', () => {
    expect(() => registerJobHandler({ type: '', exclusiveScope: 'none', run: async () => ({}) })).toThrow(
      /non-empty type/,
    );
    expect(() =>
      registerJobHandler({ type: 'x', exclusiveScope: 'none', run: /** @type {any} */ (null) }),
    ).toThrow(/run must be a function/);
    expect(() =>
      registerJobHandler({
        type: 'x',
        exclusiveScope: /** @type {any} */ ('other'),
        run: async () => ({ result: 'completed' }),
      }),
    ).toThrow(/exclusiveScope/);
  });
});
