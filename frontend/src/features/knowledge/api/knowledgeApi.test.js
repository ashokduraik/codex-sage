/**
 * Unit tests for knowledge, search, preview, and changes fetchers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api';

const apiRequest = vi.fn();

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual('@/shared/api');
  return {
    ...actual,
    apiRequest: (...args) => apiRequest(...args),
  };
});

import {
  fetchChangeSummary,
  fetchKnowledgeApis,
  fetchKnowledgeFacets,
  fetchKnowledgeHealth,
  fetchKnowledgeSummary,
  fetchKnowledgeSymbols,
  fetchKnowledgeWorkflows,
  fetchProjectSearch,
  fetchSourceFileMetadata,
  fetchSourceSlice,
} from './knowledgeApi.js';

describe('knowledge HTTP fetchers', () => {
  afterEach(() => {
    apiRequest.mockReset();
  });

  it('calls browse and search paths', async () => {
    apiRequest.mockResolvedValue({});
    await fetchKnowledgeFacets('p1');
    await fetchKnowledgeSummary('p1');
    await fetchKnowledgeWorkflows('p1');
    await fetchKnowledgeApis('p1');
    await fetchKnowledgeSymbols('p1', 're');
    await fetchKnowledgeSymbols('p1', '');
    await fetchKnowledgeHealth('p1');
    await fetchProjectSearch({ projectId: 'p1', q: 'refund', types: 'doc' });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/knowledge', { signal: undefined });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/knowledge/symbols?q=re', {
      signal: undefined,
    });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/knowledge/symbols', {
      signal: undefined,
    });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/search?q=refund&types=doc', {
      signal: undefined,
    });
    await fetchProjectSearch({ projectId: 'p1', q: 'auth' });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/search?q=auth', {
      signal: undefined,
    });
  });

  it('calls preview and change-summary paths and maps 404 to null', async () => {
    apiRequest.mockResolvedValue({ path: 'a.js' });
    await fetchSourceFileMetadata({ projectId: 'p1', path: 'src/a.js' });
    await fetchSourceSlice({ projectId: 'p1', path: 'src/a.js', startLine: 1, endLine: 4 });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/files?path=src%2Fa.js', {
      signal: undefined,
    });

    apiRequest.mockResolvedValueOnce({ counts: { added: 1 } });
    expect(await fetchChangeSummary('p1')).toEqual({ counts: { added: 1 } });

    apiRequest.mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'CHANGE_SUMMARY_NOT_FOUND', message: 'none' }),
    );
    expect(await fetchChangeSummary('p1')).toBeNull();

    apiRequest.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' }));
    await expect(fetchChangeSummary('p1')).rejects.toMatchObject({ status: 500 });
  });
});
