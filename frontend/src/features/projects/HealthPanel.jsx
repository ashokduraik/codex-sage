import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { Link, useOutletContext } from 'react-router-dom';
import { KnowledgeHealthBadge } from '@/shared/components';
import { useRepositoryConnection } from './hooks/useRepositoryConnection.js';
import { isProjectAskable, mapKnowledgeHealth } from '@/shared/components/StatusBadge.jsx';
import { AlertTriangle, BookOpen, CheckCircle2, FileWarning, HeartPulse, MessageSquare } from 'lucide-react';

/**
 * Knowledge health checks and status for the current project.
 *
 * @returns {import('react').ReactElement}
 */
export default function HealthPanel() {
  const { t } = useTranslation();
  const { project } = useOutletContext();
  const connectionQuery = useRepositoryConnection(project?.id);
  const connection = connectionQuery.data?.connection ?? null;
  const sourceVersions = project?.counts?.sourceVersions ?? 0;
  const excludedCount = project?.counts?.excludedFiles ?? 0;
  const fileCount = project?.counts?.files ?? 0;
  const hasSource = sourceVersions > 0 || Boolean(connection);
  const health = project?.knowledgeHealth;
  const askable = isProjectAskable(project);
  const sourceDetail = connection?.repository?.fullName ? connection.repository.fullName : hasSource ? t('sources.upload') : t('health.noSource');

  const checks = [
    {
      label: t('health.checkSource'),
      ok: hasSource,
      detail: sourceDetail,
    },
    {
      label: t('health.checkMap'),
      ok: health === 'ready' || health === 'partially_available',
      detail: t('projects.filesMapped', { count: fileCount.toLocaleString() }),
    },
    {
      label: t('health.checkExcluded'),
      ok: excludedCount === 0,
      detail: excludedCount > 0 ? t('projects.excluded', { count: excludedCount }) : t('health.allIncluded'),
    },
    {
      label: t('health.checkFresh'),
      ok: health === 'ready',
      detail: t(mapKnowledgeHealth(health).i18nKey),
    },
  ];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('health.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('health.subtitle')}</p>

        <div className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-card p-4">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-full ${
              health === 'ready'
                ? 'bg-emerald-100 text-emerald-700'
                : health === 'partially_available' || health === 'stale'
                  ? 'bg-amber-100 text-amber-700'
                  : health === 'failed'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-blue-100 text-blue-700'
            }`}
          >
            <HeartPulse className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{project.name}</span>
              <KnowledgeHealthBadge code={health} />
            </div>
            <p className="text-sm text-muted-foreground">
              {health === 'ready' ? t('health.readyDetail') : null}
              {health === 'partially_available' ? t('health.partialDetail', { count: excludedCount }) : null}
              {health === 'updating' ? t('health.updatingDetail') : null}
              {health === 'failed' ? t('health.needsAttentionDetail') : null}
            </p>
          </div>
        </div>

        <div className="mt-5 divide-y divide-border rounded-lg border border-border bg-card">
          {checks.map((check) => (
            <div key={check.label} className="flex items-center gap-3 px-4 py-3">
              {check.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              ) : (
                <FileWarning className="h-4 w-4 text-amber-600" aria-hidden="true" />
              )}
              <div className="flex-1">
                <div className="text-sm font-medium">{check.label}</div>
                <div className="text-xs text-muted-foreground">{check.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {excludedCount > 0 ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">{t('health.incompleteWarningTitle')}</p>
              <p className="text-xs">{t('health.incompleteWarningBody', { count: excludedCount })}</p>
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          {askable ? (
            <Link to={`/projects/${project.id}/chat`}>
              <Button className="bg-brand text-brand-foreground hover:bg-brand/90">
                <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('projects.openChat')}
              </Button>
            </Link>
          ) : (
            <Button disabled className="bg-brand text-brand-foreground opacity-50">
              <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('projects.openChat')}
            </Button>
          )}
          <Link to={`/processing?projectId=${encodeURIComponent(project.id)}`}>
            <Button variant="outline">{t('nav.processing')}</Button>
          </Link>
          <Link to={`/projects/${project.id}/knowledge`}>
            <Button variant="outline">
              <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('knowledge.title')}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
