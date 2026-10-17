import { afterEach, describe, expect, it } from 'vitest';
import { clearJobHandlersForTests, getJobHandler, listRegisteredJobTypes, registerJobHandler } from '../../src/worker/schedule.js';

describe('handlerRegistry', () => {
  afterEach(() => {
    clearJobHandlersForTests();
  });

  it('registers a handler and lists its type', () => {
    const run = async () => ({ result: 'completed' });
    registerJobHandler({ type: 'worker_smoke_check', exclusiveScope: 'none', run });
    expect(getJobHandler('worker_smoke_check')).toBeDefined();
    expect(listRegisteredJobTypes()).toEqual(['worker_smoke_check']);
    expect(getJobHandler('worker_smoke_check')?.run).toBe(run);
  });

  it('rejects a duplicate type', () => {
    const run = async () => ({ result: 'completed' });
    registerJobHandler({ type: 'project_knowledge_build', exclusiveScope: 'project', run });
    expect(() => registerJobHandler({ type: 'project_knowledge_build', exclusiveScope: 'project', run })).toThrow(/already registered/);
  });

  it('reports an unknown type without throwing', () => {
    expect(getJobHandler('missing')).toBeUndefined();
    expect(listRegisteredJobTypes()).not.toContain('missing');
  });

  it('rejects invalid registrations', () => {
    expect(() => registerJobHandler({ type: '', exclusiveScope: 'none', run: async () => ({}) })).toThrow(/non-empty type/);
    expect(() => registerJobHandler({ type: 'x', exclusiveScope: 'none', run: /** @type {any} */ (null) })).toThrow(/run must be a function/);
    expect(() =>
      registerJobHandler({
        type: 'x',
        exclusiveScope: /** @type {any} */ ('other'),
        run: async () => ({ result: 'completed' }),
      }),
    ).toThrow(/exclusiveScope/);
  });
});
