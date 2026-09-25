/**
 * Project create / patch / archive / restore / delete mutations.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  archiveProject,
  createProject,
  deleteProject,
  patchProject,
  PROJECTS_DETAIL_QUERY_ROOT,
  PROJECTS_LIST_QUERY_ROOT,
  projectDetailQueryKey,
  restoreProject,
} from '@/features/projects/api/projectsApi.js';

/**
 * Invalidates project list caches.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 */
function invalidateProjectLists(queryClient) {
  return queryClient.invalidateQueries({ queryKey: PROJECTS_LIST_QUERY_ROOT });
}

/**
 * Invalidates one project detail cache.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {string} projectId Project id.
 */
function invalidateProjectDetail(queryClient, projectId) {
  return queryClient.invalidateQueries({ queryKey: projectDetailQueryKey(projectId) });
}

/**
 * Create-project mutation.
 * @returns Create mutation.
 */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{
     *   name: string,
     *   description?: string,
     *   sourceType: 'upload' | 'repository',
     *   idempotencyKey: string,
     * }} input Create payload.
     */
    mutationFn: (input) => createProject(input),
    onSuccess: () => invalidateProjectLists(queryClient),
  });
}

/**
 * Patch name/description mutation.
 * @returns Patch mutation.
 */
export function usePatchProject() {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * @param {{ projectId: string, name?: string, description?: string }} input Patch.
     */
    mutationFn: ({ projectId, name, description }) =>
      patchProject(projectId, { name, description }),
    onSuccess: (_data, variables) => {
      invalidateProjectLists(queryClient);
      invalidateProjectDetail(queryClient, variables.projectId);
    },
  });
}

/**
 * Optimistically marks a project archived inside infinite list caches.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {string} projectId Project id.
 * @returns {Array<[unknown, unknown]>} Previous cache entries for rollback.
 */
function optimisticallyArchiveInLists(queryClient, projectId) {
  const previous = queryClient.getQueriesData({ queryKey: PROJECTS_LIST_QUERY_ROOT });
  for (const [key, data] of previous) {
    if (!data?.pages) {
      continue;
    }
    const filters = Array.isArray(key) ? key[2] : null;
    const includeArchived = Boolean(filters?.includeArchived);
    queryClient.setQueryData(key, {
      ...data,
      pages: data.pages.map((page) => {
        const items = Array.isArray(page.items) ? page.items : [];
        if (includeArchived) {
          return {
            ...page,
            items: items.map((project) =>
              String(project.id) === String(projectId)
                ? { ...project, lifecycleStatus: 'archived' }
                : project,
            ),
          };
        }
        return {
          ...page,
          items: items.filter((project) => String(project.id) !== String(projectId)),
        };
      }),
    });
  }
  return previous;
}

/**
 * Restores list caches after a failed optimistic archive.
 * @param {import('@tanstack/react-query').QueryClient} queryClient Query client.
 * @param {Array<[unknown, unknown]>} previous Snapshot.
 */
function restoreListCaches(queryClient, previous) {
  for (const [key, data] of previous) {
    queryClient.setQueryData(key, data);
  }
}

/**
 * Archive mutation with optimistic list update.
 * @returns Archive mutation.
 */
export function useArchiveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    /** @param {string} projectId Project id. */
    mutationFn: (projectId) => archiveProject(projectId),
    onMutate: async (projectId) => {
      await queryClient.cancelQueries({ queryKey: PROJECTS_LIST_QUERY_ROOT });
      const previous = optimisticallyArchiveInLists(queryClient, projectId);
      const previousDetail = queryClient.getQueryData(projectDetailQueryKey(projectId));
      if (previousDetail) {
        queryClient.setQueryData(projectDetailQueryKey(projectId), {
          ...previousDetail,
          lifecycleStatus: 'archived',
        });
      }
      return { previous, previousDetail, projectId };
    },
    onError: (_error, projectId, context) => {
      restoreListCaches(queryClient, context?.previous ?? []);
      if (context?.previousDetail) {
        queryClient.setQueryData(projectDetailQueryKey(projectId), context.previousDetail);
      }
    },
    onSettled: (_data, _error, projectId) => {
      invalidateProjectLists(queryClient);
      invalidateProjectDetail(queryClient, projectId);
    },
  });
}

/**
 * Restore mutation.
 * @returns Restore mutation.
 */
export function useRestoreProject() {
  const queryClient = useQueryClient();
  return useMutation({
    /** @param {string} projectId Project id. */
    mutationFn: (projectId) => restoreProject(projectId),
    onSuccess: (_data, projectId) => {
      invalidateProjectLists(queryClient);
      invalidateProjectDetail(queryClient, projectId);
    },
  });
}

/**
 * Soft-delete mutation.
 * @returns Delete mutation.
 */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    /** @param {string} projectId Project id. */
    mutationFn: (projectId) => deleteProject(projectId),
    onSuccess: (_data, projectId) => {
      invalidateProjectLists(queryClient);
      queryClient.removeQueries({ queryKey: projectDetailQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: PROJECTS_DETAIL_QUERY_ROOT });
    },
  });
}
