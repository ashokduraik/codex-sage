/**
 * Unit tests for syncSchemaIndexes argument validation (no Mongo required).
 */
import { describe, expect, it, vi } from 'vitest';
import { syncSchemaIndexes } from './index.js';

describe('syncSchemaIndexes', () => {
  it('calls syncIndexes on each model in order', async () => {
    const first = { syncIndexes: vi.fn().mockResolvedValue(undefined) };
    const second = { syncIndexes: vi.fn().mockResolvedValue(undefined) };
    await syncSchemaIndexes([first, second]);
    expect(first.syncIndexes).toHaveBeenCalledOnce();
    expect(second.syncIndexes).toHaveBeenCalledOnce();
  });

  it('rejects a non-array argument', async () => {
    await expect(syncSchemaIndexes(/** @type {any} */ (null))).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('rejects a non-model entry', async () => {
    await expect(syncSchemaIndexes([{}])).rejects.toBeInstanceOf(TypeError);
  });
});
