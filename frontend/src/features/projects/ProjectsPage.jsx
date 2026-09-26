import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Plus, Search, Archive, GitBranch, UploadCloud, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState, KnowledgeHealthBadge, ProjectLifecycleBadge } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { formatRelative } from '@/shared/lib/format';
import { CreateProjectDialog } from './CreateProjectDialog';
import { flattenProjectPages, useProjects } from './hooks/useProjects.js';
import { correlationFromUnknown, messageFromUnknown, retryAfterFromUnknown } from '@/shared/api';

/**
 * Projects list with server search, archive toggle, and create dialog.
 *
 * @returns Projects page
 */
export default function ProjectsPage() {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  const listQuery = useProjects({
    q: debouncedQuery || undefined,
    includeArchived: showArchived,
    sort: 'updatedAt',
  });
  const projects = flattenProjectPages(listQuery.data).filter((project) => (showArchived ? project.lifecycleStatus === 'archived' : true));
  const isInitialLoading = listQuery.isLoading;
  const errorMessage = listQuery.isError ? messageFromUnknown(listQuery.error, t('projects.listFailed')) : '';
  const correlationId = correlationFromUnknown(listQuery.error);
  const retryAfter = retryAfterFromUnknown(listQuery.error);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-medium text-foreground">{t('projects.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('projects.subtitle')}</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="bg-brand text-brand-foreground hover:bg-brand/90">
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('projects.create')}
          </Button>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('projects.searchPlaceholder')} className="pl-8" />
          </div>
          <Button variant={showArchived ? 'default' : 'outline'} size="sm" onClick={() => setShowArchived((current) => !current)}>
            <Archive className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {showArchived ? t('conversations.archived') : t('conversations.active')}
          </Button>
        </div>

        <div className="mt-5">
          {listQuery.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <p>{errorMessage}</p>
              {typeof retryAfter === 'number' ? (
                <p className="mt-1 text-muted-foreground">{t('projects.retryAfter', { seconds: retryAfter })}</p>
              ) : null}
              {correlationId ? (
                <p className="mt-1 text-xs text-muted-foreground">{t('projects.correlationReference', { reference: correlationId })}</p>
              ) : null}
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void listQuery.refetch()}>
                {t('projects.retry')}
              </Button>
            </div>
          ) : null}

          {isInitialLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label={t('projects.skeletonLabel')}>
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={`skeleton-${index}`} className="h-[168px] animate-pulse rounded-xl border border-border bg-muted/40" />
              ))}
            </div>
          ) : null}

          {!isInitialLoading && !listQuery.isError && projects.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title={showArchived ? t('projects.emptyArchivedTitle') : t('projects.emptyTitle')}
              description={showArchived ? t('projects.emptyArchivedDescription') : t('projects.emptyDescription')}
              action={
                <Button onClick={() => setCreateOpen(true)} className="bg-brand text-brand-foreground hover:bg-brand/90">
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('projects.create')}
                </Button>
              }
            />
          ) : null}

          {!isInitialLoading && projects.length > 0 ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                  <Link
                    key={project.id}
                    to={`/projects/${project.id}`}
                    className="group flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-brand/40 hover:shadow-sm"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-muted text-brand">
                        {project.sourceConfig?.sourceType === 'repository' ? (
                          <GitBranch className="h-5 w-5" aria-hidden="true" />
                        ) : (
                          <UploadCloud className="h-5 w-5" aria-hidden="true" />
                        )}
                      </div>
                      <ProjectLifecycleBadge code={project.lifecycleStatus} />
                    </div>
                    <h3 className="mt-3 font-medium text-foreground group-hover:text-brand">{project.name}</h3>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{project.description || t('projects.noDescription')}</p>
                    <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                      <KnowledgeHealthBadge code={project.knowledgeHealth} />
                      <span className="text-xs text-muted-foreground">{formatRelative(project.updatedAt || project.createdAt)}</span>
                    </div>
                  </Link>
                ))}
              </div>
              {listQuery.hasNextPage ? (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => void listQuery.fetchNextPage()}
                    disabled={listQuery.isFetchingNextPage}
                    aria-busy={listQuery.isFetchingNextPage}
                  >
                    {listQuery.isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                    {t('projects.loadMore')}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
