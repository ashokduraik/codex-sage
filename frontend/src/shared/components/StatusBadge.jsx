import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
const PROJECT_STYLES = {
    Creating: 'bg-muted text-muted-foreground',
    'Awaiting source': 'bg-amber-100 text-amber-800',
    'Connecting repository': 'bg-blue-100 text-blue-800',
    'Source received': 'bg-blue-100 text-blue-800',
    Processing: 'bg-blue-100 text-blue-800',
    'Knowledge ready': 'bg-emerald-100 text-emerald-800',
    Updating: 'bg-blue-100 text-blue-800',
    Failed: 'bg-red-100 text-red-700',
    'Partially available': 'bg-amber-100 text-amber-800',
    Archived: 'bg-muted text-muted-foreground',
};
const KNOWLEDGE_STYLES = {
    Ready: 'bg-emerald-100 text-emerald-800',
    Updating: 'bg-blue-100 text-blue-800',
    'Needs attention': 'bg-amber-100 text-amber-800',
    Outdated: 'bg-muted text-muted-foreground',
    'Partially available': 'bg-amber-100 text-amber-800',
};
const KNOWLEDGE_DOT = {
    Ready: 'bg-emerald-500',
    Updating: 'bg-blue-500 animate-pulse',
    'Needs attention': 'bg-amber-500',
    Outdated: 'bg-muted-foreground',
    'Partially available': 'bg-amber-500',
};
/**
 * Colored pill for a project lifecycle status.
 * @param props - Badge props.
 * @returns Status badge element.
 */
export function ProjectStatusBadge({ status }) {
    const { t } = useTranslation();
    return (<span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', PROJECT_STYLES[status] || 'bg-muted text-muted-foreground')}>
      {t(`status.${status}`, { defaultValue: status })}
    </span>);
}
/**
 * Colored pill with a status dot for knowledge freshness.
 * @param props - Badge props.
 * @returns Status badge element.
 */
export function KnowledgeStatusBadge({ status }) {
    const { t } = useTranslation();
    return (<span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', KNOWLEDGE_STYLES[status] || 'bg-muted text-muted-foreground')}>
      <span className={cn('h-1.5 w-1.5 rounded-full', KNOWLEDGE_DOT[status] || 'bg-muted-foreground')} aria-hidden="true"/>
      {t(`status.${status}`, { defaultValue: status })}
    </span>);
}
