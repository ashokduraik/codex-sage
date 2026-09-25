/**
 * Deletion-preview query for the delete confirmation dialog.
 */
import { useQuery } from '@tanstack/react-query';
import {
  getProjectDeletionPreview,
  projectDeletionPreviewQueryKey,
} from '@/features/projects/api/projectsApi.js';

/**
 * Loads deletion consequences for a project while the dialog is open.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] Query options.
 * @returns Preview query result.
 */
export function useProjectDeletionPreview(projectId, options = {}) {
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;

  return useQuery({
    queryKey: projectDeletionPreviewQueryKey(id || 'missing'),
    queryFn: ({ signal }) => getProjectDeletionPreview(id, { signal }),
    enabled,
  });
}
