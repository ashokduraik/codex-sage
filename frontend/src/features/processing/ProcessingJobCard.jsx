/**
 * One processing job: stages, events, retry/cancel, and completion CTAs.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, LayoutDashboard, Loader2, MessageSquare, RefreshCw, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import { formatDateTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { isProjectAskable } from '@/features/projects/projectStatusMap.js';
import { useJob } from './hooks/useJob.js';
import { useJobControl } from './hooks/useJobControl.js';
import {
  hasRenderablePercent,
  isActiveJobStatus,
  jobStatusLabelKey,
  jobTypeLabelKey,
  mapJobStatus,
  mapStageState,
} from './jobProgressMap.js';

/**
 * User-facing message from a job control or load error.
 * @param {unknown} error Caught value.
 * @param {string} fallback Localized fallback.
 * @returns {string}
 */
function messageFromJobError(error, fallback) {
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
function correlationFromJobError(error) {
  if (error instanceof ApiError && error.correlationId) {
    return error.correlationId;
  }
  return '';
}

/**
 * Collapsible activity log from job events.
 * @param {{ events?: object[] }} props Event list.
 * @returns {import('react').ReactElement}
 */
function ActivityLog({ events }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rows = Array.isArray(events) ? events : [];
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? t('processing.hideActivity') : t('processing.showActivity')}
      </button>
      {open ? (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-background p-2 scrollbar-thin">
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('processing.activityEmpty')}</p>
          ) : (
            rows.map((entry) => (
              <div key={`${entry.createdAt}-${entry.eventCode}`} className="flex gap-2 py-0.5 text-xs">
                <span className="text-muted-foreground/60">
                  {entry.createdAt ? formatDateTime(entry.createdAt) : ''}
                </span>
                <span className="text-foreground/80">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Card for one job, loading detail for stages / retry / events.
 * @param {{
 *   job: object,
 *   project: object | null | undefined,
 *   variant: 'active' | 'history',
 * }} props Card props.
 * @returns {import('react').ReactElement}
 */
export default function ProcessingJobCard({ job, project, variant }) {
  const { t } = useTranslation();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailQuery = useJob(job.id);
  const control = useJobControl(job.projectId || project?.id);
  const detail = detailQuery.data;
  const display = detail ?? job;
  const active = isActiveJobStatus(display.jobStatus);
  const statusVisual = mapJobStatus(display.jobStatus);
  const StatusIcon = statusVisual.icon;
  const typeLabel = t(jobTypeLabelKey(display.jobType), { defaultValue: display.jobType });
  const statusLabel = t(jobStatusLabelKey(display.jobStatus), {
    defaultValue: String(display.jobStatus ?? ''),
  });
  const projectName = project?.name || t('header.projectFallback');
  const percent = detail?.percent;
  const showBar = hasRenderablePercent(percent);
  const retry = detail?.retry;
  const cancellation = detail?.cancellation;
  const controlError = control.retryError || control.cancelError;
  const askable = isProjectAskable(project);
  const succeeded =
    display.jobStatus === 'completed' || display.jobStatus === 'completed_with_warnings';
  const tone =
    variant === 'active'
      ? 'border-blue-200 bg-blue-50/40'
      : display.jobStatus === 'completed'
        ? 'border-emerald-200 bg-card'
        : display.jobStatus === 'completed_with_warnings' || display.partialSuccess
          ? 'border-amber-200 bg-card'
          : display.jobStatus === 'failed'
            ? 'border-red-200 bg-card'
            : 'border-border bg-card';

  /**
   * Retries the job; errors stay on the mutation for the alert.
   */
  async function onRetry() {
    try {
      await control.retry(job.id);
    } catch {
      // Surfaced via retryError.
    }
  }

  /**
   * Confirms cancel and closes the dialog.
   */
  async function onConfirmCancel() {
    try {
      await control.cancel(job.id);
    } catch {
      // Surfaced via cancelError.
    } finally {
      setCancelOpen(false);
    }
  }

  return (
    <div className={cn('rounded-xl border p-4', tone)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <StatusIcon
            className={cn('mt-0.5 h-4 w-4', statusVisual.className, statusVisual.spin && 'animate-spin')}
            aria-hidden="true"
          />
          <div>
            <div className="text-sm font-medium">
              {typeLabel} · {projectName}
            </div>
            <div className="text-xs text-muted-foreground">
              {active
                ? t('processing.started', {
                    when: display.startedAt
                      ? formatDateTime(display.startedAt)
                      : formatDateTime(display.createdAt),
                  })
                : t('processing.historyRange', {
                    started: display.startedAt ? formatDateTime(display.startedAt) : '—',
                    completed: display.completedAt ? formatDateTime(display.completedAt) : statusLabel,
                  })}
            </div>
            {display.partialSuccess ? (
              <p className="mt-1 text-xs text-amber-700">{t('processing.partialSuccessFlag')}</p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {showBar ? (
            <span className="text-lg font-semibold text-blue-700">{percent}%</span>
          ) : null}
          {retry?.available ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onRetry()}
              disabled={control.isRetrying}
              aria-busy={control.isRetrying}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('processing.retry')}
            </Button>
          ) : retry && retry.available === false && (display.jobStatus === 'failed' || display.jobStatus === 'cancelled') ? (
            <Button size="sm" variant="outline" disabled title={retry.reason || t('processing.notRetryable')}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('processing.retry')}
            </Button>
          ) : null}
          {active && !cancellation?.requested ? (
            <Button size="sm" variant="outline" onClick={() => setCancelOpen(true)}>
              {t('processing.cancel')}
            </Button>
          ) : null}
        </div>
      </div>

      {cancellation?.requested && display.jobStatus !== 'cancelled' ? (
        <p className="mt-2 text-xs text-amber-800">{t('processing.cancellationRequested')}</p>
      ) : null}

      {showBar ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
      ) : null}

      {detailQuery.isLoading && !detail ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t('common.loading')}
        </div>
      ) : null}

      {detailQuery.isError ? (
        <div role="alert" className="mt-3 text-xs text-red-700">
          <p>{messageFromJobError(detailQuery.error, t('processing.detailFailed'))}</p>
          {correlationFromJobError(detailQuery.error) ? (
            <p className="mt-1 text-muted-foreground">
              {t('errors.correlationId', { id: correlationFromJobError(detailQuery.error) })}
            </p>
          ) : null}
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void detailQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      {Array.isArray(detail?.stages) && detail.stages.length > 0 ? (
        <div className="mt-4 space-y-1.5">
          {detail.stages.map((stage) => {
            const visual = mapStageState(stage.state);
            const Icon = visual.icon;
            return (
              <div
                key={stage.stage || stage.label}
                className={cn('flex items-center gap-2 text-sm', visual.className)}
              >
                <Icon className={cn('h-4 w-4', visual.spin && 'animate-spin')} aria-hidden="true" />
                {stage.label || stage.stage}
              </div>
            );
          })}
        </div>
      ) : null}

      {Array.isArray(detail?.warnings) && detail.warnings.length > 0 ? (
        <div className="mt-3 space-y-1">
          {detail.warnings.map((warning) => (
            <div key={`${warning.code}-${warning.message}`} className="flex items-start gap-1.5 text-xs text-amber-700">
              <span>{warning.message}</span>
              {typeof warning.affectedCount === 'number' && warning.affectedCount > 0 ? (
                <span>({t('processing.affectedCount', { count: warning.affectedCount })})</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {Array.isArray(detail?.errors) && detail.errors.length > 0 ? (
        <div className="mt-3 space-y-1">
          <button
            type="button"
            className="text-xs text-red-700 hover:underline"
            onClick={() => setDetailsOpen((current) => !current)}
          >
            {detailsOpen ? t('processing.hideErrors') : t('processing.showErrors')}
          </button>
          {detailsOpen
            ? detail.errors.map((error) => (
                <div key={`${error.code}-${error.message}`} className="flex items-start gap-1.5 text-xs text-red-700">
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>
                    {error.message}
                    {typeof error.affectedCount === 'number' && error.affectedCount > 0
                      ? ` (${t('processing.affectedCount', { count: error.affectedCount })})`
                      : ''}
                  </span>
                </div>
              ))
            : null}
        </div>
      ) : null}

      {controlError ? (
        <div role="alert" className="mt-3 text-sm text-red-700">
          {messageFromJobError(controlError, t('processing.controlFailed'))}
        </div>
      ) : null}

      {detail ? <ActivityLog events={detail.events} /> : null}

      {succeeded && display.partialSuccess ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <span className="font-medium">
            {t('processing.partialSummary', {
              count: (detail?.itemsProcessed ?? display.progressCounters?.itemsProcessed ?? 0).toLocaleString(),
            })}
          </span>{' '}
          <span>
            {t('processing.partialFailed', {
              count: (detail?.itemsFailed ?? display.progressCounters?.itemsFailed ?? 0).toLocaleString(),
            })}
          </span>{' '}
          {t('processing.partialAvailable')}
        </div>
      ) : null}

      {succeeded && askable && project?.id ? (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-sm font-medium text-emerald-800">{t('processing.ready')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link to={`/projects/${project.id}/chat`}>
              <Button size="sm" className="bg-brand text-brand-foreground hover:bg-brand/90">
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('projects.openChat')}
              </Button>
            </Link>
            <Link to={`/projects/${project.id}/knowledge`}>
              <Button size="sm" variant="outline">
                <BookOpen className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('knowledge.title')}
              </Button>
            </Link>
            <Link to={`/projects/${project.id}`}>
              <Button size="sm" variant="outline">
                <LayoutDashboard className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('projects.overview')}
              </Button>
            </Link>
          </div>
        </div>
      ) : null}

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('processing.cancelConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('processing.cancelConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onConfirmCancel()}
              disabled={control.isCancelling}
            >
              {t('processing.cancelConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
