import { useOutletContext, Link } from 'react-router-dom';
import {
  Boxes,
  Workflow,
  Component,
  Plug,
  Database,
  ArrowRight,
  MessageSquare,
  BookOpen,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState, KnowledgeHealthBadge } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { useActiveProjectJob } from '@/features/projects/processing/hooks/useActiveProjectJob.js';
import { jobTypeLabelKey, stageLabelKey } from '@/features/projects/processing/jobProgressMap.js';
import { isProjectAskable } from '@/shared/components/StatusBadge.jsx';

const SECTION_DEFS = [
  { key: 'Workflow', labelKey: 'projects.workflows', icon: Workflow },
  { key: 'Service', labelKey: 'projects.services', icon: Component },
  { key: 'API', labelKey: 'projects.apis', icon: Plug },
  { key: 'Component', labelKey: 'projects.components', icon: Component },
  { key: 'Data', labelKey: 'projects.dataConcepts', icon: Database },
  { key: 'Integration', labelKey: 'projects.integrations', icon: Plug },
];

/**
 * Project overview: API identity block + mocked knowledge-tree sections.
 *
 * @returns Project overview panel
 */
export default function ProjectOverview() {
  const { t } = useTranslation();
  const { project, mockProject } = useOutletContext();
  const tree = mockProject?.knowledgeTree || [];
  const flat = tree.flatMap((node) => node.children || []);
  const byType = flat.reduce((acc, node) => {
    const bucket = acc[node.type] ?? [];
    bucket.push(node);
    acc[node.type] = bucket;
    return acc;
  }, {});
  const fileCount = project.counts?.files ?? mockProject?.fileCount ?? 0;
  const excludedCount = project.counts?.excludedFiles ?? mockProject?.excludedCount ?? 0;
  const askable = isProjectAskable(project);
  const { activeJob } = useActiveProjectJob(project?.id);
  const processingHref = `/processing?projectId=${encodeURIComponent(project.id)}`;
  const processingBanner = activeJob ? (
    <Link
      to={processingHref}
      className="mb-6 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 text-sm text-blue-800 hover:bg-blue-50"
    >
      <span>
        {t('processing.overviewBanner', {
          stageLabel: activeJob.currentStage
            ? t(stageLabelKey(activeJob.currentStage), { defaultValue: activeJob.currentStage })
            : t(jobTypeLabelKey(activeJob.jobType), { defaultValue: activeJob.jobType }),
        })}
      </span>
      <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
    </Link>
  ) : null;

  if (tree.length === 0) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <section className="mb-8 animate-fade-in">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('projects.summary')}
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-foreground/90">
              {project.description || t('projects.noDescription')}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <KnowledgeHealthBadge code={project.knowledgeHealth} />
              <span>·</span>
              <span>{t('projects.filesMapped', { count: fileCount.toLocaleString() })}</span>
              {excludedCount > 0 ? (
                <>
                  <span>·</span>
                  <span className="text-amber-700">
                    {t('projects.excluded', { count: excludedCount })}
                  </span>
                </>
              ) : null}
            </div>
          </section>
          {processingBanner}
          <EmptyState
            icon={BookOpen}
            title={t('projects.knowledgeNotReadyTitle')}
            description={t('projects.knowledgeNotReadyDescription')}
            action={
              <Link to={`/processing?projectId=${encodeURIComponent(project.id)}`}>
                <Button variant="outline">{t('nav.processing')}</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const sections = SECTION_DEFS.filter((section) => (byType[section.key]?.length ?? 0) > 0);
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <section className="animate-fade-in">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('projects.summary')}
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-foreground/90">
            {project.description}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <KnowledgeHealthBadge code={project.knowledgeHealth} />
            <span>·</span>
            <span>{t('projects.filesMapped', { count: fileCount.toLocaleString() })}</span>
            {excludedCount > 0 ? (
              <>
                <span>·</span>
                <span className="text-amber-700">
                  {t('projects.excluded', { count: excludedCount })}
                </span>
              </>
            ) : null}
          </div>
        </section>

        {processingBanner}

        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
            {t('projects.capabilities')}
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {tree.map((capability) => (
              <Link
                key={capability.label}
                to={`/projects/${project.id}/knowledge`}
                className="group rounded-lg border border-border bg-card p-4 hover:border-brand/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground group-hover:text-brand">
                    {capability.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('projects.itemCount', {
                      count: (capability.children || []).length,
                    })}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {capability.summary}
                </p>
              </Link>
            ))}
          </div>
        </section>

        {sections.map((section) => {
          const Icon = section.icon;
          const items = byType[section.key] || [];
          return (
            <section key={section.key} className="mt-8">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(section.labelKey)}
              </h2>
              <ul className="mt-3 space-y-2">
                {items.slice(0, 5).map((item) => (
                  <li
                    key={item.label}
                    className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
                  >
                    <div className="font-medium text-foreground">{item.label}</div>
                    {item.summary ? (
                      <p className="mt-0.5 text-muted-foreground">{item.summary}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {items.length > 5 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  +{items.length - 5} {t('projects.more')}
                </p>
              ) : null}
            </section>
          );
        })}

        <div className="mt-10 flex flex-wrap gap-2">
          {askable ? (
            <Link to={`/projects/${project.id}/chat`}>
              <Button className="bg-brand text-brand-foreground hover:bg-brand/90">
                <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('projects.openChat')}
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          ) : (
            <Button disabled className="bg-brand text-brand-foreground opacity-50">
              <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('projects.openChat')}
            </Button>
          )}
          <Link to={`/projects/${project.id}/knowledge`}>
            <Button variant="outline">
              <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('nav.knowledge')}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
