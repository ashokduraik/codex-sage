/**
 * Source file metadata + slice query for the preview drawer.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchSourceFileMetadata, fetchSourceSlice, sourcePreviewQueryKey } from '../api/knowledgeApi.js';

/**
 * Loads metadata and a slice when a path is selected.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ path?: string, startLine?: number, endLine?: number } | null} target Preview target.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useSourcePreview(projectId, target) {
  const id = projectId ? String(projectId) : '';
  const path = target?.path ? String(target.path) : '';
  const startLine = Number(target?.startLine) || 1;
  const endLine = Number(target?.endLine) || startLine + 39;
  const enabled = Boolean(id) && Boolean(path);

  return useQuery({
    queryKey: sourcePreviewQueryKey(id || 'missing', path, { startLine, endLine }),
    queryFn: async ({ signal }) => {
      const metadata = await fetchSourceFileMetadata({ projectId: id, path, signal });
      if (metadata.previewAvailable === false) {
        return { metadata, slice: null };
      }
      const slice = await fetchSourceSlice({
        projectId: id,
        path,
        startLine,
        endLine,
        signal,
      });
      return { metadata, slice };
    },
    enabled,
  });
}
