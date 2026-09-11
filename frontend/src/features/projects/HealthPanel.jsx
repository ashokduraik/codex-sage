import { useOutletContext, Link } from 'react-router-dom';
import { HeartPulse, AlertTriangle, CheckCircle2, FileWarning, MessageSquare, BookOpen, } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { KnowledgeStatusBadge } from '@/shared/components';
import { Button } from '@/shared/ui/button';
/**
 * Knowledge health checks and status for the current project.
 *
 * @returns Health panel
 */
export default function HealthPanel() {
    const { t } = useTranslation();
    const { project } = useOutletContext();
    const partial = project.partial;
    const ready = project.knowledgeStatus === 'Ready';
    const checks = [
        {
            label: t('health.checkSource'),
            ok: !!project.source,
            detail: project.source?.type === 'repo'
                ? project.source.fullName
                : project.source
                    ? t('sources.upload')
                    : t('health.noSource'),
        },
        {
            label: t('health.checkMap'),
            ok: (project.knowledgeTree?.length || 0) > 0,
            detail: t('projects.filesMapped', {
                count: project.fileCount.toLocaleString(),
            }),
        },
        {
            label: t('health.checkExcluded'),
            ok: project.excludedCount === 0,
            detail: project.excludedCount
                ? t('projects.excluded', { count: project.excludedCount })
                : t('health.allIncluded'),
        },
        {
            label: t('health.checkFresh'),
            ok: project.knowledgeStatus === 'Ready',
            detail: t(`status.${project.knowledgeStatus}`, {
                defaultValue: String(project.knowledgeStatus),
            }),
        },
    ];
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('health.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('health.subtitle')}</p>

        <div className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-card p-4">
          <div className={`flex h-10 w-10 items-center justify-center rounded-full ${ready
            ? 'bg-emerald-100 text-emerald-700'
            : partial
                ? 'bg-amber-100 text-amber-700'
                : 'bg-blue-100 text-blue-700'}`}>
            <HeartPulse className="h-5 w-5" aria-hidden="true"/>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{project.name}</span>
              <KnowledgeStatusBadge status={String(project.knowledgeStatus)}/>
            </div>
            <p className="text-sm text-muted-foreground">
              {ready && t('health.readyDetail')}
              {partial &&
            t('health.partialDetail', { count: project.excludedCount })}
              {project.knowledgeStatus === 'Updating' &&
            t('health.updatingDetail')}
              {project.knowledgeStatus === 'Needs attention' &&
            t('health.needsAttentionDetail')}
            </p>
          </div>
        </div>

        <div className="mt-5 divide-y divide-border rounded-lg border border-border bg-card">
          {checks.map((check) => (<div key={check.label} className="flex items-center gap-3 px-4 py-3">
              {check.ok ? (<CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true"/>) : (<FileWarning className="h-4 w-4 text-amber-600" aria-hidden="true"/>)}
              <div className="flex-1">
                <div className="text-sm font-medium">{check.label}</div>
                <div className="text-xs text-muted-foreground">{check.detail}</div>
              </div>
            </div>))}
        </div>

        {partial && (<div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"/>
            <div>
              <p className="font-medium">{t('health.incompleteWarningTitle')}</p>
              <p className="text-xs">
                {t('health.incompleteWarningBody', {
                count: project.excludedCount,
            })}
              </p>
            </div>
          </div>)}

        <div className="mt-5 flex flex-wrap gap-2">
          <Link to={`/projects/${project.id}/chat`}>
            <Button className="bg-brand text-brand-foreground hover:bg-brand/90">
              <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true"/>
              {t('projects.openChat')}
            </Button>
          </Link>
          <Link to={`/projects/${project.id}/knowledge`}>
            <Button variant="outline">
              <BookOpen className="mr-2 h-4 w-4" aria-hidden="true"/>
              {t('knowledge.title')}
            </Button>
          </Link>
        </div>
      </div>
    </div>);
}
