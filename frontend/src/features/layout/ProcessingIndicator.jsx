import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn } from '@/shared/lib/utils';
/**
 * Compact header chip linking to the processing center while a job runs.
 *
 * @param props - Job and optional project for the label.
 * @returns Link chip, or null when there is no active job.
 */
export default function ProcessingIndicator({ job, project, }) {
    const { t } = useTranslation();
    if (!job)
        return null;
    return (<Link to="/processing" className={cn('inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100')}>
      <Loader2 className="h-3.5 w-3.5 animate-spin"/>
      <span className="hidden sm:inline">
        {t('header.processingJob', {
            op: job.op,
            project: project?.name || t('header.projectFallback'),
            percent: job.progress,
        })}
      </span>
      <span className="sm:hidden">{job.progress}%</span>
    </Link>);
}
