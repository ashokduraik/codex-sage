/**
 * Records project access once when the detail shell mounts.
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PROJECTS_LIST_QUERY_ROOT,
  projectDetailQueryKey,
  recordProjectAccess,
} from '@/features/projects/api/projectsApi.js';

/**
 * Fire-and-forget access stamp for a project detail visit.
 * @param {string | undefined | null} projectId Project id.
 * @param {{ enabled?: boolean }} [options] When false, skips the touch.
 */
export function useRecordProjectAccess(projectId, options = {}) {
  const queryClient = useQueryClient();
  const id = projectId ? String(projectId) : '';
  const enabled = Boolean(id) && options.enabled !== false;
  const touchedRef = useRef(/** @type {string | null} */ (null));

  const mutation = useMutation({
    mutationFn: (targetId) => recordProjectAccess(targetId),
    onSuccess: (project) => {
      queryClient.setQueryData(projectDetailQueryKey(project.id), (current) => ({
        ...(current && typeof current === 'object' ? current : {}),
        ...project,
      }));
      queryClient.invalidateQueries({ queryKey: PROJECTS_LIST_QUERY_ROOT });
    },
  });

  useEffect(() => {
    if (!enabled || !id) {
      return;
    }
    if (touchedRef.current === id) {
      return;
    }
    touchedRef.current = id;
    mutation.mutate(id);
    // Intentionally run once per projectId mount; mutate identity is stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id]);
}
