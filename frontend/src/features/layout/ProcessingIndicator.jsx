import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn } from '@/shared/lib/utils';
import { jobTypeLabelKey, stageLabelKey } from '@/features/projects/processing/jobProgressMap.js';

/**
 * Compact header chip linking to the processing center while a job runs.
 *
 * @param {{
 *   job?: {
 *     id?: string,
 *     jobType?: string,
 *     currentStage?: string | null,
 *     projectId?: string,
 *   } | null,
 *   project?: { id?: string, name?: string } | null,
 * }} props Job and optional project for the label.
 * @returns {import('react').ReactElement | null} Link chip, or null when there is no active job.
 */
export default function ProcessingIndicator({ job, project }) {
  const { t } = useTranslation();
  if (!job) {
    return null;
  }
  const projectId = project?.id || job.projectId;
  const href = projectId ? `/processing?projectId=${encodeURIComponent(projectId)}` : '/processing';
  const stageLabel = job.currentStage
    ? t(stageLabelKey(job.currentStage), { defaultValue: job.currentStage })
    : t(jobTypeLabelKey(job.jobType), { defaultValue: job.jobType || t('nav.processing') });
  const projectName = project?.name || t('header.projectFallback');
  return (
    <Link
      to={href}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100',
      )}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      <span className="hidden sm:inline">{t('header.processingStage', { stageLabel, projectName })}</span>
      <span className="sm:hidden">{stageLabel}</span>
    </Link>
  );
}
