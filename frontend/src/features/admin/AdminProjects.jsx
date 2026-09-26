import { Link } from 'react-router-dom';
import { FolderKanban, Archive, RotateCcw, GitBranch, UploadCloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProjectStatusBadge, KnowledgeStatusBadge } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { formatRelative } from '@/shared/lib/format';
import { useAppData } from '@/shared/mock-data';
/**
 * Organization-wide project list including archived projects.
 *
 * @returns Admin projects page
 */
export default function AdminProjects() {
  const { t } = useTranslation();
  const { projects, archiveProject } = useAppData();
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <FolderKanban className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.projects')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.projectsSubtitle')}</p>

        <div className="mt-5 divide-y divide-border rounded-lg border border-border bg-card">
          {projects.map((project) => {
            const archived = project.status === 'Archived';
            return (
              <div key={project.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-muted text-brand">
                  {project.source?.type === 'repo' ? (
                    <GitBranch className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <UploadCloud className="h-4 w-4" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <Link to={`/projects/${project.id}`} className="block truncate text-sm font-medium hover:text-brand">
                    {project.name}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {project.createdBy} · {formatRelative(project.createdAt)}
                  </div>
                </div>
                <ProjectStatusBadge status={String(project.status)} />
                <KnowledgeStatusBadge status={String(project.knowledgeStatus)} />
                <Button size="sm" variant="ghost" onClick={() => archiveProject(project.id, !archived)}>
                  {archived ? (
                    <>
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t('projects.restore')}
                    </>
                  ) : (
                    <>
                      <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t('projects.archive')}
                    </>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
