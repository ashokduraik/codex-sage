import { Link, useSearchParams } from 'react-router-dom';
import { Activity, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/shared/api';
import { EmptyState } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { useProject } from '@/features/projects/hooks/useProject.js';
import { flattenJobPages, useProjectJobs } from './hooks/useProjectJobs.js';
import { isActiveJobStatus, isHistoryJobStatus } from './jobProgressMap.js';
import ProcessingJobCard from './ProcessingJobCard.jsx';

/**
 * User-facing message from a list load error.
 * @param {unknown} error Caught value.
 * @param {string} fallback Localized fallback.
 * @returns {string}
 */
function messageFromListError(error, fallback) {
  if (error instanceof ApiError && error.message) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/**
 * Correlation id from an API error when present.
 * @param {unknown} error Caught value.
 * @returns {string}
 */
function correlationFromListError(error) {
  if (error instanceof ApiError && error.correlationId) {
    return error.correlationId;
  }
  return '';
}

/**
 * Processing center showing in-progress and historical knowledge jobs.
 *
 * @returns {import('react').ReactElement}
 */
export default function ProcessingCenterPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const projectId = (searchParams.get('projectId') || '').trim();
  const projectQuery = useProject(projectId, { enabled: Boolean(projectId) });
  const jobsQuery = useProjectJobs(projectId, { enabled: Boolean(projectId) });
  const jobs = flattenJobPages(jobsQuery.data);
  const active = jobs.filter((job) => isActiveJobStatus(job.jobStatus));
  const history = jobs.filter((job) => isHistoryJobStatus(job.jobStatus));
  const project = projectQuery.data;

  if (!projectId) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="font-display text-xl font-medium">{t('processing.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('processing.subtitle')}</p>
          <div className="mt-6">
            <EmptyState
              icon={Activity}
              title={t('processing.selectProjectTitle')}
              description={t('processing.selectProjectDescription')}
              action={
                <Link to="/projects">
                  <Button variant="outline">{t('header.allProjects')}</Button>
                </Link>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('processing.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('processing.subtitle')}</p>

        {jobsQuery.isLoading ? (
          <div className="mt-6 space-y-3" aria-busy="true">
            <div className="h-24 animate-pulse rounded-xl border border-border bg-muted/40" />
            <div className="h-24 animate-pulse rounded-xl border border-border bg-muted/40" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : null}

        {jobsQuery.isError ? (
          <div role="alert" className="mt-6 max-w-md text-sm">
            <p>{messageFromListError(jobsQuery.error, t('processing.listFailed'))}</p>
            {correlationFromListError(jobsQuery.error) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('errors.correlationId', { id: correlationFromListError(jobsQuery.error) })}
              </p>
            ) : null}
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => void jobsQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : null}

        {!jobsQuery.isLoading && !jobsQuery.isError && jobs.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              icon={Activity}
              title={t('processing.emptyTitle')}
              description={t('processing.emptyDescription')}
            />
          </div>
        ) : null}

        {active.length > 0 ? (
          <div className="mt-5 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-blue-600">
              {t('processing.inProgress')}
            </h2>
            {active.map((job) => (
              <ProcessingJobCard
                key={job.id}
                job={job}
                project={project}
                variant="active"
              />
            ))}
          </div>
        ) : null}

        {history.length > 0 ? (
          <div className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('processing.history')}
            </h2>
            <div className="mt-2 space-y-3">
              {history.map((job) => (
                <ProcessingJobCard
                  key={job.id}
                  job={job}
                  project={project}
                  variant="history"
                />
              ))}
            </div>
            {jobsQuery.hasNextPage ? (
              <Button
                variant="outline"
                className="mt-3"
                onClick={() => void jobsQuery.fetchNextPage()}
                disabled={jobsQuery.isFetchingNextPage}
              >
                {jobsQuery.isFetchingNextPage ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                {t('processing.loadMore')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
