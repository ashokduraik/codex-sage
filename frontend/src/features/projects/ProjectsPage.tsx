import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FolderKanban,
  Plus,
  Search,
  Archive,
  GitBranch,
  UploadCloud,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { EmptyState, KnowledgeStatusBadge, ProjectStatusBadge } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { formatRelative } from '@/shared/lib/format';
import { useAppData } from '@/shared/mock-data';

import { CreateProjectDialog } from './CreateProjectDialog';

/**
 * Projects list with search, archive toggle, and create dialog.
 *
 * @returns Projects page
 */
export default function ProjectsPage() {
  const { t } = useTranslation();
  const { projects } = useAppData();
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const filtered = projects.filter((project) => {
    if (!showArchived && project.status === 'Archived') return false;
    if (showArchived && project.status !== 'Archived') return false;
    if (query && !project.name.toLowerCase().includes(query.toLowerCase())) {
      return false;
    }
    return true;
  });

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-medium text-foreground">
              {t('projects.title')}
            </h1>
            <p className="text-sm text-muted-foreground">{t('projects.subtitle')}</p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('projects.create')}
          </Button>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('projects.searchPlaceholder')}
              className="pl-8"
            />
          </div>
          <Button
            variant={showArchived ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowArchived((current) => !current)}
          >
            <Archive className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {showArchived ? t('conversations.archived') : t('conversations.active')}
          </Button>
        </div>

        <div className="mt-5">
          {filtered.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title={
                showArchived
                  ? t('projects.emptyArchivedTitle')
                  : t('projects.emptyTitle')
              }
              description={
                showArchived
                  ? t('projects.emptyArchivedDescription')
                  : t('projects.emptyDescription')
              }
              action={
                <Button
                  onClick={() => setCreateOpen(true)}
                  className="bg-brand text-brand-foreground hover:bg-brand/90"
                >
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('projects.create')}
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((project) => (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="group flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-brand/40 hover:shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-muted text-brand">
                      {project.source?.type === 'repo' ? (
                        <GitBranch className="h-5 w-5" aria-hidden="true" />
                      ) : (
                        <UploadCloud className="h-5 w-5" aria-hidden="true" />
                      )}
                    </div>
                    <ProjectStatusBadge status={String(project.status)} />
                  </div>
                  <h3 className="mt-3 font-medium text-foreground group-hover:text-brand">
                    {project.name}
                  </h3>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {project.description || t('projects.noDescription')}
                  </p>
                  <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                    <KnowledgeStatusBadge status={String(project.knowledgeStatus)} />
                    <span className="text-xs text-muted-foreground">
                      {formatRelative(project.createdAt)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
