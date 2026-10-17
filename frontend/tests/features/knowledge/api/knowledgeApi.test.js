/**
 * Unit tests for knowledge, search, preview, and changes fetchers.
 */
import { ApiError } from '@/shared/api/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSourceSlice,
  fetchChangeSummary,
  fetchKnowledgeApis,
  fetchProjectSearch,
  fetchKnowledgeFacets,
  fetchKnowledgeHealth,
  fetchKnowledgeSummary,
  fetchKnowledgeSymbols,
  fetchKnowledgeWorkflows,
  fetchSourceFileMetadata,
} from '@/features/knowledge/api/knowledgeApi.js';

const apiRequest = vi.fn();

vi.mock('@/shared/api/index', async () => {
  const actual = await vi.importActual('@/shared/api/index');
  return {
    ...actual,
    apiRequest: (...args) => apiRequest(...args),
  };
});

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
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/knowledge/getIndex/p1', { signal: undefined });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/knowledge/listSymbols/p1?q=re', {
      signal: undefined,
    });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/knowledge/listSymbols/p1', {
      signal: undefined,
    });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/search/run/p1?q=refund&types=doc', {
      signal: undefined,
    });
    await fetchProjectSearch({ projectId: 'p1', q: 'auth' });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/search/run/p1?q=auth', {
      signal: undefined,
    });
  });

  it('calls preview and change-summary paths and maps 404 to null', async () => {
    apiRequest.mockResolvedValue({ path: 'a.js' });
    await fetchSourceFileMetadata({ projectId: 'p1', path: 'src/a.js' });
    await fetchSourceSlice({ projectId: 'p1', path: 'src/a.js', startLine: 1, endLine: 4 });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/sourcePreview/getMetadata/p1?path=src%2Fa.js', {
      signal: undefined,
    });

    apiRequest.mockResolvedValueOnce({ counts: { added: 1 } });
    expect(await fetchChangeSummary('p1')).toEqual({ counts: { added: 1 } });

    apiRequest.mockRejectedValueOnce(new ApiError({ status: 404, code: 'CHANGE_SUMMARY_NOT_FOUND', message: 'none' }));
    expect(await fetchChangeSummary('p1')).toBeNull();

    apiRequest.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' }));
    await expect(fetchChangeSummary('p1')).rejects.toMatchObject({ status: 500 });
  });
});
