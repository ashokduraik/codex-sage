import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Loader2,
  Circle,
  AlertTriangle,
  XCircle,
  RefreshCw,
  MessageSquare,
  BookOpen,
  LayoutDashboard,
  Activity,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';

import { EmptyState } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { formatDateTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { useAppData } from '@/shared/mock-data';
import type { JobActivity, JobStageState } from '@/shared/types/domain';

const STAGE_ICON: Record<JobStageState, LucideIcon> = {
  done: Check,
  active: Loader2,
  pending: Circle,
};

const STAGE_CLASS: Record<JobStageState, string> = {
  done: 'text-emerald-600',
  active: 'text-blue-600',
  pending: 'text-muted-foreground/40',
};

interface ActivityLogProps {
  log: JobActivity[];
}

/**
 * Collapsible activity log for a processing job.
 *
 * @param props - Activity entries
 * @returns Activity log UI
 */
function ActivityLog({ log }: ActivityLogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? t('processing.hideActivity') : t('processing.showActivity')}
      </button>
      {open && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-background p-2 scrollbar-thin">
          {log.map((entry) => (
            <div key={`${entry.ts}-${entry.message}`} className="flex gap-2 py-0.5 text-xs">
              <span className="text-muted-foreground/60">
                {formatDateTime(entry.ts)}
              </span>
              <span className="text-foreground/80">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Processing center showing in-progress and historical knowledge jobs.
 *
 * @returns Processing center page
 */
export default function ProcessingCenterPage() {
  const { t } = useTranslation();
  const { jobs, getProject, retryJob } = useAppData();
  const active = jobs.filter((job) => job.status === 'in_progress');
  const history = jobs.filter((job) => job.status !== 'in_progress');

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">
          {t('processing.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('processing.subtitle')}
        </p>

        {jobs.length === 0 && (
          <div className="mt-6">
            <EmptyState
              icon={Activity}
              title={t('processing.emptyTitle')}
              description={t('processing.emptyDescription')}
            />
          </div>
        )}

        {active.length > 0 && (
          <div className="mt-5 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-blue-600">
              {t('processing.inProgress')}
            </h2>
            {active.map((job) => {
              const project = getProject(job.projectId);
              return (
                <div
                  key={job.id}
                  className="rounded-xl border border-blue-200 bg-blue-50/40 p-4"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">
                        {job.op} · {project?.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('processing.started', {
                          when: formatDateTime(job.startedAt),
                        })}
                      </div>
                    </div>
                    <span className="text-lg font-semibold text-blue-700">
                      {job.progress}%
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                  <div className="mt-4 space-y-1.5">
                    {job.stages.map((stage) => {
                      const Icon = STAGE_ICON[stage.state];
                      return (
                        <div
                          key={stage.label}
                          className={cn(
                            'flex items-center gap-2 text-sm',
                            STAGE_CLASS[stage.state],
                          )}
                        >
                          <Icon
                            className={cn(
                              'h-4 w-4',
                              stage.state === 'active' && 'animate-spin',
                            )}
                            aria-hidden="true"
                          />
                          {stage.label}
                        </div>
                      );
                    })}
                  </div>
                  <ActivityLog log={job.activity} />
                </div>
              );
            })}
          </div>
        )}

        {history.length > 0 && (
          <div className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('processing.history')}
            </h2>
            <div className="mt-2 space-y-3">
              {history.map((job) => {
                const project = getProject(job.projectId);
                const tone =
                  job.status === 'completed'
                    ? 'border-emerald-200'
                    : job.status === 'partial'
                      ? 'border-amber-200'
                      : 'border-red-200';
                const Icon =
                  job.status === 'completed'
                    ? Check
                    : job.status === 'partial'
                      ? AlertTriangle
                      : XCircle;
                const iconClass =
                  job.status === 'completed'
                    ? 'text-emerald-600'
                    : job.status === 'partial'
                      ? 'text-amber-600'
                      : 'text-red-600';
                return (
                  <div
                    key={job.id}
                    className={cn('rounded-xl border bg-card p-4', tone)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-2">
                        <Icon
                          className={cn('mt-0.5 h-4 w-4', iconClass)}
                          aria-hidden="true"
                        />
                        <div>
                          <div className="text-sm font-medium">
                            {job.op} · {project?.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDateTime(job.startedAt)} →{' '}
                            {formatDateTime(job.completedAt)}
                          </div>
                        </div>
                      </div>
                      {job.status !== 'completed' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => retryJob(job.id)}
                        >
                          <RefreshCw
                            className="mr-1.5 h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          {t('processing.retry')}
                        </Button>
                      )}
                    </div>

                    {job.warnings.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {job.warnings.map((warning) => (
                          <div
                            key={warning}
                            className="flex items-start gap-1.5 text-xs text-amber-700"
                          >
                            <AlertTriangle
                              className="mt-0.5 h-3 w-3 shrink-0"
                              aria-hidden="true"
                            />
                            {warning}
                          </div>
                        ))}
                      </div>
                    )}
                    {job.errors.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {job.errors.map((error) => (
                          <div
                            key={error}
                            className="flex items-start gap-1.5 text-xs text-red-700"
                          >
                            <XCircle
                              className="mt-0.5 h-3 w-3 shrink-0"
                              aria-hidden="true"
                            />
                            {error}
                          </div>
                        ))}
                      </div>
                    )}
                    {job.ref && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t('processing.reference', { ref: job.ref })}
                      </p>
                    )}

                    {job.status === 'completed' && (
                      <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                        <p className="text-sm font-medium text-emerald-800">
                          {t('processing.ready')}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Link to={`/projects/${job.projectId}/chat`}>
                            <Button
                              size="sm"
                              className="bg-brand text-brand-foreground hover:bg-brand/90"
                            >
                              <MessageSquare
                                className="mr-1.5 h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              {t('projects.openChat')}
                            </Button>
                          </Link>
                          <Link to={`/projects/${job.projectId}/knowledge`}>
                            <Button size="sm" variant="outline">
                              <BookOpen
                                className="mr-1.5 h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              {t('knowledge.title')}
                            </Button>
                          </Link>
                          <Link to={`/projects/${job.projectId}`}>
                            <Button size="sm" variant="outline">
                              <LayoutDashboard
                                className="mr-1.5 h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              {t('projects.overview')}
                            </Button>
                          </Link>
                        </div>
                      </div>
                    )}
                    {job.status === 'partial' && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        <span className="font-medium">
                          {t('processing.partialSummary', {
                            count:
                              project?.fileCount?.toLocaleString() || '4,812',
                          })}
                        </span>{' '}
                        {job.warnings.length > 0 && (
                          <span>
                            {t('processing.partialFailed', {
                              count:
                                job.warnings[0]?.match(/(\d+)/)?.[1] || '9',
                            })}
                          </span>
                        )}{' '}
                        {t('processing.partialAvailable')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
