/**
 * React Query mutation for ZIP source upload with HTTP byte progress.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sourceVersionsQueryKey,
  uploadProjectSource,
} from '@/features/projects/api/sourcesApi.js';
import { projectDetailQueryKey } from '@/features/projects/api/projectsApi.js';

/**
 * Uploads an archive and tracks byte-level HTTP progress.
 * @returns {{
 *   mutateAsync: Function,
 *   isPending: boolean,
 *   error: unknown,
 *   reset: Function,
 *   progress: { loaded: number, total: number },
 *   resetProgress: () => void,
 * }}
 */
export function useUploadSource() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });

  const mutation = useMutation({
    mutationKey: ['projects', 'sources', 'upload'],
    /**
     * @param {{
     *   projectId: string,
     *   file: File,
     *   idempotencyKey: string,
     * }} input Upload inputs.
     */
    mutationFn: (input) =>
      uploadProjectSource({
        ...input,
        onUploadProgress: (next) => {
          setProgress((current) => {
            if (next.loaded < current.loaded && next.total === current.total) {
              return current;
            }
            return next;
          });
        },
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: projectDetailQueryKey(variables.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['projects', variables.projectId, 'jobs'],
      });
      void queryClient.invalidateQueries({
        queryKey: sourceVersionsQueryKey(variables.projectId),
      });
    },
  });

  return {
    ...mutation,
    progress,
    resetProgress() {
      setProgress({ loaded: 0, total: 0 });
    },
  };
}
