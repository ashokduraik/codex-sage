/**
 * Unit tests for the in-process CodeGraph writer mutex.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireWriter,
  buildWriterLockKey,
  isWriterHeld,
  resetWriterLocksForTests,
} from './codegraph.writerLock.js';

describe('codegraph.writerLock', () => {
  afterEach(() => {
    resetWriterLocksForTests();
  });

  it('builds a stable org:project key', () => {
    expect(buildWriterLockKey({ orgId: 'o1', projectId: 'p1' })).toBe('o1:p1');
  });

  it('queues concurrent acquireWriter calls for the same project', async () => {
    const order = [];
    const firstRelease = await acquireWriter({ orgId: 'o', projectId: 'p' });
    order.push('first-acquired');

    let secondAcquired = false;
    const secondPromise = acquireWriter({ orgId: 'o', projectId: 'p' }).then((release) => {
      secondAcquired = true;
      order.push('second-acquired');
      release();
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    firstRelease();
    await secondPromise;
    expect(secondAcquired).toBe(true);
    expect(order).toEqual(['first-acquired', 'second-acquired']);
  });

  it('allows different projects to acquire concurrently', async () => {
    const a = await acquireWriter({ orgId: 'o', projectId: 'a' });
    const b = await acquireWriter({ orgId: 'o', projectId: 'b' });
    a();
    b();
  });

  it('reports isWriterHeld only while the mutex is held', async () => {
    expect(isWriterHeld({ orgId: 'o', projectId: 'p' })).toBe(false);
    const release = await acquireWriter({ orgId: 'o', projectId: 'p' });
    expect(isWriterHeld({ orgId: 'o', projectId: 'p' })).toBe(true);
    release();
    expect(isWriterHeld({ orgId: 'o', projectId: 'p' })).toBe(false);
  });

  it('ignores double release', async () => {
    const release = await acquireWriter({ orgId: 'o', projectId: 'p' });
    release();
    release();
    const next = await acquireWriter({ orgId: 'o', projectId: 'p' });
    next();
  });
});
